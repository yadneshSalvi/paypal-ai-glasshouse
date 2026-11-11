# Private workspaces and immutable reports

This source unit lets a member choose the right incident room, manage precise private access, and preserve an attributable edition of the evidence behind a decision. It is implemented, locally and natively qualified, and deployed in `a182422` after additive schemas 8/9, a verified backup and complete original-row comparison. The [hosted qualification](evidence/workspaces-reports-hosted-qualification.json) records the integration-owner acceptance and preserved original authority. No provider or model call is needed to use the new Sample workspace and report flows.

## Access and continuity

**Workspaces** opens a directory grouped by organization. A display name describes a browser capability; it is not verified human or email identity. An access family retains the original session expiry. Admission and switching never rewrite an existing actor, session, judge grant, membership version or financial resource. Returning selects the exact original session token. The selected context is checked in the browser and inside server transactions, so an old tab cannot act under a newly selected workspace.

Organization ownership and workspace roles are separate. Owners can manage organization membership and create additional Sample rooms. Workspace roles are owner, operator, investigator, viewer and the existing judge role. Existing judge grants cannot be edited through organization administration and can share only investigator/viewer access. Last-owner changes serialize; an organization cannot silently become ownerless. Revoking organization membership revokes that person's workspace memberships in that organization. Restoring organization membership does not restore those roles.

**Manage → Create private link** issues an expiring, single-acceptance invitation for an exact role. The token is in the URL fragment and is submitted only to the private acceptance route; it is not placed in page metadata or model prompts. Its issuer's current membership/version is rechecked. Server token material is encrypted, with keyed object identity and token hashes for lookup. Creating or copying a link does not send it to anyone. A new browser access lasts at most seven days; joining from an existing family does not extend that family's lifetime.

Workspace administration and report creation use durable request UUIDs. A lost response can recover the original result. A superseded workspace switch cannot move the selection backwards. The recovery UI can retain an unresolved request as held; that action does not assert failure or resubmit it. New invitations do not quietly downgrade an already-active member.

Archiving preserves readable evidence and holds new work. Active native investigations, queued/running source reads, active reporting and pending financial outcomes prevent archive. Old proposal, layout, payment, observation, reporting, dispute and agent entry points retain current membership and workspace checks. Already-dispatched receipts remain evidence; switching or revocation does not erase them.

Every newly created room uses the disclosed Fernwood Sample fixture. A merchant display name is a label, not a provider account connection. New rooms receive no original capture/order grants, vault authorizations, provider credentials or payment commands.

## One immutable edition

**Saved reports → Create an edition** first saves the current native history, then submits its exact revision/hash together with the admitted snapshot hash and up to ten selected recovery plans. A competing native save or changed source snapshot holds creation. The server captures one repeatable-read transaction and verifies current authority, snapshot reconstruction, native history, manifest hashes, distinct action/operation identities and included provider ownership.

An edition contains:

- The exact snapshot, event time T, knowledge cutoff K, table hashes, source labels and generation time.
- All six static semantic instruments, their denominators and explicit unknown values.
- Exact saved native configuration, filters, custom chart mappings, current state and undo/redo entries.
- Selected immutable recovery manifests, every eligibility/exclusion row, exact action/operation identity, amount, policy, source and approval state at capture.
- The creating member's verified findings for this exact snapshot, with source hashes, evidence clocks and counterpoints. Private conversations and hidden model reasoning are excluded.
- Safe observed operation/case projections and a separate workspace audit. Later observations do not rewrite the earlier T/K snapshot.

The whole admitted snapshot drives the six static instruments. They do not silently claim to reproduce every custom native chart or filter; those exact settings remain in the canonical JSON. Supporting and counterpoint source IDs are complete there. The printed evidence section cites each displayed source record and its clocks; the manifest appendix prints every action/operation identity and eligibility row.

Editions are encrypted at rest, hashed and protected by a database trigger against update/delete. A correction creates a new edition, optionally linked to an earlier one. A current workspace member can read saved editions; a viewer cannot create one. Included provider grants and bound-case ownership are rechecked at each list, read and download. A foreign object remains unavailable. There is no public report capability URL.

## Six static instruments

| Instrument | Preserved meaning |
|---|---|
| Commerce River | Inventory counts each order once at T/K; transition counts use their separate state-change grain. |
| Time Dial | T, K, clock domain, generation and observation times remain distinct. Replaying time does not execute a payment. |
| Evidence Lens | Source excerpts, detector denominators, hypotheses and counterpoints; quoted instructions remain untrusted evidence. |
| Recovery Branches | Deterministic policy comparison, exact costs/caps and exclusion checks; a no-grace comparison grants no override. |
| Regional Impact | Coarse regions on a common scale with late/due and baseline denominators; an empty denominator is unknown. |
| Deadline Strip | Only independently saved provider deadlines are verified. Sample dates remain unknown; evidence submission is not case resolution. |

The reader provides searchable, paginated source, manifest, operation, history and audit tables. A4 and Letter downloads use actual PDFKit with bundled OFL Noto fonts, vector marks and text. They require no browser renderer, external URL, image fetch, model or payment API. The full immutable JSON is attached to the PDF as `glasshouse-edition.json`, and can also be downloaded independently.

