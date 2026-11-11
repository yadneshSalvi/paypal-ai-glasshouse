import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {workspaceHarness,routeHarness,commandId,failure} from './helpers/workspaces';
import {message,request,tool} from './helpers/agents';
const {tokenHash}=await import('../lib/server/workspaces/crypto');
const {sessionWorkspaceContext,assertWorkspaceContext,workspaceProviderAvailable}=await import('../lib/server/workspaces/authority');
const {currentMember}=await import('../lib/server/payments/records');
const {recoveryMember}=await import('../lib/server/recovery/authority');
const {saveLayout,readLayout}=await import('../lib/server/layouts');
const {actor,assertRequestCurrent,startSession}=await import('../lib/server/auth');
const routes=await import('../app/api/workspaces/[[...path]]/route');
const {createPlan,approvePlan,enqueuePlan,reviseEvidence}=await import('../lib/server/plans');
const {ObservationService}=await import('../lib/server/observations/service');
const {ensureObservationSchema}=await import('../lib/server/observations/schema');
const {ReportingService}=await import('../lib/server/reporting/service');
const {ensureReportingSchema}=await import('../lib/server/reporting/schema');
const {DisputeService}=await import('../lib/server/recovery/dispute-service');
const history=()=>({type:'AgReportHistory',current:{pages:[{id:'incident',widgets:{original:{type:'commerce-river'}}}],selectedPageId:'incident'},undo:[],redo:[]});
const params=(...path:string[])=>({params:Promise.resolve({path})});

test('organization admission and round-trip switching preserve exact original authority, session expiry and saved native history',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);
  await saveLayout(h.db,h.scoped,{history:history(),expectedVersion:0});
  const savedLayout=await readLayout(h.db,h.scoped),original=structuredClone(h.before);
  const second=await h.createWorkspace();
  assert.equal(second.source,'sample');assert.equal(second.role,'owner');assert.equal(await workspaceProviderAvailable(h.db,second.id),false);
  await assert.rejects(currentMember(h.db,second.id,h.bootstrap.identity.personId,1),failure('WORKSPACE_CONNECTOR_REQUIRED'));
  const first=await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});
  await assert.rejects(h.db.transaction(tx=>assertWorkspaceContext(tx,h.scoped)),failure('WORKSPACE_CONTEXT_CHANGED'));
  const returned=await h.service.switchWorkspace({sessionHash:tokenHash(first.token),contextId:first.selection.contextId},{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:first.selection.contextId});
  assert.equal(returned.token,h.token);assert.equal(returned.expiresAt,new Date(original.session.expires_at as Date).toISOString());
  assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]))[0],original.session);
  assert.deepEqual((await h.db.query('SELECT * FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]))[0],original.member);
  const scoped=await h.db.transaction(tx=>sessionWorkspaceContext(tx,h.saved,h.sessionHash,returned.selection.contextId));
  assert.deepEqual(await readLayout(h.db,scoped),savedLayout);
  for(const table of ['gh_seed_runs','gh_provider_resources','gh_payment_commands','gh_payment_consents','gh_operations'])assert.equal((await h.db.query(`SELECT * FROM ${table} WHERE tenant_id=$1`,[second.id])).length,0);
  const privateRows=JSON.stringify(await h.db.query('SELECT * FROM gh_workspace_session_links'))+JSON.stringify(await h.db.query('SELECT * FROM gh_workspace_commands'));
  assert.equal(privateRows.includes(h.token),false);assert.equal(privateRows.includes(first.token),false);
  assert.equal(JSON.stringify(scoped).includes(returned.selection.contextId),false);
});

test('switch response loss is replayable once; stale tabs and superseded commands cannot move the selection backwards',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);const second=await h.createWorkspace();
  const input={requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId};
  const selected=await h.service.switchWorkspace(h.credential,input);
  assert.deepEqual(await h.service.switchWorkspace(h.credential,input),selected);
  await assert.rejects(h.service.switchWorkspace(h.credential,{...input,requestId:commandId()}),failure('WORKSPACE_CONTEXT_CHANGED'));
  await assert.rejects(h.service.switchWorkspace(h.credential,{...input,workspaceId:h.saved.tenantId}),failure('WORKSPACE_COMMAND_CHANGED'));
  const current={sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId};
  const returned=await h.service.switchWorkspace(current,{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:current.contextId});
  await assert.rejects(h.service.switchWorkspace(h.credential,input),failure('WORKSPACE_SWITCH_SUPERSEDED'));
  await assert.rejects(h.service.verifySelection(selected),failure('WORKSPACE_CONTEXT_CHANGED'));
  // A late browser cookie can be repaired only after the directory explicitly
  // supplies the current context, never by replaying the stale selection.
  const reopened=await h.service.directory(current);assert.equal(reopened.identity.contextId,returned.selection.contextId);
  const repaired=await h.service.switchWorkspace({sessionHash:current.sessionHash,contextId:reopened.identity.contextId},{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:reopened.identity.contextId});
  assert.equal(repaired.token,h.token);await h.service.verifySelection(repaired);
});

