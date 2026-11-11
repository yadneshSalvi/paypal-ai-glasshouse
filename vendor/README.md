# Pinned payment core

`fracture-paypal-core-0.2.7.tgz` is the immutable MIT-licensed `@fracture/paypal-core` release used by this application. SHA-256:

```text
a2ccc98af5da871e3c057bcdc142c303d0d1d2f2fa9a9a42324d566177fa1061
```

The archive includes its source, license, package declarations and `PROVENANCE.json`, which records the pinned APIMatic SDK and source hashes. This release passed 148 PostgreSQL, SQLite and SDK/REST fixture tests plus package typecheck/build. These conformance results are separate from Glasshouse's actual sandbox evidence.

Version 0.2.7 adds recovery of one exact persisted operation. Glasshouse calls it with the original domain operation identity; recovery never enumerates a neighbouring payment or resends an unknown write. The consuming application remains responsible for current domain authority.

Older supplied archives stay local and ignored. An upgrade requires a new immutable archive, verified provenance and explicit package/lockfile changes.
