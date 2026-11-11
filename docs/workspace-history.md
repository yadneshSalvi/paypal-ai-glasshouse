# Workspace history and recovery

Manual saves, native edits and successful agent tools share one ordered writer. Saving starts only after the complete current report and its undo/redo states have been admitted. Agent telemetry cannot bypass this gate. The writer freezes each pending value so a later edit cannot change an already queued request.

Each saved report carries a server version. An exact replay can recover a lost response once; an older tab cannot overwrite a newer version. Current membership is checked while locked in the save transaction. Viewers can read reports but cannot save edits. The report and its audit record commit together.

If a save is unresolved, later local edits remain in the browser. The recovery panel offers retry of the original save, JSON export of the current local report, and reload of the latest saved version. Reload does not merge a conflicting draft; export it first if it is needed. The exported file contains the report configuration and full native history, not financial credentials.

Restoration compares complete current and historical states as well as entry identities. A redo entry may select a widget absent from the current report, so that precise reference is validated against its own historical page. Other native schema failures still hold saving. History is never silently truncated: the server accepts at most 500 entries, 50 pages and 200 widgets per page within the existing request-size limit.

AG Studio 3.1 fills an unconfigured widget's absent `dataMapping` with an empty object, and a later admission can fill required mapping slots with empty arrays. The guard accepts those precise representations of no mapped fields at the widget mapping path. Nonempty field references, aggregation, formatting and every other state value remain part of the comparison. Entry IDs, timestamps, label keys/variables, focus and source metadata must also match; only the native engine's translated display label is excluded. The saved entries and original mutation receipts are never rewritten by this equivalence check.

Regression tests run the actual installed Studio engine through add/configure, JSON reload with two undo entries, both undos, a second JSON reload with two redo entries, and both redos. They also prove that nonempty mapping, formatting and entry identity changes still hold saving. The original live reload failure is retained in [the actual agent qualification](evidence/agents-live-qualification.json); the corrected browser check must reuse that same saved history.

Validation and disclosed failed attempts are recorded in [the qualification artifact](evidence/history-persistence-qualification.json).