test('read-only legacy admission cannot claim an organization and still returns to the exact original session',async t=>{
  const h=await workspaceHarness('viewer');t.after(h.dispose);
  assert.equal(h.bootstrap.workspace.organizationId,null);assert.equal(h.bootstrap.workspace.canManage,false);
  const organization=await h.service.createOrganization(h.credential,{requestId:commandId(),name:'Independent Sample organization'});
  const second=await h.createWorkspace('Independent workspace',organization.id);
  const selected=await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});
  const returned=await h.service.switchWorkspace({sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId},{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:selected.selection.contextId});
  assert.equal(returned.token,h.token);assert.equal((await h.db.query('SELECT tenant_id FROM gh_workspaces WHERE tenant_id=$1',[h.saved.tenantId])).length,0);
  const directory=await h.service.directory({sessionHash:h.sessionHash,contextId:returned.selection.contextId});assert.equal(directory.workspaces.find(row=>row.id===h.saved.tenantId)?.role,'viewer');
});

test('server response disclosure and native layout writes are held after a workspace switch or membership change',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);const makeRequest=routeHarness(t,h),r=makeRequest('snapshots');
  const admitted=await actor(r);const second=await h.createWorkspace();
  const selected=await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});
  await assert.rejects(assertRequestCurrent(r),failure('WORKSPACE_CONTEXT_CHANGED'));
  await assert.rejects(saveLayout(h.db,admitted,{history:history(),expectedVersion:0}),failure('WORKSPACE_CONTEXT_CHANGED'));
  assert.equal((await h.db.query('SELECT * FROM gh_layouts')).length,0);
  const returned=await h.service.switchWorkspace({sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId},{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:selected.selection.contextId});
  const fresh=makeRequest('snapshots',{contextId:returned.selection.contextId});await actor(fresh);
  await h.db.query('UPDATE gh_memberships SET version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]);
  await assert.rejects(assertRequestCurrent(fresh),failure('CURRENT_AUTHORITY_REQUIRED'));
  assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]))[0],h.before.session);
});

test('proxy approval checks retain the original requesting member and cannot cross tenants',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);const member=await h.join('operator');
  const person=member.directory.identity.personId;
  const operator={id:person,tenantId:h.saved.tenantId,role:'operator' as const,membershipVersion:1};
  const scoped=await h.db.transaction(tx=>sessionWorkspaceContext(tx,operator,member.credential.sessionHash,member.credential.contextId));
  const owner=await h.db.transaction(tx=>recoveryMember(tx,{...scoped,id:h.saved.id,role:'owner'},true,1));assert.equal(owner.id,h.saved.id);
  await h.service.updateMember(h.credential,h.saved.tenantId,person,{requestId:commandId(),expectedVersion:1,role:'operator',active:false});
  await assert.rejects(h.db.transaction(tx=>recoveryMember(tx,{...scoped,id:h.saved.id,role:'owner'},true,1)),failure('CURRENT_AUTHORITY_REQUIRED'));
  await assert.rejects(currentMember(h.db,'foreign-tenant',h.saved.id,1,h.scoped),failure('CURRENT_AUTHORITY_REQUIRED'));
});

test('native agent work holds while its original session is away and resumes only after returning to that exact session',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);const run=await h.begin(),second=await h.createWorkspace();
  const input={runId:run.run.id,index:0,request:request([tool('read_incident')]),clientId:h.clientId,snapshotHash:h.snapshot.hash};await h.models.submit(h.who,input);
  const selected=await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});
  await assert.rejects(h.models.step(h.who,run.run.id,0,h.clientId),failure('WORKSPACE_CONTEXT_CHANGED'));assert.equal(h.fixture.creates.length,0);
  const returned=await h.service.switchWorkspace({sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId},{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:selected.selection.contextId});
  assert.equal(returned.token,h.token);h.fixture.outputs.push([message('The original native session continues.')]);
  const result=await h.models.step(h.who,run.run.id,0,h.clientId);assert.equal(result.state,'completed');assert.equal(h.fixture.creates.length,1);
  assert.equal((await h.db.query<{dispatch_count:number}>('SELECT dispatch_count FROM gh_agent_model_turns'))[0].dispatch_count,1);
});

