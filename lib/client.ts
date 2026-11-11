export async function api<T>(path:string,body?:unknown,method?:string,signal?:AbortSignal):Promise<T>{
  const response=await fetch('/api/'+path,{method:method || (body===undefined?'GET':'POST'),headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error || 'The request could not finish.');
  return result as T;
}
export const money=(minor:number,currency='USD')=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:minor%100===0?0:2}).format(minor/100);
export const dateLabel=(iso:string)=>new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});
export const sourceLabel=(source:string)=>({sample:'Sample',fixture_shipping:'Fixture shipping',fixture_support:'Fixture support',sandbox:'Live · Sandbox',replay:'Replay',modelled:'Modelled'}[source] || source);
