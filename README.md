# Glasshouse

A commerce incident room for Fernwood Coffee. Follow a signal through source evidence, reconstruct what was known at a point in time, and review an exact recovery manifest before authorizing it.

The application uses Next.js, React, PostgreSQL and six native AG Studio 3.1.0 instruments. Its actual Studio Agent Framework delegates investigation and chart creation through a server-side OpenAI adapter. Payment, fulfillment, remediation and dispute state remain separate.

The controlled sandbox run completed **600 captures totaling $27,600**, then **38 refunds totaling $190, 63 tracking assignments and four dispute evidence submissions**. A separate read of every recovery result confirmed all **105 original operations** at 2026-11-11 00:39:35 UTC. Shipping and support are explicitly synthetic fixtures; the four cases remained open, awaiting buyer response. See [the dated checkpoint](docs/evidence/checkpoint-2026-11-11.md) for evidence boundaries and validation.

## Run locally

Use Node 22 or later:

```sh
cp .env.example .env
npm ci
npm run dev
```

Set `DATABASE_URL` to your PostgreSQL connection, or leave it empty for the local embedded PostgreSQL store in `.data/postgres`. Open **http://localhost:4103**. Each new browser session receives an isolated, durable Sample workspace. Set `AG_STUDIO_LICENSE_KEY` to your valid Studio license; live AI uses the server-side `OPENAI_API_KEY`. No credential belongs in a `NEXT_PUBLIC_` variable.

```sh
npm run typecheck
npm test
npm run build
npm run db:inspect
```

The exact sandbox review is at `/sandbox`. Financial setup additionally requires the isolated project's sandbox credentials and a persistent base64-encoded 32-byte `GLASSHOUSE_PAYMENT_KEY`. Preserve that key for the lifetime of encrypted records. The app obtains real buyer consent and a separate exact batch approval; a configured credential does not authorize a payment. Bounded workers accept explicit tenant/run or tenant/plan scope. Do not start another batch to replay an existing completed run.

Vercel requires external durable PostgreSQL. Hosted scheduling, webhook delivery and deployment qualification remain pending at this checkpoint; the local filesystem fallback is never used there.

## Explore

- **Incident room:** native Commerce River, Time Dial, Evidence Lens, Recovery Branches, Impact Map and Deadline Strip, plus editable native reports and saved undo/redo history.
- **Source and clock details:** choose historical evidence cutoffs or return to Latest known evidence. The dial changes story time while preserving the selected knowledge cutoff.
- **Recovery:** exact policy branches, all per-order conditions, immutable approval manifests, CSV export and independently verified operation outcomes.
- **Order record:** source evidence, timeline, eligibility and allowlisted PayPal receipts at the exact selected snapshot.
- **Disputes:** observed case status and actual seller deadlines where available.
- **History:** durable financial/audit events, separate from native layout history.
- **Agents:** actual Coordinator, Investigator and Planner delegation, domain read/proposal tools, and built-in Widget/Page/Planning agents. Persisted conversation/tool events currently accompany a browser-driven harness; durable server agent execution is still planned.

The frozen fixture has 600 orders and a 63-order incident. Nine delivery updates revise the affected cohort to 54. Before recovery, targeted goodwill selects 38 refunds at $5, alongside 63 tracking assignments and four dispute responses: 105 actions across 63 orders. The alternative policy removes the 48-hour grace condition and proposes 50 refunds. Completed refunds retain their original receipt and exclude the same order from later ordinary goodwill.

## Provider and authorization boundaries

The immutable shared core is `@fracture/paypal-core` **0.2.7**, from `vendor/fracture-paypal-core-0.2.7.tgz`. Its embedded source/provenance accompanies the pinned APIMatic-generated `paypal` **2.29.0** SDK at Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. This is distinct from `@paypal/paypal-server-sdk`. [Integration evidence](docs/apimatic/integration.md) explains how the repository's TypeScript context skills were used.

Every write checks current SQL membership, original resource ownership, immutable approval, policy, expiry and a durable operation claim. The final provider POST rechecks authority. Independent provider reads establish the result; an ambiguous write retains its original identity and is never blindly resent. Sample records cannot authorize provider execution. Disputes use a typed fixed-sandbox REST adapter; the current agent tools use application reads. Actual PayPal Agent Toolkit transport is a remaining integration, so it is not presented as an executed capability.

## Current limits

This is a verified implementation checkpoint, not the full product release. Verified webhook ingestion/backfill, hosted durable agent jobs and scheduling, model comparisons, complete widget configuration/export, the full temporal/accessibility/performance corpus, broader commerce remedies and the bounded public judge tour remain in scope. No seller research, prevented-dispute or retained-revenue result is claimed. Provider tracking records an assignment; fulfillment fixtures supply delivery facts. Evidence submission records a seller response; current provider observations determine case status.

The repository is private. Private plans, credentials, operational evidence, local data and the build handoff remain excluded from Git.
