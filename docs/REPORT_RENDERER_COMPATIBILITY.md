# Complete native report rendering

Native renderer `glasshouse-native-static-v2.1.0` pairs short fields in wide records and gives long excerpts and citation lists the full page width. Rows carry their index and identity across page breaks. All mapped values remain printed, and the complete immutable edition remains embedded as JSON. The 800-page and 32 MB bounds are unchanged.

The report service keeps the first completed compatible PDF as the edition's download. A renderer upgrade reads its original bytes and encryption identity. A failed older representation retains its own version, reason and attempt count while a new renderer uses a separate durable lease. A still-active older lease holds a competing render. Current membership and resource access are checked before rendering and again before disclosure.

The legacy v1 renderer is unchanged. An isolated synthetic edition produced identical A4 and Letter bytes through the original and corrected implementations. SQL regressions also verify unchanged cached bytes, preservation of failed attempts, the active-lease hold, and unchanged edition content.

The portable density regression sends 2,070 nine-field synthetic evidence records through the actual PDF renderer, including a long citation list continued across pages. It checks every emitted field, content boundaries and explicit page counts on both paper sizes. The existing report, v2 native and v3 native suites cover authority, immutable history, exact mapped rows, source corrections and caching.

A separate private check used the exact historical hosted edition that exposed the limit. Its 3,416 native rows across eight widgets rendered as 597 A4 pages and 656 Letter pages. Independent extraction matched every printed native field and the complete embedded edition. All 1,253 pages were rasterized and their page overviews reviewed; nine detailed pages covered evidence continuations, policy rows, region counts, unknown deadlines, records and provenance. Hosted corrected-download and root browser acceptance are separate release gates.

Run the bounded renderer regressions with:

```sh
node --import tsx --test tests/reports-pdf-density.test.ts tests/reports-pdf.test.ts tests/reports.test.ts tests/instruments-report.test.ts tests/instruments-v3-report.test.ts
```
