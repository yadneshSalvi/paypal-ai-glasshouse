export {};
if(process.env.GLASSHOUSE_REPORT_MIGRATION_CONFIRM!=='schema9-immutable-reports')throw new Error('Explicit schema9 immutable-report migration intent is required.');
if(!process.env.DATABASE_URL||!process.env.GLASSHOUSE_REPORT_KEY&&!process.env.GLASSHOUSE_PAYMENT_KEY)throw new Error('Explicit PostgreSQL and a persistent private report key are required.');
const {database}=await import('../packages/db/client');
const {ensureReportsSchema}=await import('../lib/server/reports/schema');
await ensureReportsSchema(await database());
console.log(JSON.stringify({schema:9,existingIdentitiesChanged:false,existingEvidenceChanged:false,financialRowsChanged:false,externalCalls:0}));
process.exit(0);
