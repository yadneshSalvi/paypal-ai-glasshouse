export {};
/** Root-owned operational entry point. Do not load this script against an original
 * or hosted database until its backup and intended authority are verified. */
if(process.env.GLASSHOUSE_AGENT_MIGRATION_CONFIRM!=='schema7-and-private-agent-documents')throw new Error('Explicit schema7/private-document migration intent is required.');
if(!process.env.DATABASE_URL)throw new Error('An explicit PostgreSQL database is required.');
const key=process.env.GLASSHOUSE_AGENT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY;
if(!key)throw new Error('A durable agent encryption key is required.');
const {database}=await import('../packages/db/client');
const {ensureAgentsSchema}=await import('../lib/server/agents/schema');
const {AgentSecrets}=await import('../lib/server/agents/security');
const {encryptLegacyAgentDocuments}=await import('../lib/server/agents/threads');
const db=await database();await ensureAgentsSchema(db);
const counts=await encryptLegacyAgentDocuments(db,new AgentSecrets(key));
console.log(JSON.stringify({schema:7,encrypted:counts,financialTablesChanged:false}));
process.exit(0);
