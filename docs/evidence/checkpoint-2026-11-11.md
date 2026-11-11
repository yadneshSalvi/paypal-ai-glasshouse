# Glasshouse implementation checkpoint — 11 November 2026

This checkpoint records completed integration units and their limits. The full project remains in development; no deployment, film, seller study or release completion is implied.

## Actual sandbox results

| Unit | Independently observed result | Cutoff (UTC) |
|---|---|---|
| Original approved seed | 600 distinct PayPal orders and captures; $27,600 total; maximum order $89; all stored receipts match the immutable entries | 2026-11-10 23:30:05.899 |
| Goodwill refunds | 38 original refunds, each $5; $190 completed | 2026-11-11 00:39:35.920 |
| Tracking assignments | 63 original owned-order assignments observed | Same cutoff |
| Dispute evidence | Four original seller submissions observed on four genuine controlled sandbox cases | Same cutoff |
| Full recovery recheck | 105 of 105 original results matched separate provider reads; zero unconfirmed | Same cutoff |

The separate read pass followed the completed bounded queue. The initial refund's parent metadata used another exact PayPal sandbox host; its first response was held, then reconciled from the same original refund/order/capture. The operation stayed at one write attempt. No replacement refund was sent.

Root reviewed the complete 105-row manifest and approved $190 within a $300 cap in the app before the queue started. All 63 tracking payloads and four evidence statements were visible. Buyer notifications were disabled. Shipping/support observations and carrier references are synthetic; PayPal recorded tracking assignments with SHIPPED status. The nine fixture-delivered orders retain their separate delivery evidence. The owning-order read omits some original carrier/number fields, so receipt details distinguish approved-request fields from returned identity/status.

The four cases were created through the isolated buyer's native Resolution Center with explicit controlled-test notes. An audited, append-only fixture revision moved four previously uncreated case intentions to four same-amount purchases that the buyer UI could identify reliably. All 600 original payment identities, amounts and historical observations were preserved. The four cases were independently observed awaiting buyer response, with no seller response deadline, at 00:37:32.815 UTC. They remained open; no escalation, adjudication or real shipment was claimed.

## Application validation

- **63 tests passed**, zero failures/skips, in 45.330 seconds. These use deterministic domain inputs, the installed SDK serializer, controlled fetch responses and SQL fixtures; they are separate from the actual provider results above.
- `npm run typecheck` passed. `npm run build` completed the optimized Next.js build, TypeScript and all route generation.
- Native AG Studio 3.1.0 renders the six registered instruments. An actual Coordinator → Investigator → Page → Widget run created the retained support chart.
- Browser review verified full native canvas height, readable 360/390px views, no document overflow, all 105 manifest actions and all 63 policy rows. At 390px the order receipt tabs support arrow-key navigation; Escape from the nested order drawer returns focus to its originating button in the still-open manifest.
- A historical cutoff displayed a Sample capture, zero later refund and no future provider IDs. Sequential Before → After → Latest known evidence and a rapid Before → Latest reversal settled without reload. The native root and all six instruments shared one exact snapshot hash; the saved chart and six undo entries remained intact.
- Four dedicated asynchronous transaction tests cover returning to the current hash during an in-flight change, skipped intermediate requests, valid add/update/remove deltas, hash-specific widget agreement and a held engine failure.

Native history was repaired through the application's lifecycle boundary, without editing the vendor package or deleting saved snapshots. Layout undo never reverses financial actions.

## Provenance and outstanding work

The dependency is the immutable MIT-licensed core 0.2.7 archive, SHA-256 `a2ccc98af5da871e3c057bcdc142c303d0d1d2f2fa9a9a42324d566177fa1061`. Its source and conformance provenance are inside the archive. [APIMatic integration evidence](../apimatic/integration.md) records the context-guided implementation decisions.

Original provider reports and browser recordings/screenshots are retained privately. Public-facing DTOs contain allowlisted resource facts, clocks and fingerprints, with tenant/order/snapshot matching; credentials, payer identities and raw provider payloads remain private. A fresh Sample session does not inherit the completed owner's provider resources.

Remaining release scope includes verified webhooks and backfill, current case-action proposal eligibility, complete recovery failure/renewal UX, durable scoped agents and actual Toolkit reads, model evaluations, all widget configuration/export contracts, the full temporal/security/accessibility/performance corpus, postmortems, broader commerce operations, bounded judge access and final hosted/release verification. The demonstrated subset does not certify those unfinished areas.
