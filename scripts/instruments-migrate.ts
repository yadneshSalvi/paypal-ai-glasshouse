export {};
if(process.env.GLASSHOUSE_INSTRUMENT_MIGRATION_CONFIRM!=='schema11-multiresource-observations')throw new Error('Explicit additive schema11 migration intent is required.');
const {database}=await import('../packages/db/client');const db=await database();
if(process.env.GLASSHOUSE_INSTRUMENTS_ISOLATED_QA){
  const url=new URL(process.env.DATABASE_URL??'');if(url.port!=='55557'||url.pathname.slice(1)!==process.env.GLASSHOUSE_INSTRUMENTS_ISOLATED_QA)throw new Error('The fresh qualification identity does not match.');
  const migrations=[['payments','ensurePaymentsSchema'],['recovery','ensureRecoverySchema'],['observations','ensureObservationSchema'],['reporting','ensureReportingSchema'],['agents','ensureAgentsSchema'],['workspaces','ensureWorkspacesSchema'],['reports','ensureReportsSchema'],['findings','ensureFindingsSchema']];
  for(const [name,fn] of migrations){const module=await import('../lib/server/'+name+'/schema');await module[fn](db);}
}
const {ensureInstrumentSchema}=await import('../lib/server/instruments/schema');await ensureInstrumentSchema(db);
console.log(JSON.stringify({schema:11,additive:true,providerCalls:0,modelCalls:0}));process.exit(0);
