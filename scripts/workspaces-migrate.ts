export {};
/** The deployment owner applies this additive migration after a verified backup
 * and the schema7 private-agent cutover. It never rewrites an existing identity. */
if(process.env.GLASSHOUSE_WORKSPACE_MIGRATION_CONFIRM!=='schema8-private-workspaces')throw new Error('Explicit schema8 private-workspace migration intent is required.');
if(!process.env.DATABASE_URL)throw new Error('An explicit PostgreSQL database is required.');
if(!process.env.GLASSHOUSE_WORKSPACE_KEY&&!process.env.GLASSHOUSE_PAYMENT_KEY)throw new Error('A persistent private workspace storage key is required.');
const {database}=await import('../packages/db/client');
const {ensureRecoverySchema}=await import('../lib/server/recovery/schema');
const {ensureWorkspacesSchema}=await import('../lib/server/workspaces/schema');
const db=await database();
if(!(await db.query('SELECT version FROM gh_schema_version WHERE version=7'))[0])throw new Error('Complete the schema7 private-agent migration first.');
await ensureRecoverySchema(db);await ensureWorkspacesSchema(db);
console.log(JSON.stringify({schema:8,existingSessionsRewritten:false,existingMembershipsRewritten:false,providerResourcesCopied:false,financialRowsChanged:false}));
process.exit(0);
