# Chunked PDF Rendering — Implementation Plan

## The Problem

Chrome's `Page.printToPDF` is atomic — there is no pause/resume API. When rendering a very large continuous HTML table to PDF, Chrome builds the entire document tree, paginates it, and constructs a PDF cross-reference (xref) table in memory. For large documents this can exceed **10 GB of RAM**. The xref table and internal PDF index cannot be disabled via any Chrome flag or Puppeteer API.

## Current State (as of v1.5.0)

We have a working **single-pass adaptive chunked renderer** (`renderChunkedPdf` in `server.js`):

1. **Discovery** — Loads the HTML, counts non-`<thead>` table rows. Closes page immediately.
2. **Calibration** — Renders a small sample (default 20 rows, `?sampleRows=N`) to a tiny PDF. Counts PDF pages produced. Derives `rowsPerPage`.
3. **Adaptive chunking with try-and-retry**:
   - Attempts to render `rowsPerPage × targetPages` rows.
   - Counts resulting PDF pages.
   - If pages exceed `targetPages` → **discards** the PDF, halves the row count, retries (up to 8 halvings).
   - If pages fit → **accepts** the chunk. Updates `rowsPerPage` estimate from actual results so the next chunk adapts (handles transitions between thin and tall rows).
   - For non-final chunks, drops the last PDF page (likely partial). The next chunk re-renders those rows at the top of a fresh page for clean seams.
4. **Merge** — Stitches all chunk PDFs together using `pdf-lib`.

### What works

- ✅ Variable row heights (adaptive retry handles tall/thin transitions)
- ✅ `<thead>` preserved in every chunk (column headers repeat)
- ✅ Headers and footers (`displayHeaderFooter`, `headerTemplate`, `footerTemplate`) appear on every page of every chunk
- ✅ Margins, page size, landscape mode all passed through
- ✅ Falls back to element-based chunking if HTML uses `<div class="page">` instead of tables
- ✅ Peak memory proportional to chunk size, not total document size

### What doesn't work

- ❌ **Global page numbering** — Chromium's `<span class="pageNumber">` and `<span class="totalPages">` are per-chunk. Chunk 1 says "Page 1 of 5", chunk 2 says "Page 1 of 4", etc.

## Proposed Enhancement: Two-Pass Chunked Rendering

### Concept

Render the document in two passes, both chunked (so memory stays low):

- **Pass 1 (dry run)** — Run the full adaptive chunking algorithm. Record the metadata but **discard the PDF buffers**.
- **Pass 2 (final render)** — Re-render each chunk with corrected header/footer templates containing the real global page numbers.

### Pass 1: Discovery & Calibration

Run the existing adaptive chunking loop, but instead of collecting PDF buffers for the final merge, collect only:

```
chunkPlan = [
  { startRow: 0,    endRow: 120,  pdfPageCount: 9  },
  { startRow: 120,  endRow: 235,  pdfPageCount: 10 },
  { startRow: 235,  endRow: 400,  pdfPageCount: 10 },
  { startRow: 400,  endRow: 500,  pdfPageCount: 7  },  // final chunk
]
```

From this we derive:
- **Global total pages** = sum of all `pdfPageCount` values (e.g. 36)
- **Per-chunk starting page number** = cumulative sum of previous chunks' page counts + 1
- **Exact row ranges** — already validated by the retry loop, no wasted attempts in Pass 2

### Pass 2: Final Render

For each entry in `chunkPlan`:

