# Independent status and PayPal notifications

This unit implements authenticated intake, a durable queue of independent reads, append-only balance/case evidence, and **Check status** for saved recovery actions. Fixture tests qualify these implementation boundaries. An actual signed PayPal delivery, deployed restart/retry exercise and hosted scheduling still require separate qualification. Transaction Search backfill is a subsequent unit.

## Deployment binding

Register **`POST https://<stable-app-origin>/api/webhooks/paypal`** on the isolated Glasshouse sandbox REST application. The path must accept PayPal requests without an interactive login wall. Configure these server-side values on the same deployment and its read worker:

| Name | Required binding |
|---|---|
| `DATABASE_URL` | The durable Glasshouse PostgreSQL store containing the original owned resources. Back it up before activating this schema version. |
| `GLASSHOUSE_PAYMENT_KEY` | The existing base64-encoded 32-byte encryption key. Preserve it for all existing private records. |
| `PAYPAL_ENVIRONMENT` | `sandbox` |
| `PAYPAL_API_BASE_URL` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_PROJECT_ISOLATED` | `true`, after account isolation is established |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | That isolated sandbox app's server-side credentials |
| `PAYPAL_WEBHOOK_ID` | The actual registration ID for this endpoint on that app |
| `PAYPAL_MERCHANT_ID` | The sandbox seller's merchant ID |
| `GLASSHOUSE_PAYPAL_TENANT_ID` | One existing `fernwood-…` workspace with independently owned captures |
| `CRON_SECRET` | Private authorization for the read-only scheduler endpoint |

Recommended event subscriptions are `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.FAILED`, and `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED`. These names follow the [PayPal event catalogue](https://developer.paypal.com/api/rest/webhooks/event-names/). Unsupported resource states are held for a fresh read; the application does not manufacture a captured payment or checkout-decline transaction from an event.

PayPal postback verification requires the real app registration ID and unchanged received JSON. Simulator mock events do not support that verification path and do not qualify this connector. [PayPal's integration guide](https://developer.paypal.com/api/rest/webhooks/rest/) documents the distinction and provider delivery retries.

The first observation or capability request installs schema version 5 idempotently. A connector is bound to the credential fingerprint, registration, merchant and tenant. Configuration changes fail closed against the saved binding; they never silently move ownership. Credential/registration rotation needs an explicit migration and requalification rather than changing a value and assuming old jobs remain authorized.

## Durable processing

`POST /api/webhooks/paypal` verifies the bounded original request and encrypts its raw JSON/signature headers. It returns **202 only after** the canonical inbox event and its read job commit in one transaction. Invalid verification returns 400; unavailable verification/storage/configuration returns an error so delivery is not acknowledged. Repeated matching events join the canonical identity. Conflicting bytes, foreign merchant metadata and unsupported events remain recorded without authorizing a provider action.

Every read requires the exact active connector plus existing tenant-owned resource grants and original capture/manifest bindings. Supplied URLs are never followed. A notification arriving before the owned-resource acknowledgement waits durably; a foreign resource cannot trigger a provider read. Independently read payment amounts, complete refund inventories and exact case responses determine projections. Pending refunds reserve capacity without being counted as completed refunds. A later original receipt joins that inventory by refund identity. Older reads cannot overwrite newer resource evidence, and new facts do not rewrite earlier knowledge cutoffs.

The queue uses SQL claims, expiring leases, bounded reads and retry backoff. It stops automatic retries after 12 attempts or 24 hours and exposes attention reasons. Browser disconnect or worker loss leaves the saved job available to a later drain. Request-lifetime `after()` work is a prompt first attempt; configure a durable scheduler for unattended progress:

- **Hosted:** `GET /api/internal/observations` with `Authorization: Bearer <CRON_SECRET>`. Configure a recurring schedule in the hosting environment. Each invocation claims at most 40 reads.
- **Local or managed worker:** `npm run observations:worker -- --tenant=<tenant-id> --limit=20 --once`. Omit `--once` for a continuously running read worker. An optional `--job=<job-id>` also requires `--tenant`.

This worker receives only `RecoveryExecutor.reconcileOnly`, capture inventory reads and case reads. It cannot execute, approve or enqueue financial actions. OAuth and webhook verification may use POST; no refund, order, tracking or evidence POST is part of this path. Stop signals prevent new claims and let the current bounded read finish.

## Review and recovery

**Check status** saves reads of the existing immutable operations in a selected recovery. It can reconcile an uncertain original result after its approval expired or the original approver was revoked; requesting a check still requires current workspace membership. An active financial lease holds the check. An unsent original remains unsent, and a tracking write without an established tracker identity stays unresolved. A completed receipt remains byte-for-byte unchanged even if the current provider read fails or reports a different current state.

**PayPal notifications** shows authenticated deliveries, completed independent reads, pending jobs, rejected deliveries and held conflicts. **Recheck held sources** retries reads only. A missing binding is shown as awaiting connection; configuration alone never marks webhook delivery as qualified.

For a case, the UI separately reports whether the original evidence is present and whether PayPal reports resolution. New fulfillment-evidence proposals require a current seller-response state, a provider-allowed action, a supported unfulfilled request and an unexpired deadline when supplied. Awaiting-buyer cases and already submitted fulfillment evidence produce no duplicate proposal. A later request after an earlier fulfillment submission is conservatively held for a separate review.

Keep the completed original seed and recovery identities. Do not restart a financial worker or recreate payments to exercise these read paths. The original 600 captures and 105 recovery outcomes remain the recorded sandbox results; this unit is not a new financial run or completion of the full product plan.
