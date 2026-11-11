import OpenAI from 'openai';
import type {Response,ResponseCreateParamsNonStreaming} from 'openai/resources/responses/responses';
import type {AgAiOutputItem,AgLlmResponse} from 'ag-studio';
import {HttpError} from '../errors';

export interface AgentModelProvider {
  readonly mode:'live'|'synthetic';
  create(request:ResponseCreateParamsNonStreaming,beforeSend:()=>Promise<void>,onKnownId?:(id:string,stored:boolean|null)=>Promise<void>):Promise<Response>;
  retrieve(id:string,beforeSend:()=>Promise<void>):Promise<Response>;
}
export class BeforeModelDispatch extends Error{}
export class ModelRejected extends Error {constructor(readonly status:number){super('The model provider rejected this recorded request.');}}
export class ModelUnavailable extends Error {constructor(readonly status:number){super('The exact saved model response is unavailable from the provider.');}}

/** Actual installed OpenAI SDK. No SDK retries: a create has one durable intent. */
export class OpenAIBackgroundProvider implements AgentModelProvider {
  constructor(private readonly key:string,readonly mode:'live'|'synthetic'='live',private readonly transport:typeof fetch=globalThis.fetch){}
  private client(method:'POST'|'GET',id:string|undefined,beforeSend:()=>Promise<void>,onKnownId?:(id:string,stored:boolean|null)=>Promise<void>){
    return new OpenAI({apiKey:this.key,maxRetries:0,timeout:25000,baseURL:'https://api.openai.com/v1',fetch:async(input,init)=>{
      const request=new Request(input,init);const url=new URL(request.url);
      const path=id?`/v1/responses/${encodeURIComponent(id)}`:'/v1/responses';
      if(url.origin!=='https://api.openai.com'||url.pathname!==path||request.method!==method||url.search)throw new BeforeModelDispatch('A model request escaped its exact transport contract.');
      try{await beforeSend();}catch{throw new BeforeModelDispatch('Current run authority changed before the provider request.');}
      const response=await this.transport(request,{redirect:'error'});
      if(response.ok&&onKnownId){
        // Persist a known ID before the SDK's response postprocessor can reject
        // malformed output. This is an exact returned ID, never a guessed lookup.
        const copy=response.clone(),reader=copy.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0;
        if(reader){try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>6000000)throw new Error('Model response exceeds its transport limit.');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {id?:unknown;store?:unknown};
        if(typeof body.id==='string'&&/^resp_[A-Za-z0-9_-]{1,240}$/.test(body.id))await onKnownId(body.id,typeof body.store==='boolean'?body.store:null);
      }
      return response;
    }});
  }
  async create(request:ResponseCreateParamsNonStreaming,beforeSend:()=>Promise<void>,onKnownId?:(id:string,stored:boolean|null)=>Promise<void>){
    try{return await this.client('POST',undefined,beforeSend,onKnownId).responses.create({...request,background:true,store:true,stream:false});}
    catch(error){
      if(error instanceof BeforeModelDispatch||error instanceof Error&&error.cause instanceof BeforeModelDispatch)throw new BeforeModelDispatch('The model request was refused before dispatch.');
      if(error instanceof OpenAI.APIError&&error.status&&error.status>=400&&error.status<500)throw new ModelRejected(error.status);
      throw new Error('The model create outcome is unknown.');
    }
  }
  async retrieve(id:string,beforeSend:()=>Promise<void>){
    if(!/^resp_[A-Za-z0-9_-]{1,240}$/.test(id))throw new HttpError(409,'MODEL_RESPONSE_ID_INVALID','The exact provider response identity could not be verified.');
    try{return await this.client('GET',id,beforeSend).responses.retrieve(id);}
    catch(error){
      if(error instanceof BeforeModelDispatch||error instanceof Error&&error.cause instanceof BeforeModelDispatch)throw new BeforeModelDispatch('The model read was refused before dispatch.');
      if(error instanceof OpenAI.APIError&&error.status&&[404,410].includes(error.status))throw new ModelUnavailable(error.status);
      throw new Error('The exact model response is temporarily unavailable.');
    }
  }
}
export function publicModelResponse(response:Response):AgLlmResponse {
  const output:AgAiOutputItem[]=[];
  for(const item of response.output){
    if(item.type==='message')output.push({id:item.id,kind:'output',type:'message',role:'assistant',status:item.status==='incomplete'?'incomplete':'completed',content:item.content.map(part=>part.type==='output_text'?{type:'text' as const,text:part.text,annotations:[]}:{type:'refusal' as const,refusal:'refusal' in part?part.refusal:''})});
    if(item.type==='function_call')output.push({id:item.id||item.call_id,kind:'output',type:'function_call',callId:item.call_id,name:item.name,arguments:item.arguments,status:'completed'});
    // Continuation stays encrypted on the server. Native consumers get an opaque ID,
    // never reasoning text, encrypted content or a rendered reasoning summary.
    if(item.type==='reasoning')output.push({id:item.id,kind:'output',type:'reasoning',summary:[]});
  }
  return {id:response.id,createdAt:response.created_at*1000,status:response.status??'failed',output,model:response.model,usage:response.usage?{inputTokens:response.usage.input_tokens,outputTokens:response.usage.output_tokens,totalTokens:response.usage.total_tokens}:undefined};
}
