type ObjectValue=Record<string,unknown>;
const object=(value:unknown):value is ObjectValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':object(value)?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value)??'null';

/** Studio 3.1 reports conflicting first/last ordering as a fatal validation
 * event on the shared report engine. Refuse that read before granting a native
 * execution, retaining the exact requested query and an actionable tool result.
 * This supplements, and never replaces, the native schema/engine validation.
 */
export function nativeQueryRefusal(args:unknown):string|null{
  if(!object(args)||!object(args.query))return null;
  const pending:unknown[]=[args.query];let visited=0;
  while(pending.length){
    const value=pending.pop();if(!object(value)&&!Array.isArray(value))continue;
    if(++visited>10_000)return 'This query is too complex to validate safely. Split it into smaller independent queries.';
    if(object(value)&&value.kind==='apiQuery'&&value.variant==='aggregation'&&Array.isArray(value.measures)){
      let first:{name:string;order:string}|undefined;
      for(const measure of value.measures){
        if(!object(measure)||!object(measure.field)||!['first','last'].includes(String(measure.field.aggregation))||!Array.isArray(measure.orderBy)||!measure.orderBy.length)continue;
        const name=typeof measure.as==='string'?measure.as:String(measure.field.id),order=canonical(measure.orderBy);
        if(first&&first.order!==order)return `Query not executed: first/last measures "${first.name}" and "${name}" require different row orders. AG Studio requires one shared orderBy for order-dependent measures in a query. Split these into separate queries, or explicitly use the same ordering if that answers your question. No report or source data changed.`;
        first??={name,order};
      }
    }
    pending.push(...(Array.isArray(value)?value:Object.values(value)));
  }
  return null;
}
