import {createDataEngine,type AgDataEngine,type AgDataSourcesDefinition} from 'ag-studio';
import type {Snapshot} from '../domain/types';
import {studioData} from './data';
import {snapshotTransactions} from './snapshot-transactions';

const canonical=(value:unknown):string=>value instanceof Date?JSON.stringify(value.toISOString()):Array.isArray(value)?'['+value.map(item=>canonical(item??null)).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
const withoutStamp=(value:unknown):unknown=>Array.isArray(value)?value.map(withoutStamp):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='snapshotHash').map(([key,item])=>[key,withoutStamp(item)])):value;
async function digest(value:unknown){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(withoutStamp(value))));return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');}
export interface PreparedSnapshot {snapshot:Snapshot;engine:AgDataEngine;elapsedMs:number;dispose():void}
/** The displayed native engine is never mutated. A fresh native engine receives one
 * stable-key batch, is read back independently, and is mounted with the exact saved history.
 * A rejected batch is discarded, including failures after partial internal mutation. */
export async function prepareSnapshot(previous:Snapshot,next:Snapshot,makeEngine:(data:AgDataSourcesDefinition)=>AgDataEngine=createDataEngine):Promise<PreparedSnapshot>{
  if(previous.context.tenantId!==next.context.tenantId||previous.context.roleScope!==next.context.roleScope||previous.context.rolePolicyVersion!==next.context.rolePolicyVersion)throw new Error('The workspace authority changed. Reopen the workspace before reconstructing.');
  for(const [table,rows] of Object.entries(next.tables))if(rows.some(row=>row.snapshotHash!==next.hash)||await digest(rows)!==next.tableHashes[table])throw new Error('The received source rows do not match their immutable table and snapshot hashes.');
  const {context,tables,tableHashes,orders,evidence,affectedOrderIds,removedOrderIds,branches,detectors,totals,sourceCoverage}=next;
  if(await digest({context,tables,tableHashes,orders,evidence,affectedOrderIds,removedOrderIds,branches,detectors,totals,sourceCoverage})!==next.hash)throw new Error('The received T/K context and source totals do not match the snapshot hash.');
  const started=performance.now(),nextData=studioData(next);
  const sourceData={...nextData,sources:nextData.sources.map(source=>({...source,data:previous.tables[source.id]??[]}))} as AgDataSourcesDefinition;
  const engine=makeEngine(sourceData),errors:string[]=[];
  const invalid=(event:unknown)=>{if(event&&typeof event==='object'&&'issues' in event&&Array.isArray(event.issues)&&event.issues.length)errors.push('Native validation refused source data.');};
  engine.addEventListener?.('validation',invalid);
  try{
    await engine.init?.();engine.finalize?.();
    if(!engine.applyTransaction)throw new Error('This native engine does not support atomic data transactions.');
    await engine.applyTransaction(snapshotTransactions(previous,next));
    for(const [table,rows] of Object.entries(next.tables)){
      const fields=[...new Set(rows.flatMap(row=>Object.keys(row)))];if(!fields.length)fields.push('id');
      const [result]=await engine.execute({query:{projection:fields.map(field=>({field:{key:field,sourceId:table,fieldId:field},as:field}))},options:{shape:'rows',strict:true},info:{widgetId:'snapshot-admission'}});
      if(result.dataShape!=='rows'||result.metadata?.error||errors.length)throw new Error('The native engine rejected the reconstructed source tables.');
      const actual=new Map(result.rows.map(row=>[String(row.id),row]));
      if(actual.size!==rows.length||rows.some(row=>canonical(Object.fromEntries(fields.map(field=>[field,actual.get(String(row.id))?.[field]??null])))!==canonical(Object.fromEntries(fields.map(field=>[field,row[field]??null])))))throw new Error(`The reconstructed ${table.replaceAll('_',' ')} did not match its immutable source rows.`);
    }
    engine.removeEventListener?.('validation',invalid);
    let disposed=false;return {snapshot:next,engine,elapsedMs:performance.now()-started,dispose(){if(!disposed){disposed=true;engine.dispose?.();}}};
  }catch(error){engine.removeEventListener?.('validation',invalid);engine.dispose?.();throw error;}
}

export {SnapshotAdmission} from './snapshot-admission';
