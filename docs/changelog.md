# Changelog

## v1.5.0

* perf: Reuse a single shared browser instance instead of launching a new Chrome process per request – eliminates the ~100-300 MB startup cost per render
* perf: Add concurrency gate (MAX_CONCURRENT env var, default 4) to prevent unbounded memory growth under load – returns 503 when limit is reached
* perf: Add aggressive Chrome launch flags to reduce memory footprint: --disable-dev-shm-usage, --disable-gpu, --disable-extensions, --disable-background-networking, --single-process, --js-flags=--max-old-space-size=512, and more
* perf: Disable page-level cache (setCacheEnabled(false)) and block heavy resource types (media, websocket) via request interception
* perf: Pre-launch browser on server startup so first request doesn't pay the cold-start cost
* feat: Add /status endpoint for monitoring active renders, max concurrency, total rendered count, and browser connection state
* fix: Properly close pages in a finally block to prevent leaked renderer processes
* perf: Add calibrated chunked PDF rendering (?chunked=true) for large continuous tables. Renders a small sample of rows (default 20, ?sampleRows=N) to measure rows-per-PDF-page, then uses that to size chunks to fill a target number of PDF pages (default 10, ?chunkPages=N). For non-final chunks the last (partial) page is dropped so the next chunk re-renders those rows at a clean page boundary. <thead> is preserved in every chunk. Chunks are merged with pdf-lib. For page-based HTML (.page elements), a simpler element-based split is used. Keeps Chrome peak memory proportional to chunk size. Addresses 10GB+ RAM caused by Chrome's internal PDF cross-reference table on large documents.

## v1.2.0

* feat(render): Allows creation of pdfs with custom dimensions (ASG-3281, ASG-3282)

## v1.1.1

* fix: Adds timeouts of 10 min to puppeteer functions. (ASG-3421)
* build: Update dependencies. Requirements bumped to node 20. (ASG-3421)

## v1.1.0

* feat:DM2-25: Added page.evaluateHandle('document.fonts.ready'); (#9)
* chore: Add Additional Logging
* fix: Fix free font package in build

## v1.0.0
