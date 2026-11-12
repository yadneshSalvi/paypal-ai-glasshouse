# Native agent query isolation

AG Studio 3.1 can return a successful query result while also raising fatal query-validation events. An actual model-generated aggregate expression exposed this behavior after the earlier conflicting-order guard. Executing that read in the report's engine made the visible workspace reject further save/history operations.

Agent queries now use a separate instance of the installed native Studio engine with the same current, authorized snapshot data. The durable server grant is still required. Fatal Studio events and engine-validation issues produce a recorded refusal with the original arguments. The temporary engine is destroyed afterward; the interactive report and its undo/redo history are not changed by a read. Other native tools retain their existing execution path.

Validation includes the exact two retained malformed queries, the original SDK false-success negative control, valid queries, three concurrent native reads, cancellation, unchanged data/history and usable report editing after refusal. Seven focused native/domain checks, four real PostgreSQL authority/claim tests and 22 related history/finding regressions passed, together with strict TypeScript and a production build.

An independent actual-model browser diagnostic attempted the exact aggregate-expression query once, recorded its refusal, and ran one corrected count-distinct query. The corrected query returned null; the model reported null rather than inventing zero. Adding a Text widget, undo, redo, save and reload all worked afterward. The retained original history has one undo entry. A 390-pixel layout has no page overflow. The isolated SDK still logs its original validation errors to the console; they remain visible diagnostics and do not block the report.

The diagnostic also exposed a separate instruction-scope issue: the Investigator's general workflow caused additional evidence reads and a private proposed finding despite the bounded request. That original outcome is retained and is not a scope-following pass. A separate instruction correction and its own validation are required before the next release.

No financial or payment-provider operation occurred in this diagnostic. Native behavior, synthetic Sample data, actual model responses and provider evidence remain distinct.
