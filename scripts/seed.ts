import {datasetFor} from '../lib/server/repository';
import {buildSnapshot} from '../packages/domain';
async function main(){
  const data=await datasetFor({id:'local-seeder',tenantId:'fernwood-local-seed',role:'owner',membershipVersion:1});
  const snapshot=buildSnapshot(data,{tenantId:data.tenantId,roleScope:'owner'});
  console.log(JSON.stringify({seed:data.version,revision:data.revision,orders:snapshot.totals.orders,affected:snapshot.totals.affected,source:'Sample',storage:'durable'},null,2));
}
main().then(()=>process.exit(0)).catch(error=>{console.error('Seed failed:',error instanceof Error?error.message:'unknown error');process.exit(1);});