1. **Modify the header/footer templates** before rendering:
   - Replace `<span class="totalPages"></span>` with the actual global total (e.g. `<span>36</span>`)
   - Inject a CSS counter offset or use JavaScript so `<span class="pageNumber"></span>` starts at the correct global page number for this chunk (note: Chromium doesn't support counter offsets for `pageNumber` — see implementation options below)
2. Render the chunk with the corrected templates
3. Collect the PDF buffer

Then merge all chunk PDFs with `pdf-lib` as before.

### Handling `pageNumber` — Implementation Options

Chromium's `pageNumber` class always starts at 1 per document. Options to fix this:

#### Option A: Post-merge stamping with pdf-lib (recommended)
- In Pass 2, render chunks **without** `pageNumber`/`totalPages` spans in the template
- After merging, iterate over every page in the merged PDF using `pdf-lib`
- Stamp "Page X of Y" at the correct position on each page
- **Pro**: Correct numbers guaranteed. Single source of truth.
- **Con**: Need to match font/size/position. Requires knowing where in the header/footer the text should go. May need caller to specify positioning.

#### Option B: Template string replacement per chunk
- Before rendering each chunk in Pass 2, do a string replacement in the header/footer HTML:
  - Replace `<span class="totalPages"></span>` → `<span>36</span>`
  - Replace `<span class="pageNumber"></span>` → inject a small `<style>` + `<script>` or CSS counter that starts at the chunk's global offset
- **Problem**: Chromium's `pageNumber` is injected by the print pipeline *after* CSS/JS runs, so you can't override it with CSS counters. You'd have to remove the class and use a different mechanism.
- **Practical approach**: Replace the `pageNumber` span with a hardcoded starting number and use CSS `counter-increment` to advance it. This works because CSS counters *do* work in header/footer templates:
  ```html
  <style>
    #pg { counter-reset: page-num 14; } /* start at chunk's global offset */
    .pageNum::before { counter-increment: page-num; content: counter(page-num); }
  </style>
  <div id="pg"><span class="pageNum"></span> of 36</div>
  ```
- **Pro**: No post-processing needed. Pure CSS solution.
- **Con**: Caller's header/footer template must follow this convention, or we need to parse/transform their template.

#### Option C: Accept per-chunk numbering, document the limitation
- Don't fix it. Document that `?chunked=true` produces per-chunk page numbers.
- **Pro**: Zero complexity.
- **Con**: Page numbers are wrong.

### Recommended Approach

**Option B (CSS counter replacement)** for `pageNumber`, **simple string replacement** for `totalPages`. This keeps everything inside the Chrome render pipeline with no post-processing. The implementation would:

1. Before Pass 2 rendering, scan the header/footer template for `class="totalPages"` and `class="pageNumber"`
2. Replace `totalPages` spans with the actual global count
3. Replace `pageNumber` spans with a CSS counter initialized to the chunk's starting page offset
4. If neither class is found, skip the template modification (no-op — backward compatible)

### Refactoring Plan

The `renderChunkedPdf` function should be split into three phases:

```
async function renderChunkedPdf(browser, bodyHtml, pdfOptions, targetPages, sampleRows, renderID) {
    // Phase 1: Discovery (count rows, detect mode)
    const docInfo = await discoverDocument(browser, bodyHtml, renderID);

    // Phase 2: Plan (adaptive chunking dry run — determines row ranges and page counts)
    const chunkPlan = await buildChunkPlan(browser, bodyHtml, pdfOptions, docInfo, targetPages, sampleRows, renderID);

    // Phase 3: Render (re-render each chunk with corrected templates, merge)
    return await executeChunkPlan(browser, bodyHtml, pdfOptions, chunkPlan, renderID);
}
```

### Query Parameters (unchanged)

| Parameter | Default | Description |
|---|---|---|
| `chunked` | `false` | Set to `true` to enable chunked rendering |
| `chunkPages` | `10` | Target max PDF pages per chunk |
| `sampleRows` | `20` | Rows for initial calibration |

### Trade-offs

| Aspect | Two-pass chunked | Current single-pass |
|---|---|---|
| **Peak memory** | Low (same as current) | Low |
| **Render time** | ~2× current | 1× |
| **Page numbers** | ✅ Globally correct | ❌ Per-chunk |
| **Retry waste** | None in Pass 2 (row ranges pre-validated) | Retries discard and re-render |
| **Complexity** | Moderate (template manipulation) | Current level |

### Files to Modify

- `server.js` — Refactor `renderChunkedPdf` into three phases; add template manipulation helpers
- `docs/changelog.md` — Document the two-pass feature
- `package.json` — No new dependencies needed (`pdf-lib` already installed)

