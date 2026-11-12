import {randomUUID} from 'node:crypto';
import type {TestContext} from 'node:test';
import type {Actor,Snapshot} from '../../packages/domain/types';
import type {FindingCreate,FindingDecision,FindingRevision} from '../../packages/findings/types';
import {reportHarness} from './reports';
const {FindingService,findingReference}=await import('../../lib/server/findings/service');
const {FindingSecrets}=await import('../../lib/server/findings/crypto');
const {AgentSecrets}=await import('../../lib/server/agents/security');
const {createPlan,approvePlan,enqueuePlan,reviseEvidence,reviewPlan}=await import('../../lib/server/plans');
const {sessionWorkspaceContext}=await import('../../lib/server/workspaces/authority');
const {buildSnapshot}=await import('../../packages/domain');
const {datasetFor}=await import('../../lib/server/repository');
const {snapshotContext}=await import('../../lib/server/snapshots');
export async function findingHarness(t:TestContext){
  const h=await reportHarness(t),findings=new FindingService(h.db,new FindingSecrets(process.env.GLASSHOUSE_FINDING_KEY!),new AgentSecrets(h.key));
  const previous=globalThis.glasshouseDatabase;globalThis.glasshouseDatabase=Promise.resolve(h.db);t.after(()=>{globalThis.glasshouseDatabase=previous;});
  const input=(change:Partial<FindingCreate>={}):FindingCreate=>({requestId:randomUUID(),snapshotHash:h.snapshot.hash,title:'The carrier delay interpretation',interpretation:'The observed shipping records support a regional delay hypothesis for this exact incident scope.',counterpoint:'Regional correlation does not independently establish the carrier as the cause.',evidenceIds:['evidence-finding-carrier-v1'],counterEvidenceIds:[],reason:'Record the source-bound interpretation for a separate review.',...change});
  const decide=(revision:FindingRevision,action:FindingDecision['action'],change:Partial<FindingDecision>={},actor:Actor=h.scoped)=>findings.decide(actor,revision.findingId,{requestId:randomUUID(),expectedRevisionId:revision.id,expectedHash:revision.hash,action,reason:'A separately attributable review of the exact current source evidence.',...change});
  const share=(revision:FindingRevision)=>findings.share(h.scoped,revision.findingId,{requestId:randomUUID(),revisionId:revision.id,hash:revision.hash});
  const supported=async()=>{const proposed=await findings.create(h.scoped,input()),revision=await decide(proposed,'support');await share(revision);return revision;};
  const prepare=async(revision?:FindingRevision,snapshot?:Snapshot)=>{
    // Legacy finding/report fixtures keep their admitted semantics. A newly
    // prepared financial intent still uses the current source contract.
    const dataset=await datasetFor(h.scoped,h.db),current=snapshot??await h.saveSnapshot(buildSnapshot(dataset,snapshotContext(h.scoped,dataset)));
    return createPlan(h.scoped,'targeted',30000,current.hash,revision?[findingReference(revision)]:[]);
  };
  const joinedActor=async(role:'operator'|'investigator'|'viewer'='viewer')=>{const joined=await h.join(role);const actor=joined.directory.workspaces.find(row=>row.id===h.saved.tenantId);void actor;const saved=(await h.db.query<{actor:Actor}>('SELECT actor FROM gh_sessions WHERE token_hash=$1',[joined.credential.sessionHash]))[0].actor;return {joined,actor:await h.db.transaction(tx=>sessionWorkspaceContext(tx,saved,joined.credential.sessionHash,joined.credential.contextId))};};
  return {...h,findings,input,reportInput:h.input,decide,share,supported,prepare,joinedActor,approve:(id:string,hash:string)=>approvePlan(h.scoped,id,hash),queue:(id:string,hash:string)=>enqueuePlan(h.scoped,id,hash),revise:()=>reviseEvidence(h.scoped),review:(id:string)=>reviewPlan(h.scoped,id)};
}
