import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { recoveryRuntime } from '../lib/server/recovery/runtime';
import { ScenarioService, type ScenarioRequest } from '../lib/server/recovery/scenario-service';
import type { Actor, Role } from '../packages/domain/types';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{const at=value.indexOf('=');return[value.slice(0,at),value.slice(at+1)];}));
const tenantId=args['--tenant'],mapping=args['--mapping'];
if(!tenantId||!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)||!mapping?.startsWith('.setup-evidence/'))throw new Error('Provide an exact --tenant and private --mapping=.setup-evidence/... JSON.');
const request=JSON.parse(await readFile(mapping,'utf8')) as ScenarioRequest;
const runtime=await recoveryRuntime();
const row=(await runtime.service.db.query<{approved_by:string;role:Role;version:number}>(`SELECT r.approved_by,m.role,m.version FROM gh_seed_runs r JOIN gh_memberships m ON m.tenant_id=r.tenant_id AND m.actor_id=r.approved_by AND m.active=true WHERE r.tenant_id=$1 AND r.status='complete' ORDER BY r.created_at DESC LIMIT 1`,[tenantId]))[0];
if(!row)throw new Error('A completed original seed with a current authorized member is required.');
const actor:Actor={id:row.approved_by,tenantId,role:row.role,membershipVersion:row.version};
const service=new ScenarioService(runtime.service.db,runtime.disputes,runtime.providers!.evidence);
const report=await service.revise(actor,request);
await mkdir('.setup-evidence',{recursive:true,mode:0o700});
await writeFile(`.setup-evidence/glasshouse-scenario-${request.revisionId}.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
process.exit(0);