test('a switch during an in-flight model response preserves the exact encrypted result and withholds its old-tab disclosure',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);const run=await h.begin(),second=await h.createWorkspace();
  h.fixture.outputs.push([message('Private result for the earlier workspace.')]);
  h.fixture.onCreate=async()=>{await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});};
  await h.models.submit(h.who,{runId:run.run.id,index:0,request:request([tool('read_incident')]),clientId:h.clientId,snapshotHash:h.snapshot.hash});
  await assert.rejects(h.models.step(h.who,run.run.id,0,h.clientId),failure('WORKSPACE_CONTEXT_CHANGED'));
  const row=(await h.db.query<import('../lib/server/agents/journal').TurnRow>('SELECT * FROM gh_agent_model_turns'))[0];
  assert.equal(row.state,'completed');assert.equal(row.dispatch_count,1);assert.equal(row.private_document.includes('Private result'),false);assert.ok(h.journal.turnDocument(row).providerId);
  await h.models.drain();assert.equal(h.fixture.creates.length,1);
});

test('private invitations are single-use, encrypted, version-bound and replay the exact admitted browser access',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);
  const input={requestId:commandId(),role:'investigator' as const,expiresInHours:1};
  const issued=await h.service.createInvitation(h.credential,h.saved.tenantId,input);assert.deepEqual(await h.service.createInvitation(h.credential,h.saved.tenantId,input),issued);
  const preview=await h.service.previewInvitation(issued.token);assert.equal(preview.role,'investigator');assert.match(preview.disclosure,/does not verify/);
  const acceptedInput={requestId:commandId(),token:issued.token,displayName:'Declared name'};
  const accepted=await h.service.acceptInvitation(null,acceptedInput);assert.deepEqual(await h.service.acceptInvitation(null,acceptedInput),accepted);
  await assert.rejects(h.service.acceptInvitation(null,{...acceptedInput,requestId:commandId()}),failure('INVITATION_ALREADY_ACCEPTED'));
  const row=(await h.db.query<{token_hash:string;private_acceptance:string}>('SELECT token_hash,private_acceptance FROM gh_workspace_invitations WHERE id=$1',[issued.invitation.id]))[0];
  assert.equal(row.token_hash,tokenHash(issued.token));assert.equal(row.private_acceptance.includes(accepted.token),false);
  const serialized=JSON.stringify(await h.db.query('SELECT * FROM gh_workspace_invitations'))+JSON.stringify(await h.db.query('SELECT * FROM gh_workspace_commands'));
  assert.equal(serialized.includes(issued.token),false);assert.equal(serialized.includes(accepted.token),false);
  const other=await h.invite('viewer');await h.db.query('UPDATE gh_memberships SET version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]);
  await assert.rejects(h.service.acceptInvitation(null,{requestId:commandId(),token:other.token,displayName:'Later visitor'}),failure('INVITATION_AUTHORITY_CHANGED'));
  assert.equal((await h.db.query('SELECT id FROM gh_people')).length,2);
});

