# Glasshouse

A commerce incident room for Fernwood Coffee. Follow a signal through source evidence, reconstruct what was known at a point in time, and review an exact recovery manifest before authorizing it.

**Rewind the business. Review the evidence. Approve the exact remedy.**

[Open Glasshouse](https://paypal-ai-glasshouse.vercel.app) · [Read the submission story and evidence](docs/submission-story.md). The qualified live application remains source `6bd66c6`; the 2:50 film clearly labels its separately retained native and Sandbox chapters.

The application uses Next.js, React, PostgreSQL and six native AG Studio 3.1.0 instruments. Its actual Studio Agent Framework delegates investigation and chart creation through a server-side OpenAI adapter, with durable model/tool checkpoints, encrypted native history, sourced findings and owned PayPal Toolkit reads. The current source also adds private organizations and workspaces, precise access invitations, immutable finding reviews and source-driven plan invalidation, and immutable reports with six static instruments, exact JSON and downloadable A4/Letter PDFs. Payment, fulfillment, remediation and dispute state remain separate.

The controlled sandbox run completed **600 captures totaling $27,600**, then **38 refunds totaling $190, 63 tracking assignments and four dispute evidence submissions**. A separate read of every recovery result confirmed all **105 original operations** at 2026-11-11 00:39:35 UTC. Shipping and support are explicitly synthetic fixtures; the four cases remained open, awaiting buyer response. See [the dated checkpoint](docs/evidence/checkpoint-2026-11-11.md) for evidence boundaries and validation.

## Run locally

Use Node 22 or later:

```sh
cp .env.example .env
npm ci
```

Set `DATABASE_URL` to a dedicated PostgreSQL database and configure stable private storage keys. Apply the explicit schemas 7, 8 and 9 migrations described in [workspace and report setup](docs/workspaces-and-reports.md), followed by the additive [schema 10 finding lifecycle](docs/finding-lifecycle.md) and [schema 11 instrument sources](docs/instrument-sources.md), then run `npm run dev` and open **http://localhost:4103**. A missing migration holds access instead of rewriting old sessions during a request. Embedded PostgreSQL is used by the isolated unit-test harness; the full workspace migration path uses explicit PostgreSQL.

Each new browser session receives an isolated, durable Sample workspace. Its display name is self-declared browser access, not verified human or email identity. Set `AG_STUDIO_LICENSE_KEY` to your valid Studio license; live AI uses the server-side `OPENAI_API_KEY` and a persistent base64 32-byte `GLASSHOUSE_AGENT_KEY` (or the existing payment-key fallback). Preserve the key for saved investigations. No credential belongs in a `NEXT_PUBLIC_` variable.

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
- **Workspaces:** choose an incident room, manage an organization, create a separate Sample workspace, or grant/revoke exact member roles. Switching preserves the original workspace session and holds stale tabs. A workspace never inherits another merchant's provider credentials or financial resources.
- **Findings:** inspect private and explicitly shared interpretations, compare sources and exact scope changes, record support/challenges/revisions/retraction, and review affected recovery drafts. Every new financial boundary checks the selected exact versions again.
- **Saved reports:** freeze an attributable edition of one admitted snapshot and saved native revision, optionally with exact recovery manifests. Read the saved native views with exact supported mappings and filters, source evidence, observed outcomes and separate histories; unsupported adapters are stated explicitly. Current v3 regional history preserves separate original/selected counts and historical reference denominators. Download JSON or an A4/Letter PDF with the full edition embedded. Current workspace membership and included provider grants are checked on every disclosure.

The initial Sample fixture has 600 orders and a 63-order incident. Its targeted proposal selects 47 refunds at $5; the no-grace comparison selects 59. Nine delivery updates revise the affected cohort to 54. In the separately qualified original controlled scenario, targeted goodwill selected 38 refunds at $5, alongside 63 tracking assignments and four dispute responses: 105 actions. A comparison that removes the grace period grants no policy override. Completed refunds retain their original receipt and exclude the same order from later ordinary goodwill.

## Provider and authorization boundaries

The immutable shared core is `@fracture/paypal-core` **0.2.7**, from `vendor/fracture-paypal-core-0.2.7.tgz`. Its embedded source/provenance accompanies the pinned APIMatic-generated `paypal` **2.29.0** SDK at Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. This is distinct from `@paypal/paypal-server-sdk`. [Integration evidence](docs/apimatic/integration.md) explains how the repository's TypeScript context skills were used.

Every write checks current SQL membership, original resource ownership, immutable approval, policy, expiry and a durable operation claim. The final provider POST rechecks authority. Independent provider reads establish the result; an ambiguous write retains its original identity and is never blindly resent. Sample records cannot authorize provider execution. Disputes use a typed fixed-sandbox REST adapter.

The installed PayPal Agent Toolkit **1.11.0** has four server-scoped read tools, guarded by current tenant/resource ownership and independent wire validation. The [corrected actual 4/4 read qualification](docs/evidence/toolkit-live-correction.json) retains the earlier summary-shape rejection and independently verifies case-to-capture binding. Reads default off in new configuration and are enabled in the qualified hosted agent release; every Toolkit write remains disabled. [Agent contracts and migration](docs/agents.md) explain exact-ID recovery, encrypted legacy history, native mutation receipts and deployment gates. [Dependency risks](docs/agents-dependencies.md) records the remaining audit findings.

The [isolated agent qualification record](docs/evidence/agents-runtime-qualification.json) records its original controlled tests, separate from actual-provider evidence. The [hosted agent qualification](docs/evidence/agents-hosted-qualification.json) records 15 HTTP checks, a real three-response Sample investigation, encryption migration continuity and preservation of original financial data. The newer organization/report unit has its own [contract and qualification boundary](docs/workspaces-and-reports.md). The later [finding/query-safety release](docs/evidence/query-safety-hosted-qualification.json) retains those earlier measurements separately.

## Reporting coverage

Open **Fernwood Coffee → source and clock ledger → Reporting** to read a past UTC window. The installed APIMatic SDK requests one transaction-info page at a time, saves its cursor, and links only already-owned capture/refund IDs. Work continues through the authenticated reporting cron; stopped scans retain their collected pages. A changed merchant, revoked operator, changed resource scope, changed pagination metadata, or a truncated result cannot be labelled complete.

The evidence table shows original resource/order identities, signed amounts, provider status, update time, and observation time. Reporting never creates a payment, retries a financial action, or replaces an independently verified receipt. The denominator counts all workspace-owned resources; resources outside the selected dates need not appear. PayPal documents reporting lag of up to three hours, but the observed refresh timestamp is shown without assuming that service level was met. See [reporting implementation and verification](docs/reporting.md).

## Current limits

This is an implementation checkpoint, not the full product release. The instrument and complete native PDF release is deployed from **6bd66c6**, after root browser acceptance, a verified backup, additive schema 11 and exact original-data continuity; see the [hosted qualification](docs/evidence/instruments-hosted-qualification.json). The six native instruments, v3 resource grains, supported mapping/filter exports and complete A4/Letter records are qualified within the recorded corpus. Verified external login, additional actual merchant connections, authenticated webhooks, model comparisons, remaining unsupported native mappings, the full temporal/accessibility/performance corpus, broader commerce remedies and the bounded public judge tour remain in scope. Anonymous entry still creates a Sample workspace automatically; an inert entry with an explicit start action is a separate follow-up. The [full delivery ledger](docs/remaining-scope.md) keeps those obligations explicit. No seller research, prevented-dispute or retained-revenue result is claimed. Provider tracking records an assignment; fulfillment fixtures supply delivery facts. Evidence submission records a seller response; current provider observations determine case status.

The repository is private. Private plans, credentials, operational evidence, local data and the build handoff remain excluded from Git.

[Finding lifecycle and migration](docs/finding-lifecycle.md) describes private immutable versions, source-driven 63→54 correction, exact affected plans, current dependency checks and unchanged earlier report downloads. Isolated PostgreSQL, HTTP and DOM checks do not substitute for actual provider/model or native-browser qualification.
