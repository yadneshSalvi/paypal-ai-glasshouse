# Workspace history and recovery

Manual saves, native edits and successful agent tools share one ordered writer. Saving starts only after the complete current report and its undo/redo states have been admitted. Agent telemetry cannot bypass this gate. The writer freezes each pending value so a later edit cannot change an already queued request.

Each saved report carries a server version. An exact replay can recover a lost response once; an older tab cannot overwrite a newer version. Current membership is checked while locked in the save transaction. Viewers can read reports but cannot save edits. The report and its audit record commit together.

If a save is unresolved, later local edits remain in the browser. The recovery panel offers retry of the original save, JSON export of the current local report, and reload of the latest saved version. Reload does not merge a conflicting draft; export it first if it is needed. The exported file contains the report configuration and full native history, not financial credentials.

Restoration compares complete current and historical states as well as entry identities. A redo entry may select a widget absent from the current report, so that precise reference is validated against its own historical page. Other native schema failures still hold saving. History is never silently truncated: the server accepts at most 500 entries, 50 pages and 200 widgets per page within the existing request-size limit.

Validation and disclosed failed attempts are recorded in [the qualification artifact](evidence/history-persistence-qualification.json).
