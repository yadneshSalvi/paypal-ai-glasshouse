import type {Database} from '../../packages/db/client';
import type {SeedDataset,QueryContext} from '../../packages/domain/types';

/** Independent PostgreSQL oracle. It reads raw source observations, never an
 * application snapshot, policy evaluator, widget model or native query result. */
export async function referenceLedger(db:Database,dataset:SeedDataset,context:Pick<QueryContext,'asOf'|'knownAt'|'currency'|'clockDomain'>,scope?:string[]){
 return db.query<{id:string;captured_minor:number;captures:number;refunded_minor:number;pending_minor:number;lines:number;shipments:number;due:number;late:number;fulfillment:string;dispute_state:string;dispute_source:string;deadline:string|null;targeted:boolean;comprehensive:boolean;region_code:string;region:string}>(`
 WITH input AS (SELECT $1::jsonb AS d),
 orders AS (SELECT o->>'id' id,o FROM input,jsonb_array_elements(d->'orders') o
   WHERE o->>'currency'=$4 AND ($6::jsonb IS NULL OR o->>'id' IN (SELECT jsonb_array_elements_text($6::jsonb)))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'events') e WHERE e->>'orderId'=o->>'id' AND e->>'type'='order.created'
     AND (e->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz<=$2::timestamptz AND (e->>'ingestedAt')::timestamptz<=$3::timestamptz)),
 visible AS (SELECT f,ROW_NUMBER() OVER(PARTITION BY f->>'kind',f->>'resourceId'
   ORDER BY (f->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz DESC,(f->>'ingestedAt')::timestamptz DESC,(f->>'revision')::int DESC,f->>'id' DESC) version
   FROM input,jsonb_array_elements(d->'commerceFacts') f WHERE f->>'currency'=$4 AND (f->>'ingestedAt')::timestamptz<=$3::timestamptz
   AND (f->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz<=$2::timestamptz),
 latest AS (SELECT f FROM visible WHERE version=1),
 captures AS (SELECT f->>'orderId' id,SUM((f->>'amountMinor')::int)::int money,COUNT(*)::int n FROM latest WHERE f->>'kind'='capture' AND f->>'state' IN ('captured','completed','succeeded') GROUP BY 1),
 refunds AS (SELECT f->>'orderId' id,SUM(CASE WHEN f->>'state' IN ('completed','refunded','succeeded') THEN (f->>'amountMinor')::int ELSE 0 END)::int money,
   SUM(CASE WHEN f->>'state' IN ('pending','processing') THEN (f->>'amountMinor')::int ELSE 0 END)::int pending FROM latest WHERE f->>'kind'='refund' GROUP BY 1),
 lines AS (SELECT f->>'orderId' id,COUNT(*)::int n FROM latest WHERE f->>'kind'='line' GROUP BY 1),
 ships AS (SELECT o.id,COUNT(*)::int n,
   COUNT(*) FILTER(WHERE f->>'state' IN ('queued','shipped','in_transit','delayed','delivered','lost') AND NULLIF(CASE WHEN f?'promisedAt' THEN f->>'promisedAt' ELSE o.o->>'promisedAt' END,'')::timestamptz<=$2::timestamptz)::int due,
   COUNT(*) FILTER(WHERE f->>'state' IN ('queued','shipped','in_transit','delayed','lost') AND NULLIF(CASE WHEN f?'promisedAt' THEN f->>'promisedAt' ELSE o.o->>'promisedAt' END,'')::timestamptz<=$2::timestamptz)::int late,
   CASE WHEN BOOL_AND(f->>'state'='delivered') THEN 'delivered' WHEN BOOL_OR(f->>'state'='delayed') THEN 'delayed' WHEN BOOL_OR(f->>'state' IN ('shipped','in_transit','delivered')) THEN 'in_transit' ELSE 'unknown' END state
   FROM latest JOIN orders o ON o.id=f->>'orderId' WHERE f->>'kind'='shipment' GROUP BY o.id),
 case_observations AS (SELECT e,ROW_NUMBER() OVER(PARTITION BY e->>'orderId' ORDER BY (e->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz DESC,(e->>'ingestedAt')::timestamptz DESC,(e->>'revision')::int DESC,e->>'id' DESC) version
   FROM input,jsonb_array_elements(d->'events') e WHERE e->>'dimension'='dispute' AND (e->>'ingestedAt')::timestamptz<=$3::timestamptz AND (e->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz<=$2::timestamptz),
 facts AS (SELECT o.id,o.o,COALESCE(c.money,0) captured_minor,COALESCE(c.n,0) captures,COALESCE(r.money,0) refunded_minor,COALESCE(r.pending,0) pending_minor,
   COALESCE(l.n,0) lines,COALESCE(s.n,0) shipments,COALESCE(s.due,0) due,COALESCE(s.late,0) late,COALESCE(s.state,'unknown') fulfillment,
   COALESCE(d.e->>'state','unknown') dispute_state,COALESCE(d.e->>'sourceClass','sample') dispute_source,d.e->'payload'->>'sellerResponseDueAt' deadline
   FROM orders o LEFT JOIN captures c USING(id) LEFT JOIN refunds r USING(id) LEFT JOIN lines l USING(id) LEFT JOIN ships s USING(id)
   LEFT JOIN case_observations d ON d.e->>'orderId'=o.id AND d.version=1)
 SELECT id,captured_minor,captures,refunded_minor,pending_minor,lines,shipments,due,late,fulfillment,dispute_state,dispute_source,deadline,
   (o->>'incidentMember')::boolean AND fulfillment IN ('in_transit','delayed','shipped') AND NULLIF(o->>'promisedAt','')::timestamptz+interval '48 hours'<=$2::timestamptz
     AND dispute_state IN ('none','resolved','closed','cancelled') AND refunded_minor=0 AND pending_minor=0 AND captured_minor>=500 AND $4='USD' AS targeted,
   (o->>'incidentMember')::boolean AND fulfillment IN ('in_transit','delayed','shipped') AND NULLIF(o->>'promisedAt','')::timestamptz<=$2::timestamptz
     AND dispute_state IN ('none','resolved','closed','cancelled') AND refunded_minor=0 AND pending_minor=0 AND captured_minor>=500 AND $4='USD' AS comprehensive,
   o->>'regionCode' region_code,o->>'region' region FROM facts ORDER BY id`,[JSON.stringify(dataset),context.asOf,context.knownAt,context.currency,context.clockDomain,scope?JSON.stringify(scope):null]);
}

export async function referenceResources(db:Database,dataset:SeedDataset,context:Pick<QueryContext,'asOf'|'knownAt'|'currency'|'clockDomain'>){
 return db.query<{fact:Record<string,unknown>}>(`WITH visible AS (SELECT f,ROW_NUMBER() OVER(PARTITION BY f->>'kind',f->>'resourceId' ORDER BY (f->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz DESC,(f->>'ingestedAt')::timestamptz DESC,(f->>'revision')::int DESC,f->>'id' DESC) version
 FROM jsonb_array_elements($1::jsonb->'commerceFacts') f WHERE f->>'currency'=$4 AND (f->>'ingestedAt')::timestamptz<=$3::timestamptz AND (f->>CASE WHEN $5='observed' THEN 'occurredAt' ELSE 'narrativeTime' END)::timestamptz<=$2::timestamptz)
 SELECT f AS fact FROM visible WHERE version=1 ORDER BY f->>'kind',f->>'resourceId'`,[JSON.stringify(dataset),context.asOf,context.knownAt,context.currency,context.clockDomain]);
}
