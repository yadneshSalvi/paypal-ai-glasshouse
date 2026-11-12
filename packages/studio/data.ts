import type {AgDataSourcesDefinition,AgFieldDefinition} from 'ag-studio';
import type {Snapshot} from '../domain/types';
import type {GlasshouseRegistry} from './types';

export function studioData(snapshot:Snapshot):AgDataSourcesDefinition<GlasshouseRegistry>{
  return {
    description:'Fernwood commerce history. Every table belongs to one immutable T/K snapshot. Monetary amounts are integer minor units. Sample payment rows have no provider capture ID. Fixture shipping is independent from provider payment state. One order_snapshot row per unique order; other tables have their own grain.',
    sources:Object.entries(snapshot.tables).map(([id,data])=>({id,name:id.replace('_snapshot','').replace(/^./,s=>s.toUpperCase()),transactions:'all' as const,primaryKeyField:'id',data,
      fields:fieldsFor(id,data),
    })),
    relationships:['transition_snapshot','finding_snapshot','action_snapshot','deadline_snapshot','capture_snapshot','refund_snapshot','line_snapshot','shipment_snapshot','regional_order_snapshot','regional_baseline_order_snapshot'].filter(id=>snapshot.tables[id]).map(id=>({id:'orders-'+id,type:'one-to-many' as const,source:'order_snapshot.id',target:id+'.orderId'})),
    options:{fanout:{warning:true,execute:'prevent'}},
  };
}
const resourceFields='id orderId grain resourceId parentResourceId state amountMinor currency quantity occurredAt narrativeTime ingestedAt revision sourceClass sourceRef promisedAt resourceCount snapshotHash';
const sourceFields:Record<string,string>={
  order_snapshot:'id orderId grain reference region regionCode fulfillmentState paymentState remediationState disputeState disputeOpen amountMinor refundableMinor refundedMinor goodwillCreditMinor currency paymentSource seedGroup supportContacts narrativeCreatedAt createdAt promisedAt lateHours affected incidentMember captureId paypalOrderId providerOccurredAt captureCount providerCaptureCount orderCount resourceVersion capturedMinor refundCount shipmentCount dueShipmentCount lateShipmentCount lineCount resourceCoverage snapshotHash',
  transition_snapshot:'id orderId resourceId grain dimension fromState toState transitionTime occurredAt narrativeTime ingestedAt sourceClass sourceLabel sourceEventId transitionCount captureCount amountMinor currency snapshotHash',
  finding_snapshot:'id orderId grain kind title excerpt sourceClass sourceLabel occurredAt ingestedAt supports contradicts untrusted status formulaVersion baselineNumerator baselineDenominator currentNumerator currentDenominator delta threshold window explanation snapshotHash',
  action_snapshot:'id orderId grain branchId policyId reference kind amountMinor currency resourceId resourceVersion sourceClass eligibility blockedReason payload evidenceIds snapshotHash',
  regional_snapshot:'id grain region regionCode day inventoryAt orderCount eligibleShipmentCount lateCount lateShare baselineAt baselineOrderCount baselineNumerator baselineDenominator baselineShare snapshotHash',
  deadline_snapshot:'id orderId grain reference disputeId state sourceClass dueAt dueDateVerified owner clockDomain deadlineCount snapshotHash',
  line_snapshot:resourceFields,capture_snapshot:resourceFields,refund_snapshot:resourceFields,shipment_snapshot:resourceFields,
  regional_order_snapshot:'id orderId grain region regionCode day inventoryAt orderCount eligibleShipmentCount lateCount snapshotHash',
  regional_baseline_order_snapshot:'id orderId grain region regionCode baselineAt orderCount eligibleShipmentCount lateCount snapshotHash',
};
const numericFields=new Set('baselineNumerator baselineDenominator currentNumerator currentDenominator delta threshold lateShare baselineShare revision quantity resourceVersion cohortVersion projectionVersion'.split(' '));
const booleanFields=new Set('disputeOpen affected incidentMember untrusted dueDateVerified'.split(' '));
/** A table's source schema survives empty revisions. Data is never used as the
 * sole type declaration for a column that a saved native mapping depends on. */
export function fieldsFor(id:string,rows:Snapshot['tables']['order_snapshot']):AgFieldDefinition<GlasshouseRegistry>[]|undefined{
  const keys=[...new Set([...(sourceFields[id]?.split(' ')??[]),...rows.flatMap(r=>Object.keys(r))])];
  if(!keys.length)keys.push('id','orderId','snapshotHash');
  return keys.map(key=>{
    const value=rows.find(r=>r[key]!==null&&r[key]!==undefined)?.[key];
    const numeric=typeof value==='number'||numericFields.has(key)||/Minor$|Count$|Hours$|Contacts$/.test(key);
    const temporal=/At$|Time$|From$|To$/.test(key)&&key!=='state';
    return {id:key,name:key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,s=>s.toUpperCase()),format:temporal?'dateTimeFormat':numeric?'integerFormat':typeof value==='boolean'||booleanFields.has(key)?'booleanFormat':'textFormat',hide:['snapshotHash','contextHash','tenantId'].includes(key),
      ...(key==='amountMinor'?{name:id==='order_snapshot'?'Order amount (minor units)':'Resource or transition amount (minor units)',description:'Integer minor units in the snapshot denomination. Resource counts and unique orders have distinct grains.'}:{}),
    } as AgFieldDefinition<GlasshouseRegistry>;
  });
}