test('expired and revoked links fail before identity creation, and active members never lose roles through a lower-role invitation',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);const expired=await h.invite(),revoked=await h.invite();
  await h.db.query("UPDATE gh_workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.invitation.id]);
  await h.service.revokeInvitation(h.credential,h.saved.tenantId,revoked.invitation.id,{requestId:commandId()});
  for(const token of [expired.token,revoked.token])await assert.rejects(h.service.acceptInvitation(null,{requestId:commandId(),token,displayName:'Unused name'}),failure('INVITATION_UNAVAILABLE'));
  assert.equal((await h.db.query('SELECT id FROM gh_people')).length,1);
  const lower=await h.invite('viewer'),accepted=await h.service.acceptInvitation(h.credential,{requestId:commandId(),token:lower.token,displayName:'Existing owner'});
  assert.equal(accepted.token,h.token);assert.deepEqual((await h.db.query('SELECT * FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]))[0],h.before.member);
});

test('an original judge grant stays immutable and can share only investigator or viewer access',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);
  for(const role of ['owner','operator'] as const)await assert.rejects(h.invite(role),failure('FINANCIAL_ROLE_GRANT_DENIED'));
  await assert.rejects(h.service.updateMember(h.credential,h.saved.tenantId,h.saved.id,{requestId:commandId(),expectedVersion:1,role:'viewer',active:false}),failure('ORIGINAL_GRANT_PRESERVED'));
  const member=await h.join('viewer');
  await assert.rejects(h.service.updateMember(h.credential,h.saved.tenantId,member.directory.identity.personId,{requestId:commandId(),expectedVersion:1,role:'operator',active:true}),failure('FINANCIAL_ROLE_GRANT_DENIED'));
  await h.service.updateMember(h.credential,h.saved.tenantId,member.directory.identity.personId,{requestId:commandId(),expectedVersion:1,role:'investigator',active:true});
  assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]))[0],h.before.session);
  assert.deepEqual((await h.db.query('SELECT * FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]))[0],h.before.member);
});

test('concurrent owner removals serialize and cannot orphan a workspace or an organization',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);const second=await h.join('owner');
  const attempts=await Promise.allSettled([
    h.service.updateMember(h.credential,h.saved.tenantId,h.saved.id,{requestId:commandId(),expectedVersion:1,role:'viewer',active:true}),
    h.service.updateMember(second.credential,h.saved.tenantId,second.directory.identity.personId,{requestId:commandId(),expectedVersion:1,role:'viewer',active:true}),
  ]);
  assert.equal(attempts.filter(value=>value.status==='fulfilled').length,1);const denied=attempts.find(value=>value.status==='rejected');assert.ok(denied?.status==='rejected'&&failure('LAST_WORKSPACE_OWNER')(denied.reason));
  assert.equal((await h.db.query("SELECT actor_id FROM gh_memberships WHERE tenant_id=$1 AND active=true AND role='owner'",[h.saved.tenantId])).length,1);
  await assert.rejects(h.service.updateOrganizationMember(h.credential,h.bootstrap.workspace.organizationId!,h.bootstrap.identity.personId,{requestId:commandId(),expectedVersion:1,role:'member',active:true}),failure('LAST_ORGANIZATION_OWNER'));
});

test('organization revocation removes only that organization’s current workspace memberships and restoration does not revive them',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);const member=await h.join('investigator'),second=await h.createWorkspace();
  const invitation=await h.invite('viewer',second.id);const selected=await h.service.acceptInvitation(member.credential,{requestId:commandId(),token:invitation.token,displayName:'Same invited member'});
  const personId=member.directory.identity.personId,oldMember=(await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[member.credential.sessionHash]))[0];
  await h.service.updateOrganizationMember(h.credential,h.bootstrap.workspace.organizationId!,personId,{requestId:commandId(),expectedVersion:1,role:'member',active:false});
  const memberships=await h.db.query<{active:boolean;version:number}>('SELECT active,version FROM gh_memberships WHERE actor_id=$1',[personId]);assert.equal(memberships.length,2);assert.ok(memberships.every(row=>!row.active&&row.version===2));
  await assert.rejects(h.service.verifySelection(selected),failure('WORKSPACE_MEMBERSHIP_REQUIRED'));
  await h.service.updateOrganizationMember(h.credential,h.bootstrap.workspace.organizationId!,personId,{requestId:commandId(),expectedVersion:2,role:'member',active:true});
  assert.equal((await h.db.query('SELECT actor_id FROM gh_memberships WHERE actor_id=$1 AND active=true',[personId])).length,0);
  assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[member.credential.sessionHash]))[0],oldMember);
  const outsider=await h.service.directory({sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId});assert.equal(outsider.workspaces.length,0);
});

test('archiving holds active native work, preserves readable history and refuses new writes until restoration',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);await saveLayout(h.db,h.scoped,{history:history(),expectedVersion:0});
  const update=(status:'active'|'archived',expectedVersion:number)=>h.service.updateWorkspace(h.credential,h.saved.tenantId,{requestId:commandId(),expectedVersion,name:'Archived incident room',merchantName:'Fernwood Coffee',description:'Saved evidence is retained.',status});
  // A saved live run is enough to block archive; no model request is dispatched.
  const run=await h.begin();
  await assert.rejects(update('archived',1),failure('WORKSPACE_WORK_PENDING'));
  await h.journal.finish(h.who,run.run.id,h.clientId,'cancel');
  const archived=await update('archived',1);assert.equal(archived.version,2);assert.equal((await readLayout(h.db,h.scoped)).version,1);
  await assert.rejects(saveLayout(h.db,h.scoped,{history:history(),expectedVersion:1}),failure('WORKSPACE_ARCHIVED'));
  await assert.rejects(h.invite(),failure('WORKSPACE_ARCHIVED'));
  const restored=await update('active',2);assert.equal(restored.version,3);assert.equal((await readLayout(h.db,h.scoped)).version,1);
});