PDF work uses a durable per-edition/paper/renderer lease. Concurrent requests do not duplicate an active render; the exact completed bytes are encrypted and reused. Membership/context/resource changes during rendering prevent disclosure while preserving the original artifact. A local render failure leaves the unchanged reader and JSON available. Complete JSON is bounded to 24 MB; PDF output to 32 MB/200 pages. Unsupported font glyphs or an oversized indivisible row fail clearly instead of dropping source text. PDF/UA tagging and wider script coverage are not claimed; the semantic HTML reader is the accessible representation.

## Storage and migration

Use stable 32-byte base64 keys. `GLASSHOUSE_WORKSPACE_KEY` and `GLASSHOUSE_REPORT_KEY` each fall back to the established `GLASSHOUSE_PAYMENT_KEY`, using distinct authenticated cipher domains. `GLASSHOUSE_AGENT_KEY` retains its existing fallback. Do not replace a chosen key after admission; a rotation needs its own verified migration. No key is sent to the browser.

Schema 8 adds nine private directory/access tables; schema 9 adds immutable editions and encrypted PDF representations. These migrations do not rewrite original sessions, memberships, provider grants, financial receipts, native layouts or agent evidence. They require schema 7. Application requests hold on missing migration rather than performing the cutover implicitly.

For a **dedicated new local database**, configure `.env` and run:

```sh
GLASSHOUSE_AGENT_MIGRATION_CONFIRM=schema7-and-private-agent-documents node --import tsx --env-file=.env scripts/agents-migrate.ts
GLASSHOUSE_WORKSPACE_MIGRATION_CONFIRM=schema8-private-workspaces node --import tsx --env-file=.env scripts/workspaces-migrate.ts
GLASSHOUSE_REPORT_MIGRATION_CONFIRM=schema9-immutable-reports node --import tsx --env-file=.env scripts/reports-migrate.ts
npm run dev
```

For an existing hosted database, the deployment owner must first retain a verified backup, preserve the established encryption keys, apply the additive migrations and compare original row/document identities and content before promotion. This source lead did not run hosted migrations or change the deployed release. The migration confirmation values describe explicit operator intent; they are not credentials.

## Qualification and native acceptance

The [local qualification record](evidence/workspaces-reports-local-qualification.json) records 188 passing regression tests, 19 workspace and 19 report checks on actual PostgreSQL, 25 local HTTP checks over 43 requests, and visual inspection of 66 final PDF pages. Type checking and the production build pass. The isolated suite exercises actual PostgreSQL transactions, installed AG Studio native history and the actual local PDF renderer. Model and payment transports remain disabled or explicit synthetic fixtures. Tests cover original authority preservation, switch/response races, invitation expiry/replay/issuer revocation, role changes, last-owner concurrency, archive holds, old mutation routes, immutable report/source/layout contracts, resource revocation, encryption failures, response disclosure and PDF leases/content/layout. Earlier failing results are retained; successful retries do not overwrite them.

The integration owner completed the following native journeys locally, followed by 25 hosted checks over 43 requests, corrected hosted keyboard/mobile acceptance and production original-workspace continuity. The original 289,000 rows and 22 financial/model tables remain unchanged. These journeys remain the protocol for a future release:

1. Open the directory and access details. Create an organization and a clearly named Sample room; switch between rooms and reload. Preserve each native layout, proposal set and original session expiry. A second stale tab must hold before reading or writing another room.
2. Use a separate browser context to accept a viewer invitation; exercise expiry, reuse, revocation and a lower-role link against an existing member. Verify viewer reads and denied mutation controls, original judge-role protection and last-owner errors. Creating/copying a link sends no message.
3. In a fresh Sample room, keep the initial 63 affected orders, prepare an **unapproved** targeted plan (47 refunds/$235, 114 total actions, 63 eligibility rows), and create an edition with a saved native change. Read all six instruments, source citations, current unknown deadlines, full manifest and separate native/audit histories.
4. Download A4, Letter and JSON; compare the edition hash, full embedded JSON and all 114 distinct action plus operation identities. Repeated downloads return the same representation hash. Make nine delivery corrections only in this isolated Sample room, create a linked new edition, and confirm the previous 63-order edition remains unchanged while the current cohort is 54.
5. Archive a quiescent room: saved reader/JSON/PDF stay readable, new work is held, and restoration preserves its history. Revoke an invited member during a delayed download and verify its response is denied.
6. Review desktop, 390 px and 360 px layouts, table scrolling, keyboard navigation, Escape/focus return, reduced motion, reload and held/error states. Root native acceptance covers these browser results; the source lead’s local tests remain separately attributed.

Verified external login, additional real merchant connectors, finding review/supersession, broader commerce/evaluation/research/judge/film work and exact static parity for arbitrary native mappings remain in the [full delivery ledger](remaining-scope.md). The existing Toolkit dependency risk assessment remains [separately documented](agents-dependencies.md); this unit adds no Toolkit write surface.
