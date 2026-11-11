# Observation checkpoint — 11 November 2026

Glasshouse now has authenticated notification intake, durable independent reads and **Check status** for original recovery actions. This checkpoint qualifies the implementation with fixtures and an isolated native-browser review. Actual signed delivery through the deployed receiver, hosted restart/retry and scheduler qualification remain pending.

## Automated evidence

The full application suite passed **82 tests, zero failures**, including 19 observation cases. Typecheck and an optimized Next.js production build passed. Builds used a separate source copy without private environment files or original data. The pinned shared core remains 0.2.7 without changes.

Tests exercise exact JSON signature postback, fixed sandbox verification destinations, encrypted receipts, atomic inbox/outbox commits, duplicate/conflicting event identities, wrong merchant and tenant scope, before-acknowledgement delivery, corrupted queue hints, revoked connector binding, worker lease recovery, pending/exhausted reads, and original-operation reconciliation after approval or membership changes. Instrumented transports establish that the observation path sends no commercial POST.

Refund tests join complete inventories and later original receipts by identity, reserve pending amounts without booking completed money, advance freshness on unchanged reads and append a new fact when a previous balance recurs. Case tests keep stale observations from regressing current evidence and require current, permitted, unfulfilled seller requests for new proposals. Earlier knowledge-cutoff hashes and completed receipt bodies remain unchanged.

## Native-browser evidence

The integration owner reviewed a separate local workspace with an explicit fixture banner, its own in-memory SQL store and session cookie. Provider credentials were fake, external server transport was blocked, and fixture business writes were disabled after setup. These observations are UI/contract evidence, not additional PayPal transactions:

- **Check status** independently checked all four saved fixture actions. The case showed awaiting buyer response, original evidence present and no reported resolution.
- **Use latest evidence** advanced the fixture finding from revision 11 to 13 and reduced outstanding tracking proposals from one to zero. The original completed manifest stayed unchanged.
- Notification health showed two authenticated fixture deliveries, one completed independent read and one joined duplicate. Disabling the current connector changed the badge to **Awaiting connection** while retaining those historical counts; restoring it returned **Verified delivery**.
- At 360px, document and dialog widths were both 360px without horizontal overflow. Desktop-to-mobile and mobile-to-desktop resize journeys returned focus to the visible workspace-source button when the source dialog closed.
- Independent before/after inspection found mock payment writes unchanged at 11, mock evidence submissions unchanged at one, and identical original receipt bodies. No fixture restart was needed for the review.
- HTTP boundary checks returned 401 for an unauthenticated overview, 403 for a foreign-origin status request and 401 for an unauthenticated scheduler request.

## Evidence boundaries and next work

The original **600 actual captures/$27,600 and 105 actual recovery results** remain those documented in the [financial checkpoint](checkpoint-2026-11-11.md). The fixture and browser checks did not repeat them or call PayPal. Original case evidence submission remains separate from case resolution.

The [observation runbook](../observations.md) describes deployment binding and bounded read-only drains. Stable registration alone does not qualify receipt of a real signed event. Scoped Transaction Search backfill, reporting-lag measurements, durable agent/Toolkit work, complete widget configuration/export, the full temporal/accessibility/performance corpus, hosted operational qualification and all remaining full-product gates are still required.
