# Scoped Transaction Search reporting

The adapter uses the pinned APIMatic-generated `paypal` 2.29.0 SDK, `client.transactionSearch.searchTransactions(...).asApiResult()`. The request fixes `fields=transaction_info`, balance-affecting records only, a page size of 100 and one explicit page. It never follows provider URLs. A selected interval is split into at most 31 daily windows; each window is capped at 100 pages. A worker issues a bounded sequential burst, reserves at least 30 seconds before claiming another page, and checkpoints each response before continuing.

## Boundaries and durable recovery

Schema 6 adds four tables: runs, windows, immutable page attempts and owned reporting evidence. Each run freezes a merchant binding and an owned-resource grant hash. Current membership, connector binding and grants are checked both before the GET and inside the result transaction. Leases fence out late workers. Cancellation retains earlier evidence and rejects late results. Failed attempts remain inspectable; transient failures back off on the same page, with eight attempts before attention is required. No reporting route reaches a financial executor.

Pagination metadata and refresh generation must stay consistent. The final accepted row count must match the declared total. An explicitly empty provider response is distinct from a timeout, malformed payload or missing result. This does not establish an atomic snapshot guarantee beyond the observations the provider supplies. Existing capture/refund evidence remains the authority for live payment outcomes.

Only exact, already-owned IDs are retained. Unrelated transactions, payer details, notes, addresses and arbitrary links are discarded. Signed money uses integer minor units. Different observations of one owned resource remain separate versions; overlapping daily boundaries deduplicate identical observations. HTTP access requires current tenant membership, mutations require same origin, and the scheduler requires its existing secret.

## Verified local scenario

The browser requested November 10–11, 2026 against a separate copy of the existing merchant history. Six actual PayPal GET pages returned 600 original captures totaling USD 27,600. The 38 owned refunds fell outside that capture-day window. A local read-only transport wrapper initially failed before dispatch; its three failed attempts were retained, and the same scan resumed successfully after the wrapper was corrected and restarted. The original hosted store was not used for local writes. Seven financial table fingerprints matched the hosted source after the scan, and the local transport rejected all PayPal writes except OAuth.

The last page was observed at 2026-11-11T06:43:56.390Z; PayPal reported its refresh at 03:29:59Z, an age of 11,637.39 seconds. The UI therefore reports the actual timestamp without claiming fresh coverage of every recent transaction. No authentic webhook delivery or live-money result is inferred.

Browser verification covered persisted reload, evidence pagination (1–50 and 51–100 of 600), a 390px viewport with no document/dialog overflow, contained table scrolling, and Escape returning focus to the source button. Tests cover signed provider money and field exclusion, malformed/empty/refused pages, durable restart, changing metadata, missing rows, rate-limit recovery, ownership and membership revocation, concurrent leases, late completion, cancellation and daily overlap. The full regression suite passed 93 tests; the final focused suite and release build are separately recorded.

## Operational use

`GET /api/reporting` reads coverage; an optional `runId` and positive `page` read bounded evidence pages. `POST /api/reporting` starts, continues or cancels a scan. `/api/internal/reporting` is a read-only authenticated cron separate from payment/recovery executors. Retrying a stopped or attention-required scan means reviewing and creating a new scan; its history is retained. Missing resources are unobserved, not evidence of a declined or lost payment.

The provider contract is documented in [PayPal’s Transaction Search reference](https://developer.paypal.com/docs/api/transaction-search/v1/) and [official OpenAPI specification](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/reporting_transactions_v1.json). Reporting-backed organization exports, new independent discrepancy investigations and the broader full-product roadmap remain separate work.
