export {};
if(!process.env.DATABASE_URL)throw new Error('An explicit durable database is required.');
if(process.env.GLASSHOUSE_AGENT_WORKER_ENABLED!=='true')throw new Error('Enable the model-only worker explicitly.');
const {agentRuntime}=await import('../lib/server/agents/runtime');
const app=await agentRuntime();
const result=await app.models.drain(4);
console.log(JSON.stringify(result));
process.exit(0);
