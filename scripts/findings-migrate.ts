export {};
if(process.env.GLASSHOUSE_FINDING_MIGRATION_CONFIRM!=='schema10-immutable-finding-lifecycle')throw new Error('Explicit schema10 finding lifecycle migration intent is required.');
if(!process.env.DATABASE_URL||!process.env.GLASSHOUSE_FINDING_KEY&&!process.env.GLASSHOUSE_AGENT_KEY&&!process.env.GLASSHOUSE_PAYMENT_KEY)throw new Error('Explicit PostgreSQL and a persistent private finding key are required.');
const {database}=await import('../packages/db/client');
const {ensureFindingsSchema}=await import('../lib/server/findings/schema');
await ensureFindingsSchema(await database());
console.log(JSON.stringify({schema:10,existingDocumentsChanged:false,legacyPlanHashesChanged:false,reportBytesChanged:false,financialRowsChanged:false,externalCalls:0}));
process.exit(0);
