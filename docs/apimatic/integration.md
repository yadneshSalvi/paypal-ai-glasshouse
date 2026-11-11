# APIMatic integration evidence — 11 November 2026

The repository-local PayPal context plugin and its original licence/provenance are described in [APIMATIC_SETUP.md](../../APIMATIC_SETUP.md). During implementation, the TypeScript integration, getting-started, client-initialization, authentication, calling-endpoints, models, configuration-resilience, error-handling and testing skills were read before selecting or changing SDK contracts. The local private contract ledger recorded each operation before implementation; it is not needed to run this repository.

## Decisions implemented from that context

- Selected the generated `paypal` 2.29.0 SDK at `context-plugins/paypal-typescript-sdk@5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`, rather than assuming the similarly named PayPal server SDK has the same controllers/models.
- Inspected the installed endpoint and model declarations for Vault setup/token exchange, Orders, captures, refunds and tracking. The immutable shared core contains the SDK wrapper and its exact source/provenance; Glasshouse owns the consent, approval and resource-authority contracts.
- Kept SDK credentials and OAuth state server-side. `lib/server/payments/transport.ts` uses fixed sandbox destinations, disables automatic data-POST retries and rechecks current domain authority at the final dispatch boundary.
- Treated SDK serialization and error wrapping as observable behavior. `tests/payments.test.ts` and `tests/recovery.test.ts` exercise the installed SDK through controlled fetch responses and SQL stores, including a revoked actor during the final preflight read and a lost successful response.
- Used explicit typed REST for the unsupported Disputes controller path in `lib/server/recovery/disputes.ts`. Exact case ownership, live action availability, approved evidence fields and a separately observed submission determine success.
- Preserved endpoint-specific operation identity. `recoverOperation` in core 0.2.7 reuses the original persisted operation and may resume an eligible unsent claim under current authority. Independent **Check status** instead calls Glasshouse `RecoveryExecutor.reconcileOnly`, which uses the core's read-only `reconcile` method and exact original-resource reads; it never calls `recoverOperation`, `execute` or a financial drain.
- Reused the installed core's PayPal signature postback verifier with exact received JSON, bounded responses and fixed sandbox OAuth/verification paths. A verified event is a scoped read trigger; it cannot become a refund, tracking or evidence command. The encrypted inbox and SQL outbox commit together. See [the observation contract](../observations.md).

## Evidence and scope

The original financial checkpoint passed 63 Glasshouse tests; the observation unit expanded the full suite to **82 passing tests**. The unchanged pinned core separately passed 148 conformance tests. Actual sandbox evidence is summarized in [the financial checkpoint](../evidence/checkpoint-2026-11-11.md), and the new fixture/native-browser evidence in [the observation checkpoint](../evidence/observations-2026-11-11.md). Fixture fetch responses establish serialization, state and authority invariants; actual provider observations establish sandbox capability. Credentials, payer identities and raw provider payloads are excluded from this document and from browser/model responses.

This is evidence of context usage and implementation, not an APIMatic award or subscription claim. No subscription form or external message was sent.