test('workspace routes require same-origin writes and disclose no cookie token or foreign workspace administration',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);const makeRequest=routeHarness(t,h),second=await h.createWorkspace();
  const denied=await routes.POST(makeRequest('workspaces/switch',{origin:'https://foreign.example',body:{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId}}),params('switch'));
  assert.equal(denied.status,403);assert.equal((await denied.json()).code,'ORIGIN_DENIED');
  const switched=await routes.POST(makeRequest('workspaces/switch',{body:{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId}}),params('switch'));
  assert.equal(switched.status,200);const value=await switched.json();assert.deepEqual(Object.keys(value).sort(),['contextId','workspaceId']);assert.equal(switched.headers.get('Cache-Control'),'private, no-store');assert.ok(switched.headers.get('Set-Cookie')?.includes('HttpOnly'));
  const stale=await routes.POST(makeRequest('workspaces/profile',{body:{requestId:commandId(),displayName:'Stale tab'}}),params('profile'));assert.equal(stale.status,409);
  const newCookie=switched.headers.get('Set-Cookie')!.split(';')[0].split('=')[1];
  const foreign=await routes.GET(makeRequest('workspaces/unknown-workspace',{token:newCookie,contextId:value.contextId}),params('unknown-workspace'));assert.equal(foreign.status,404);
});

test('an expired cookie never silently becomes a new Sample identity; a deliberate new session remains provider-isolated',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);const makeRequest=routeHarness(t,h),before=(await h.db.query('SELECT token_hash FROM gh_sessions')).length;
  const unknown=makeRequest('session',{token:randomBytes(32).toString('hex'),body:{}});
  await assert.rejects(startSession(unknown),failure('SESSION_EXPIRED'));assert.equal((await h.db.query('SELECT token_hash FROM gh_sessions')).length,before);
  const newSession=await startSession(unknown,{fresh:true});const admitted=await h.service.admit(newSession.actor,newSession.token,{newSample:true});assert.equal(admitted.workspace.source,'sample');
  await assert.rejects(currentMember(h.db,newSession.actor.tenantId,newSession.actor.id,1),failure('WORKSPACE_CONNECTOR_REQUIRED'));
  assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]))[0],h.before.session);
});

test('legacy Sample proposal, approval, enqueue and source-revision paths recheck current context inside their write transactions',async t=>{
  const h=await workspaceHarness();t.after(h.dispose);routeHarness(t,h);
  const plan=await createPlan(h.scoped,'targeted',30000,h.snapshot.hash),second=await h.createWorkspace();
  const before={plans:await h.db.query('SELECT * FROM gh_plans'),dataset:await h.db.query('SELECT * FROM gh_datasets'),operations:await h.db.query('SELECT * FROM gh_operations')};
  await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});
  for(const work of [()=>createPlan(h.scoped,'targeted',30000),()=>approvePlan(h.scoped,plan.id,plan.hash),()=>enqueuePlan(h.scoped,plan.id,plan.hash),()=>reviseEvidence(h.scoped)])await assert.rejects(work(),failure('WORKSPACE_CONTEXT_CHANGED'));
  assert.deepEqual(await h.db.query('SELECT * FROM gh_plans'),before.plans);assert.deepEqual(await h.db.query('SELECT * FROM gh_datasets'),before.dataset);assert.deepEqual(await h.db.query('SELECT * FROM gh_operations'),before.operations);
});

test('viewer and revoked memberships cannot start legacy mutations or disclose a directory admitted before revocation',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);const makeRequest=routeHarness(t,h),joined=await h.join('viewer'),person=joined.directory.identity.personId;
  const readRequest=makeRequest('snapshots',{token:joined.accepted.token,contextId:joined.credential.contextId});const viewer=await actor(readRequest);
  await assert.rejects(actor(makeRequest('evidence/revise',{token:joined.accepted.token,contextId:joined.credential.contextId,body:{}})),failure('WORKSPACE_READ_ONLY'));
  await assert.rejects(reviseEvidence(viewer),failure('AUTHORITY_DENIED'));
  await h.service.updateMember(h.credential,h.saved.tenantId,person,{requestId:commandId(),expectedVersion:1,role:'viewer',active:false});
  await assert.rejects(assertRequestCurrent(readRequest),failure('CURRENT_AUTHORITY_REQUIRED'));
  await assert.rejects(h.service.verifyDisclosure(joined.credential,{contextId:joined.directory.identity.contextId,workspaces:joined.directory.workspaces,organizations:joined.directory.organizations}),failure('WORKSPACE_MEMBERSHIP_REQUIRED'));
  assert.equal((await h.db.query('SELECT * FROM gh_plans')).length,0);
});

