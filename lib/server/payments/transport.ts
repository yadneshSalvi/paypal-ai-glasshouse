import { AsyncLocalStorage } from 'node:async_hooks';
import { ProviderError, type ProviderAdapter, type PaymentCommand } from '@fracture/paypal-core';

type WriteScope = { identity: string; path: string; sent: boolean;dispatched:boolean;denial?:ProviderError;authorize?:()=>Promise<void> };
/** Counts before dispatch. OAuth and reads never consume the single allowed financial write. */
export class OneWriteTransport {
  private readonly context = new AsyncLocalStorage<WriteScope>();
  constructor(private readonly send: typeof fetch = fetch) {}
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, {...init,redirect:'error'});
    const url = new URL(request.url);
    if (url.origin !== 'https://api-m.sandbox.paypal.com') throw new ProviderError('encode', 'Only the isolated PayPal sandbox host is allowed.', 'not_sent', 503);
    if (!['GET', 'HEAD'].includes(request.method) && url.pathname !== '/v1/oauth2/token') {
      const scope = this.context.getStore();
      if (!scope || scope.path !== url.pathname || scope.sent) throw new ProviderError('encode', 'The durable payment operation did not authorize another provider write.', scope?.dispatched?'unknown':'not_sent', 409);
      scope.sent = true;
      try{
        if(request.signal.aborted)throw new ProviderError('timeout','The provider write was cancelled before dispatch.','not_sent',409);
        if(scope.authorize)await scope.authorize();
        if(request.signal.aborted)throw new ProviderError('timeout','The provider write was cancelled before dispatch.','not_sent',409);
      }catch(error){
        scope.denial=error instanceof ProviderError?error:new ProviderError('encode','Current authority did not permit the original provider write.','not_sent',403);
        throw scope.denial;
      }
      scope.dispatched=true;
    }
    return this.send(request);
  };
  run<T>(identity: string, path: string, work: () => Promise<T>,authorize?:()=>Promise<void>): Promise<T> {
    const scope:WriteScope={identity,path,sent:false,dispatched:false,authorize};
    return this.context.run(scope,async()=>{try{return await work();}catch(error){if(scope.denial&&!scope.dispatched)throw scope.denial;throw error;}});
  }
  provider(inner: ProviderAdapter,authorize?:(command:PaymentCommand)=>Promise<void>): ProviderAdapter {
    return {
      source: inner.source,
      execute: (command, signal) => this.run(command.operationId, writePath(command), () => inner.execute(command, signal),authorize?()=>authorize(command):undefined),
      read: (kind, id, signal) => inner.read(kind, id, signal),
      reconcile: (operation, signal) => inner.reconcile(operation, signal),
    };
  }
}

function writePath(command: PaymentCommand): string {
  const action = command.action;
  if (action.kind === 'create_order') return '/v2/checkout/orders';
  if (action.kind === 'capture_order') return `/v2/checkout/orders/${encodeURIComponent(action.orderId)}/capture`;
  if (action.kind === 'authorize_order') return `/v2/checkout/orders/${encodeURIComponent(action.orderId)}/authorize`;
  if (action.kind === 'refund_capture') return `/v2/payments/captures/${encodeURIComponent(action.captureId)}/refund`;
  if (action.kind === 'capture_authorization') return `/v2/payments/authorizations/${encodeURIComponent(action.authorizationId)}/capture`;
  return `/v2/payments/authorizations/${encodeURIComponent(action.authorizationId)}/void`;
}
