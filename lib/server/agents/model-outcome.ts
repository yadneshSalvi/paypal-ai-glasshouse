import type {Response,ResponseCreateParamsNonStreaming} from 'openai/resources/responses/responses';
import type {ModelOutcome} from '@/packages/agents/contracts';

/** Public terminal facts derived from the original encrypted provider receipt.
 * Never return provider error text, partial output, or private reasoning. */
export function modelOutcome(document:{provider?:Response;request:ResponseCreateParamsNonStreaming}):ModelOutcome|undefined {
  const response=document.provider;
  if(!response||!['incomplete','failed','cancelled'].includes(response.status??''))return;
  const status=response.status as ModelOutcome['status'];
  const reason:ModelOutcome['reason']=status==='cancelled'?'cancelled':status==='failed'?'provider_failure':response.incomplete_details?.reason==='max_output_tokens'?'max_output_tokens':response.incomplete_details?.reason==='content_filter'?'content_filter':'incomplete';
  return {status,reason,outputLimit:document.request.max_output_tokens??null,outputTokens:response.usage?.output_tokens??null};
}
export function modelOutcomeMessage(outcome:ModelOutcome){
  if(outcome.reason==='max_output_tokens')return 'The original model answer reached its saved output limit. Its exact response and completed evidence are preserved. This terminal response cannot resume; no replacement request was sent.';
  if(outcome.reason==='content_filter')return 'The provider stopped the original answer under its content filter. The exact response and earlier evidence are preserved; no replacement request was sent.';
  if(outcome.reason==='cancelled')return 'The provider cancelled the original answer. Its exact response and earlier evidence are preserved; no replacement request was sent.';
  return 'The provider ended the original response without a complete answer. Its exact response and earlier evidence are preserved; no replacement request was sent.';
}
