# Agent dependency review — 11 November 2026

The new integration pins `@paypal/agent-toolkit` **1.11.0**, Axios **1.21.1**, Ajv **8.20.0**, and retains OpenAI **7.55.0**. The shared `@fracture/paypal-core` **0.2.7** archive and its hash are unchanged. The Toolkit's public OpenAI entry point is the only Toolkit adapter imported at runtime.

`npm audit` after installation reported 12 affected packages (11 high, one moderate). A scoped override upgrades Toolkit's loaded `mathjs` dependency to **15.2.0**, removing its reported expression-parser advisory. The [maintainer advisory](https://github.com/advisories/GHSA-29qv-4j9f-fjw5) identifies 15.2.0 as patched. The four installed Toolkit reads are retested with that override.

The resulting audit still reports **11 affected packages: ten high and one moderate**. This is not an audit-clean dependency tree.

| Residual packages | Observed reachability and current control |
|---|---|
| Toolkit's Zod 3.25.76 | Loaded to construct static tool schemas and run the bundled JSON-schema converter. The selected `handleToolCall` implementation does not parse external input through Zod 3. Glasshouse independently validates bounded canonical arguments using root Zod **4.6.7** and Ajv before allowing any native call. Replacing Zod 3 with 4 breaks the Toolkit's current converter contract and is not an accepted blind override. |
| `@langchain/core`, `langsmith`, `uuid` | Installed by Toolkit, but not loaded by its public OpenAI entry point in the measured process. The LangChain adapter is not imported or exposed. Its serialization, tracing, and UUID advisories remain unresolved in the dependency tree. |
| `ai`, `@ai-sdk/provider-utils`, `@ai-sdk/react`, `@ai-sdk/ui-utils`, `jsondiffpatch` | Installed optional-adapter dependencies, but not loaded by the selected entry point. Glasshouse does not expose the Toolkit's Vercel AI adapter, attachment handling, or JSON diff/HTML formatting surfaces. |
| Toolkit's nested OpenAI 4.x | Not loaded by this entry point; its reference is a type import in the packaged code. Actual Glasshouse model requests use root OpenAI 7.55.0. The audit's inherited Zod finding remains. |
| `@paypal/agent-toolkit` | Audit aggregation remains high because of the above dependencies. Four narrowly registered reads are the only exposed capability; live enablement remains a separate gate. |

The [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) concerns memory exhaustion while validating large collections; 4.6.6 is the patched release. Current bounds include the HTTP body, model input, native tool inventory/schema, strict domain parameters, and a 1 MiB Toolkit response limit. These controls and the measured module-loading boundary reduce exposure in this integration; they do not patch the upstream packages or establish safety for other Toolkit adapters.

A process loading the actual public entry point and its exact read inventory observed `mathjs` and Zod 3 loaded; LangChain, LangSmith, Vercel AI, jsondiffpatch, and the nested OpenAI SDK were absent from the CommonJS module cache. The inventory check made no network call. The execution tests use explicit synthetic transport and exercise actual Toolkit serialization for all four admitted reads.

Before enabling additional adapters or any Toolkit write, repeat dependency/reachability review, upgrade affected dependencies through a compatible supported version, and qualify the exact transport, authority, request identity and ambiguous-outcome behavior. `npm audit fix --force` currently proposes a Toolkit downgrade; it is not a verified remediation for this contract. Toolkit source and inventory are maintained in [PayPal's official repository](https://github.com/paypal/agent-toolkit).