test('legacy source-read commands recheck a switched or revoked requester before any gateway dispatch or queue mutation',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);await ensureObservationSchema(h.db);await ensureReportingSchema(h.db);
  let calls=0;const never=async()=>{calls++;throw new Error('A denied actor must not reach a provider gateway.');};
  const connector={id:'synthetic-connector',tenantId:h.saved.tenantId,credentialHash:'synthetic',webhookId:'synthetic-webhook',merchantId:'synthetic-merchant',configHash:'synthetic'};
  const observations=new ObservationService(h.db,null),reporting=new ReportingService(h.db,connector,{read:never}),disputes=new DisputeService(h.db,{list:never,get:never},{order:never});
  const commands=[()=>observations.enqueueStatus(h.scoped,'original-plan'),()=>observations.retryHeld(h.scoped),()=>reporting.start(h.scoped,{requestId:commandId(),start:new Date(Date.now()-86400000).toISOString(),end:new Date(Date.now()-1000).toISOString()}),()=>reporting.cancel(h.scoped,'original-scan'),()=>disputes.syncOrder(h.scoped,'original-order'),()=>disputes.syncCase(h.scoped,'original-order','original-case')];
  const second=await h.createWorkspace(),selected=await h.service.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});
  for(const work of commands)await assert.rejects(work(),failure('WORKSPACE_CONTEXT_CHANGED'));
  const restored=await h.service.switchWorkspace({sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId},{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:selected.selection.contextId});
  h.scoped=await h.db.transaction(tx=>sessionWorkspaceContext(tx,h.saved,h.sessionHash,restored.selection.contextId));
  await h.db.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]);
  for(const work of commands)await assert.rejects(work(),failure('CURRENT_AUTHORITY_REQUIRED'));
  assert.equal(calls,0);
  for(const table of ['gh_observation_jobs','gh_reporting_runs','gh_dispute_inventories','gh_operations'])assert.equal((await h.db.query(`SELECT * FROM ${table}`)).length,0);
});

test('archiving holds queued source reads and active reporting without changing their evidence or original authority',async t=>{
  const h=await workspaceHarness('owner');t.after(h.dispose);await ensureObservationSchema(h.db);await ensureReportingSchema(h.db);
  const update=()=>h.service.updateWorkspace(h.credential,h.saved.tenantId,{requestId:commandId(),expectedVersion:1,name:'Preserved incident',merchantName:'Sample merchant',description:'Read-only after archive.',status:'archived'});
  await h.db.query("INSERT INTO gh_observation_jobs(tenant_id,id,kind,subject,state) VALUES($1,'original-read','recovery','{}'::jsonb,'queued')",[h.saved.tenantId]);
  const before=await h.db.query('SELECT * FROM gh_observation_jobs');await assert.rejects(update(),failure('WORKSPACE_WORK_PENDING'));assert.deepEqual(await h.db.query('SELECT * FROM gh_observation_jobs'),before);
  await h.db.query("UPDATE gh_observation_jobs SET state='complete' WHERE tenant_id=$1",[h.saved.tenantId]);
  await h.db.query("INSERT INTO gh_reporting_runs(tenant_id,id,request_id,payload_hash,connector_id,config_hash,actor,grants,grant_hash,start_at,end_at) VALUES($1,'original-scan','synthetic-request','synthetic','synthetic','synthetic',$2::jsonb,'[]'::jsonb,'synthetic',now()-interval '1 day',now())",[h.saved.tenantId,JSON.stringify(h.saved)]);
  const scan=await h.db.query('SELECT * FROM gh_reporting_runs');await assert.rejects(update(),failure('WORKSPACE_WORK_PENDING'));assert.deepEqual(await h.db.query('SELECT * FROM gh_reporting_runs'),scan);
  await h.db.query("UPDATE gh_reporting_runs SET state='complete' WHERE tenant_id=$1",[h.saved.tenantId]);
  assert.equal((await update()).status,'archived');assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]))[0],h.before.session);
  assert.deepEqual((await h.db.query('SELECT * FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]))[0],h.before.member);
});
