import {database} from '../packages/db/client';
async function main(){
  const db=await database();
  const counts:Record<string,number>={};
  for(const table of ['gh_sessions','gh_datasets','gh_source_events','gh_state_intervals','gh_snapshots','gh_plans','gh_operations','gh_layouts','gh_threads','gh_audit']){
    const rows=await db.query<{count:string}>(`SELECT count(*) FROM ${table}`);counts[table]=Number(rows[0].count);
  }
  console.log(JSON.stringify({storage:'durable',counts},null,2));
}
main().then(()=>process.exit(0)).catch(()=>{console.error('Database inspection failed. Check server configuration.');process.exit(1);});
