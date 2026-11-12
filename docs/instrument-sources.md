# Native instruments and admitted sources

The six custom instruments use the installed AG Studio query and selection state. River and Map selections retain their intended category across either selection order; their original denominators remain visible beside selected records. Evidence and case controls select linked orders. Time Dial changes the source clock and retains its full timeline scope. Unsupported mapping/clock combinations report that limitation rather than inventing a value.

New `commerce-semantic-v3` snapshots admit twelve source tables and retain separate order, line, capture, refund and shipment grains. Earlier v1/v2 snapshots keep their original hashes. Currency changes reconstruct one complete source revision before admitting it; they do not relabel another currency's totals. Goodwill and its cap are USD-only. Unknown deadlines remain unknown, with explicit inclusion controls.

Schema 11 adds append-only commerce observations and member-owned instrument source selections. Apply it only after the existing schema 10 migration, against the intended dedicated database with a verified backup. This explicit command does not seed data or replay financial actions:

```sh
GLASSHOUSE_INSTRUMENT_MIGRATION_CONFIRM=schema11-multiresource-observations \
  node --env-file=.env --import tsx scripts/instruments-migrate.ts
```

Saved editions retain exact native mappings, supported filters, selected records and original denominators. The JSON contains the complete source and report history. The [native PDF renderer](REPORT_RENDERER_COMPATIBILITY.md) prints every mapped value and embeds that same immutable edition; it keeps earlier completed PDF bytes and failed attempts under their original renderer identities.

The [hosted qualification](evidence/instruments-hosted-qualification.json) identifies the accepted source, schema and deployment. It separates local reference/library controls, browser observations, historical sandbox records and current read-only continuity. No new provider, model or financial operation was required for this release. Anonymous page entry still creates a separate Sample workspace; explicit-start entry is a retained follow-up, not an implemented claim.
