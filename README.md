# Glasshouse

A commerce incident room for Fernwood Coffee. Follow a signal through source evidence, reconstruct what was known at a point in time, and review an exact recovery manifest before authorizing it.

The application uses Next.js, React, PostgreSQL and six native AG Studio 3.1.0 instruments. Its actual Studio Agent Framework delegates investigation and chart creation through a server-side OpenAI adapter. The current source adds durable model/tool checkpoints, encrypted native history, sourced findings and owned PayPal Toolkit reads. Payment, fulfillment, remediation and dispute state remain separate.

The controlled sandbox run completed **600 captures totaling $27,600**, then **38 refunds totaling $190, 63 tracking assignments and four dispute evidence submissions**. A separate read of every recovery result confirmed all **105 original operations** at 2026-11-11 00:39:35 UTC. Shipping and support are explicitly synthetic fixtures; the four cases remained open, awaiting buyer response. See [the dated checkpoint](docs/evidence/checkpoint-2026-11-11.md) for evidence boundaries and validation.

## Run locally

Use Node 22 or later:

```sh
cp .env.example .env
npm ci
npm run dev
```

Set `DATABASE_URL` to your PostgreSQL connection, or leave it empty for the local embedded PostgreSQL store in `.data/postgres`. Open **http://localhost:4103**. Each new browser session receives an isolated, durable Sample workspace. Set `AG_STUDIO_LICENSE_KEY` to your valid Studio license; live AI uses the server-side `OPENAI_API_KEY` and a persistent base64 32-byte `GLASSHOUSE_AGENT_KEY` (or the existing payment-key fallback). Preserve the key for saved investigations. No credential belongs in a `NEXT_PUBLIC_` variable.

```sh
npm run typecheck
npm test
npm run build
npm run db:inspect
```

The exact sandbox review is at `/sandbox`. Financial setup additionally requires the isolated project's sandbox credentials and a persistent base64-encoded 32-byte `GLASSHOUSE_PAYMENT_KEY`. Preserve that key for the lifetime of encrypted records. The app obtains real buyer consent and a separate exact batch approval; a configured credential does not authorize a payment. Bounded workers accept explicit tenant/run or tenant/plan scope. Do not start another batch to replay an existing completed run.

Vercel requires external durable PostgreSQL. The authenticated notification inbox, durable read queue and **Check status** UI are implemented and covered by fixture tests, [isolated native-browser checks](docs/evidence/observations-2026-11-11.md), and [hosted original-observation qualification](docs/evidence/hosted-observations-qualification.json). Actual authenticated webhook delivery remains a separate gate. The local filesystem fallback is never used in Vercel. The [observation runbook](docs/observations.md) gives the exact endpoint, merchant binding and read-only worker contract.

## Explore

- **Incident room:** native Commerce River, Time Dial, Evidence Lens, Recovery Branches, Impact Map and Deadline Strip, plus editable native reports and saved undo/redo history.
- **Source and clock details:** choose historical evidence cutoffs or return to Latest known evidence. The dial changes story time while preserving the selected knowledge cutoff.
- **Recovery:** exact policy branches, all per-order conditions, immutable approval manifests, CSV export and independently verified operation outcomes.
- **Check status and notifications:** durable independent reads of original actions, separate current case status, pending/held read recovery and notification health. Original receipts and earlier evidence cutoffs remain intact.
- **Order record:** source evidence, timeline, eligibility and allowlisted PayPal receipts at the exact selected snapshot.
- **Disputes:** observed case status and actual seller deadlines where available.
- **History:** durable financial/audit events, separate from native layout history.
- **Agents:** Coordinator, Investigator, Planner, Operator and Writer with native Widget/Page/Planning delegates. Inspect actual saved child conversations, sourced finding cards and exact proposals. Durable model/tool identities recover known responses and preserve unknown outcomes without repeated dispatch. The native browser still owns Studio tool execution; the worker retrieves admitted model responses.

The frozen fixture has 600 orders and a 63-order incident. Nine delivery updates revise the affected cohort to 54. Before recovery, targeted goodwill selects 38 refunds at $5, alongside 63 tracking assignments and four dispute responses: 105 actions across 63 orders. The alternative policy removes the 48-hour grace condition and proposes 50 refunds. Completed refunds retain their original receipt and exclude the same order from later ordinary goodwill.

## Provider and authorization boundaries

The immutable shared core is `@fracture/paypal-core` **0.2.7**, from `vendor/fracture-paypal-core-0.2.7.tgz`. Its embedded source/provenance accompanies the pinned APIMatic-generated `paypal` **2.29.0** SDK at Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. This is distinct from `@paypal/paypal-server-sdk`. [Integration evidence](docs/apimatic/integration.md) explains how the repository's TypeScript context skills were used.

Every write checks current SQL membership, original resource ownership, immutable approval, policy, expiry and a durable operation claim. The final provider POST rechecks authority. Independent provider reads establish the result; an ambiguous write retains its original identity and is never blindly resent. Sample records cannot authorize provider execution. Disputes use a typed fixed-sandbox REST adapter.

The installed PayPal Agent Toolkit **1.11.0** now has four server-scoped read tools, guarded by current tenant/resource ownership and independent wire validation. Its actual package is tested with explicit synthetic transport. Live Toolkit reads default off and require separate provider qualification; every Toolkit write remains disabled. [Agent contracts and migration](docs/agents.md) explain exact-ID recovery, encrypted legacy history, native mutation receipts and deployment gates. [Dependency risks](docs/agents-dependencies.md) records the remaining audit findings.

The [isolated agent qualification record](docs/evidence/agents-runtime-qualification.json) records 133 application tests and 32 real-PostgreSQL agent tests, plus typecheck and production build. The installed native runner and Toolkit execute against explicit synthetic transports in those tests. Live model/browser/Toolkit-provider acceptance remains a separate gate.

## Reporting coverage

Open **Fernwood Coffee → source and clock ledger → Reporting** to read a past UTC window. The installed APIMatic SDK requests one transaction-info page at a time, saves its cursor, and links only already-owned capture/refund IDs. Work continues through the authenticated reporting cron; stopped scans retain their collected pages. A changed merchant, revoked operator, changed resource scope, changed pagination metadata, or a truncated result cannot be labelled complete.

The evidence table shows original resource/order identities, signed amounts, provider status, update time, and observation time. Reporting never creates a payment, retries a financial action, or replaces an independently verified receipt. The denominator counts all workspace-owned resources; resources outside the selected dates need not appear. PayPal documents reporting lag of up to three hours, but the observed refresh timestamp is shown without assuming that service level was met. See [reporting implementation and verification](docs/reporting.md).

## Current limits

This is an implementation checkpoint, not the full product release. The new durable-agent unit still needs its current live-model/browser/hosted qualification and actual scoped Toolkit reads. Authenticated webhook qualification, model comparisons, complete widget configuration/export, the full temporal/accessibility/performance corpus, organizational workflows, broader commerce remedies and the bounded public judge tour remain in scope. The [full delivery ledger](docs/remaining-scope.md) keeps those obligations explicit. No seller research, prevented-dispute or retained-revenue result is claimed. Provider tracking records an assignment; fulfillment fixtures supply delivery facts. Evidence submission records a seller response; current provider observations determine case status.

The repository is private. Private plans, credentials, operational evidence, local data and the build handoff remain excluded from Git.
