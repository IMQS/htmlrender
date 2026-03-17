'use strict';

const express = require('express');
const https = require('https');
const fs = require('fs');
const puppeteer = require('puppeteer');
const bodyParser = require('body-parser');
const { PDFDocument } = require('pdf-lib');

// Constants
const HOST = '0.0.0.0';
const PORT = 2078;
const SPORT = 2079;

const DEFAULT_WIDTH = 210 * 4;
const DEFAULT_HEIGHT = 297 * 4;

// Maximum number of concurrent renders. Each render creates a tab inside our
// single browser instance. Limiting concurrency prevents Chrome from consuming
// unbounded RAM when many requests arrive simultaneously.
const MAX_CONCURRENT = parseInt(process.env['MAX_CONCURRENT'] || '4');

let ENABLE_HTTPS = false;
if (process.env['ENABLE_HTTPS'] == "TRUE")
	ENABLE_HTTPS = true;

// App
const app = express();

// ---------------------------------------------------------------------------
// Single shared browser instance
// ---------------------------------------------------------------------------
// Re-using one browser avoids the enormous cost of launching a new Chrome
// process per request (~100-300 MB each). Pages (tabs) are cheap by comparison.
let browserInstance = null;
let activeConcurrent = 0;

const BROWSER_ARGS = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--disable-dev-shm-usage',       // write shared memory to /tmp instead of /dev/shm (avoids OOM in Docker)
	'--disable-gpu',                  // no GPU compositing needed for headless rendering
	'--disable-extensions',           // no extensions
	'--disable-background-networking',
	'--disable-default-apps',
	'--disable-sync',
	'--disable-translate',
	'--disable-component-update',
	'--no-first-run',
	'--mute-audio',
	'--hide-scrollbars',
	'--single-process',               // run everything in one process to reduce overhead
	'--js-flags=--max-old-space-size=512', // cap V8 heap per renderer
];

async function getBrowser() {
	if (browserInstance && browserInstance.connected) {
		return browserInstance;
	}
	console.info('Launching shared browser instance');
	browserInstance = await puppeteer.launch({
		headless: 'new',
		args: BROWSER_ARGS,
		protocolTimeout: 660000,
	});
	browserInstance.on('disconnected', () => {
		console.warn('Browser disconnected – will relaunch on next request');
		browserInstance = null;
	});
	return browserInstance;
}

// ---------------------------------------------------------------------------
// Chunked PDF rendering – for continuous content (large tables)
// ---------------------------------------------------------------------------
// Chrome's PDF renderer keeps the entire document tree + PDF cross-reference
// table in memory. For very large HTML documents this can exceed 10 GB.
// There is no way to pause/resume Chrome's Page.printToPDF – it is atomic.
//
// The workaround: split the content *before* rendering.
//
// Algorithm (adaptive chunking with try-and-retry):
//
//   Row heights are NOT assumed to be uniform.  The system adapts:
//
//   1. Load the HTML once to count data rows (<tr> not in <thead>).
//   2. Render a small sample (default 20 rows) to get an initial estimate of
//      rows-per-PDF-page.  This seeds the first chunk attempt.
//   3. For each chunk starting at row `cursor`:
//      a. Attempt to render `currentChunkRows` rows.
//      b. Count the PDF pages produced.
//      c. If pages > targetPages:  the chunk was too big (tall rows).
//         DISCARD the PDF, halve `currentChunkRows`, retry from the same
//         cursor.  Keep halving until it fits or we reach a floor of 1 row.
//      d. If pages <= targetPages:  ACCEPT the chunk.
//         - Learn from it: recalculate rowsPerPage from this chunk's actual
//           result and use it to size the *next* chunk.  This handles
//           transitions from dense thin rows to sparse tall rows and back.
//         - For non-final chunks, drop the last (partial) page so the next
//           chunk re-renders those rows at a clean page boundary.
//         - Advance cursor past the accepted rows.
//   4. Merge all accepted chunk PDFs with pdf-lib.
//
// Query parameters:
//   ?chunked=true                  — enable chunked rendering
//   ?chunkPages=N                  — max PDF pages per chunk (default 10)
//   ?sampleRows=N                  — rows for initial calibration (default 20)
//
// Header / footer note:
//   displayHeaderFooter, headerTemplate, footerTemplate, and margins are
//   passed through to every chunk render, so headers and footers appear on
//   every page of every chunk exactly as they would in a single-shot render.
//   CAVEAT: if the template uses Chromium's <span class="totalPages"></span>,
//   each chunk will report its own page count, not the global total.  The
//   <span class="pageNumber"></span> will also restart at 1 per chunk.  If
//   global page numbering is required, omit those spans from the template
//   and handle numbering externally on the merged PDF.

const DEFAULT_TARGET_PAGES = 10;
const DEFAULT_SAMPLE_ROWS = 20;

// Maximum retries when halving before we give up and accept whatever we got.
const MAX_CHUNK_RETRIES = 8;

// ---- helpers ----

// Opens a page, loads bodyHtml, removes all data rows outside [start, end),
// keeps <thead> intact, renders to PDF, closes the page, returns PDF buffer.
async function renderRowRange(browser, bodyHtml, pdfOptions, start, end, renderID, label) {
	const chunkPage = await browser.newPage();
	await chunkPage.setCacheEnabled(false);

	await chunkPage.setContent(bodyHtml, {
		waitUntil: 'domcontentloaded',
		timeout: 600000,
	});

	await chunkPage.evaluate((s, e) => {
		const allRows = document.querySelectorAll('tr');
		const bodyRows = [];
		for (const row of allRows) {
			if (!row.closest('thead')) {
				bodyRows.push(row);
			}
		}
		for (let i = 0; i < bodyRows.length; i++) {
			if (i < s || i >= e) {
				bodyRows[i].remove();
			}
		}
	}, start, end);

	await chunkPage.evaluateHandle('document.fonts.ready');

	const pdf = await chunkPage.pdf({
		...pdfOptions,
		timeout: 600000,
	});

	await chunkPage.close();
	console.info(`R:${renderID} ${label}: ${pdf.length} bytes`);
	return pdf;
}

// Count PDF pages in a buffer using pdf-lib.
async function countPdfPages(pdfBuffer) {
	const doc = await PDFDocument.load(pdfBuffer);
	return doc.getPageCount();
}

// Drop the last page from a PDF buffer; returns new buffer.
async function dropLastPage(pdfBuffer) {
	const doc = await PDFDocument.load(pdfBuffer);
	const count = doc.getPageCount();
	if (count <= 1) return pdfBuffer; // nothing to drop
	doc.removePage(count - 1);
	const bytes = await doc.save();
	return Buffer.from(bytes);
}

async function renderChunkedPdf(browser, bodyHtml, pdfOptions, targetPages, sampleRows, renderID) {
	// --- Step 1: Discover total row count ---
	let discoveryPage = await browser.newPage();
	await discoveryPage.setCacheEnabled(false);

	await discoveryPage.setContent(bodyHtml, {
		waitUntil: 'domcontentloaded',
		timeout: 600000,
	});

	const docInfo = await discoveryPage.evaluate(() => {
		// Check for explicit page elements first
		const pageEls = document.querySelectorAll('body > .page');
		if (pageEls.length > 1) {
			return { mode: 'pages', totalItems: pageEls.length };
		}

		// Otherwise look for table rows (skip rows inside <thead>)
		const theadRows = document.querySelectorAll('thead tr');
		const theadRowCount = theadRows.length;

		const allRows = document.querySelectorAll('tr');
		const totalBodyRows = allRows.length - theadRowCount;

		return {
			mode: 'table',
			totalItems: totalBodyRows,
			hasHead: theadRowCount > 0,
		};
	});

	await discoveryPage.close();
	discoveryPage = null;

	if (docInfo.totalItems === 0) {
		throw new Error('Chunked rendering found 0 splittable items (no .page elements and no table rows)');
	}

	const totalRows = docInfo.totalItems;

	// --- Page-based mode (simple split, no calibration needed) ---
	if (docInfo.mode === 'pages') {
		console.info(`R:${renderID} Chunked mode="pages", ${totalRows} page elements, target ${targetPages} per chunk`);
		return await renderChunkedByPageElements(browser, bodyHtml, pdfOptions, totalRows, targetPages, renderID);
	}

	// --- Step 2: Initial calibration ---
	const actualSample = Math.min(sampleRows, totalRows);
	console.info(`R:${renderID} Calibrating: rendering ${actualSample} sample rows of ${totalRows} total`);

	const samplePdf = await renderRowRange(browser, bodyHtml, pdfOptions, 0, actualSample, renderID, `Calibration (${actualSample} rows)`);
	const samplePageCount = await countPdfPages(samplePdf);

	let rowsPerPage = Math.max(1, Math.floor(actualSample / Math.max(1, samplePageCount)));
	let currentChunkRows = Math.max(1, rowsPerPage * targetPages);

	console.info(`R:${renderID} Calibration: ${actualSample} rows → ${samplePageCount} pages ≈ ${rowsPerPage} rows/page → initial chunk ${currentChunkRows} rows`);

	// If everything fits in one chunk, render directly
	if (currentChunkRows >= totalRows) {
		console.info(`R:${renderID} Document fits in a single chunk – rendering in one shot`);
		return await renderRowRange(browser, bodyHtml, pdfOptions, 0, totalRows, renderID, `Single-shot (${totalRows} rows)`);
	}

	// --- Step 3: Adaptive chunking with try-and-retry ---
	const chunkPdfs = [];
	let cursor = 0;       // current position in the row list
	let chunkIndex = 0;

	while (cursor < totalRows) {
		chunkIndex++;
		let accepted = false;
		let retries = 0;
		let attemptRows = Math.min(currentChunkRows, totalRows - cursor);

		while (!accepted) {
			const end = Math.min(cursor + attemptRows, totalRows);
			const isLast = (end >= totalRows);

			console.info(`R:${renderID} Chunk ${chunkIndex} attempt ${retries + 1}: rows ${cursor + 1}–${end} (${attemptRows} rows)${isLast ? ' (final)' : ''}`);

			let chunkPdf = await renderRowRange(browser, bodyHtml, pdfOptions, cursor, end, renderID, `Chunk ${chunkIndex}`);
			const pageCount = await countPdfPages(chunkPdf);

			if (pageCount > targetPages && attemptRows > 1 && retries < MAX_CHUNK_RETRIES && !isLast) {
				// Too many pages – rows in this region are taller than expected.
				// Discard and retry with fewer rows.
				const newAttempt = Math.max(1, Math.floor(attemptRows / 2));
				console.info(`R:${renderID} Chunk ${chunkIndex}: ${pageCount} pages > target ${targetPages} – reducing ${attemptRows} → ${newAttempt} rows and retrying`);
				attemptRows = newAttempt;
				retries++;
				continue;
			}

			// Accept this chunk (either it fits, it's the last chunk, we hit
			// minimum rows, or we exhausted retries).
			if (pageCount > targetPages && !isLast) {
				console.warn(`R:${renderID} Chunk ${chunkIndex}: accepting ${pageCount} pages (exceeded target ${targetPages} but cannot reduce further)`);
			}

			// For non-final chunks, drop the last page (likely partial).
			// The rows on that page will re-appear at the top of the next chunk.
			if (!isLast && pageCount > 1) {
				console.info(`R:${renderID} Chunk ${chunkIndex}: dropping last page (partial) – ${pageCount} → ${pageCount - 1} pages`);
				chunkPdf = await dropLastPage(chunkPdf);
			}

			chunkPdfs.push(chunkPdf);

			// Learn from this chunk: update rowsPerPage estimate for next chunk.
			// Use the actual rows and pages from this accepted chunk.
			const actualRowsPerPage = Math.max(1, Math.floor(attemptRows / Math.max(1, pageCount)));
			if (actualRowsPerPage !== rowsPerPage) {
				console.info(`R:${renderID} Chunk ${chunkIndex}: adjusting estimate ${rowsPerPage} → ${actualRowsPerPage} rows/page`);
				rowsPerPage = actualRowsPerPage;
			}
			currentChunkRows = Math.max(1, rowsPerPage * targetPages);

			cursor = end;
			accepted = true;
		}
	}

	// --- Step 4: Merge ---
	console.info(`R:${renderID} Merging ${chunkPdfs.length} chunk PDFs`);
	const mergedPdf = await PDFDocument.create();

	for (const chunkBuf of chunkPdfs) {
		const donor = await PDFDocument.load(chunkBuf);
		const copiedPages = await mergedPdf.copyPages(donor, donor.getPageIndices());
		for (const pg of copiedPages) {
			mergedPdf.addPage(pg);
		}
	}

	const mergedBytes = await mergedPdf.save();
	console.info(`R:${renderID} Merged PDF: ${mergedBytes.length} bytes, ${mergedPdf.getPageCount()} pages`);

	return Buffer.from(mergedBytes);
}

// Simple element-based chunking for <div class="page"> structures
async function renderChunkedByPageElements(browser, bodyHtml, pdfOptions, totalItems, chunkSize, renderID) {
	const chunkPdfs = [];

	for (let start = 0; start < totalItems; start += chunkSize) {
		const end = Math.min(start + chunkSize, totalItems);
		console.info(`R:${renderID} Page-element chunk: items ${start + 1}–${end} of ${totalItems}`);

		const chunkPage = await browser.newPage();
		await chunkPage.setCacheEnabled(false);

		await chunkPage.setContent(bodyHtml, {
			waitUntil: 'domcontentloaded',
			timeout: 600000,
		});

		await chunkPage.evaluate((s, e) => {
			const pages = document.querySelectorAll('body > .page');
			for (let i = 0; i < pages.length; i++) {
				if (i < s || i >= e) {
					pages[i].remove();
				}
			}
		}, start, end);

		await chunkPage.evaluateHandle('document.fonts.ready');

		const chunkPdf = await chunkPage.pdf({
			...pdfOptions,
			timeout: 600000,
		});

		chunkPdfs.push(chunkPdf);
		await chunkPage.close();

		console.info(`R:${renderID} Page-element chunk ${start + 1}–${end} done (${chunkPdf.length} bytes)`);
	}

	const mergedPdf = await PDFDocument.create();
	for (const chunkBuf of chunkPdfs) {
		const donor = await PDFDocument.load(chunkBuf);
		const copiedPages = await mergedPdf.copyPages(donor, donor.getPageIndices());
		for (const pg of copiedPages) {
			mergedPdf.addPage(pg);
		}
	}

	const mergedBytes = await mergedPdf.save();
	console.info(`R:${renderID} Merged PDF: ${mergedBytes.length} bytes`);
	return Buffer.from(mergedBytes);
}

let renderCount = 0;

app.use(bodyParser.json({
	limit: '50mb'
}));
app.use(bodyParser.urlencoded({
	limit: '50mb',
	extended: true,
	parameterLimit: 50000
}));


app.use(function (req, res, next) {
	if (req.is('text/*')) {
		req.text = '';
		req.setEncoding('utf8');
		req.on('data', function (chunk) {
			req.text += chunk
		});
		req.on('end', next);
	} else {
		next();
	}
});

function render(req, res) {
	renderCount++;
	let renderID = renderCount;

	const format = req.query['format'] || 'pdf';
	let pageSize = req.query['pagesize'] || 'A4';
	const pageLandscape = req.query['pagelandscape'] === 'true';

	let width = req.query['width'] || DEFAULT_WIDTH;
	let height = req.query['height'] || DEFAULT_HEIGHT;

	if (width !== DEFAULT_WIDTH || height !== DEFAULT_HEIGHT)
		// need to set pageSize to undefined to allow the pdf function to make
		// use of the width and height
		pageSize = undefined;

	let deviceScaleFactor = req.query['deviceScaleFactor'] || 1.0;
	let topMargin = req.query['top'] || 0;
	let bottomMargin = req.query['bottom'] || 0;

	let bodyHtml;
	let headerHtml;
	let footerHtml;
	let isHeaderFooter = false;

	if (req.is('application/json')) {
		// If you are using a header and/or footer, then you probably want to specify
		// top and bottom margin
		headerHtml = req.body.header;
		bodyHtml = req.body.body;
		footerHtml = req.body.footer;
	} else if (req.text !== undefined) {
		bodyHtml = req.text;
	} else {
		res.status(400).send('The body must have Content-Type:text/html');
		return;
	}

	if (headerHtml || footerHtml)
		isHeaderFooter = true;

	// ---- Concurrency gate ----
	if (activeConcurrent >= MAX_CONCURRENT) {
		console.warn(`R:${renderID} Rejected – ${activeConcurrent} renders already in progress (limit ${MAX_CONCURRENT})`);
		res.status(503).send('Server busy – too many concurrent renders. Try again shortly.');
		return;
	}
	activeConcurrent++;
	console.info(`R:${renderID} Active renders: ${activeConcurrent}/${MAX_CONCURRENT}`);

	(async () => {
		let page;
		try {
			const browser = await getBrowser();

			try {
				page = await browser.newPage();
			} catch (error) {
				let e = "New Page " + error.toString();
				console.error(e);
				res.status(500).send(e);
				return;
			}

			// Disable navigation-level caching to avoid holding decoded resources in memory
			await page.setCacheEnabled(false);

			// Block unnecessary resource types to reduce memory
			await page.setRequestInterception(true);
			page.on('request', (interceptedRequest) => {
				const resourceType = interceptedRequest.resourceType();
				// Block videos, media, and other heavy resources that aren't needed for rendering
				if (['media', 'websocket', 'other'].includes(resourceType)) {
					interceptedRequest.abort();
				} else {
					interceptedRequest.continue();
				}
			});

			try {
				await page.setContent(bodyHtml, {
					waitUntil: 'domcontentloaded',
					timeout: 600000
				});
			} catch (error) {
				let e = "Set Content " + error.toString();
				console.error(e);
				res.status(500).send(e);
				return;
			}

			if (format == 'pdf') {
				console.info(`R:${renderID} Rendering pdf ${pageSize} ${pageLandscape}`);

				const useChunked = req.query['chunked'] === 'true';
				const chunkPages = parseInt(req.query['chunkPages'] || DEFAULT_TARGET_PAGES);
				const sampleRows = parseInt(req.query['sampleRows'] || DEFAULT_SAMPLE_ROWS);

				const pdfOptions = {
					format: pageSize,
					width: width,
					height: height,
					landscape: pageLandscape,
					printBackground: true,
					displayHeaderFooter: isHeaderFooter,
					headerTemplate: headerHtml,
					footerTemplate: footerHtml,
					margin: {
						top: topMargin,
						bottom: bottomMargin
					},
				};

				let pdf;

				if (useChunked) {
					// ---- Chunked rendering path ----
					// Renders a small sample to calibrate rows-per-page, then
					// renders N-page chunks, dropping partial trailing pages
					// on non-final chunks for clean seams.
					try {
						// Close the page we opened above – chunked rendering
						// manages its own pages.
						await page.close();
						page = null;

						pdf = await renderChunkedPdf(browser, bodyHtml, pdfOptions, chunkPages, sampleRows, renderID);
					} catch (error) {
						let e = "Failed to render chunked PDF " + error.toString();
						console.error(e);
						res.status(500).send(e);
						return;
					}
				} else {
					// ---- Original single-shot rendering path ----
					await page.evaluateHandle('document.fonts.ready');
					try {
						pdf = await page.pdf({
							...pdfOptions,
							timeout: 600000
						});
					} catch (error) {
						let e = "Failed to render PDF " + error.toString();
						console.error(e);
						res.status(500).send(e);
						return;
					}
				}

				res.setHeader('content-type', 'application/pdf');
				res.send(pdf);
			} else if (format == 'png') {
				deviceScaleFactor = parseFloat(deviceScaleFactor);
				width = parseInt(width);
				height = parseInt(height);
				topMargin = parseInt(topMargin);
				bottomMargin = parseInt(bottomMargin);

				if (deviceScaleFactor < 0.25 || deviceScaleFactor > 8) {
					res.status(400).send('Invalid deviceScaleFactor. Must be between 0.25 and 8');
					return;
				}
				if (width < 4 || height < 4) {
					res.status(400).send('width and height must be at least 4');
					return;
				}

				let maxSize = 2000;
				if (width * deviceScaleFactor > maxSize || height * deviceScaleFactor > maxSize || width > maxSize || height > maxSize) {
					// clamp our size, because it seems like something is going wrong when the image
					// size gets too large.
					// The symptom is this:
					// The user tries to produce an A0 print preview, and the request for the preview
					// just never returns (ie, from the HTTP client's point of view).
					// The server logs aren't clear, but there are some suspicious thing, like:
					// 2020-07-06 15:40:32.532 SAST (node:30) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 exit listeners added to [process]. Use emitter.setMaxListeners() to increase limit
					// 2020-07-07 20:36:59.575 SAST TimeoutError: Timed out after 30000 ms while trying to connect to the browser! Only Chrome at revision r756035 is guaranteed to work.
					// 2020-07-07 20:37:05.397 SAST at Timeout.onTimeout (/usr/src/htmlrender/node_modules/puppeteer/lib/launcher/BrowserRunner.js:200:20)
					// 2020-07-07 20:37:05.398 SAST at listOnTimeout (internal/timers.js:549:17)
					// 2020-07-07 20:37:05.398 SAST at processTimers (internal/timers.js:492:7)
					// I suspect that something is going wrong that is catching puppeteer unaware. Or maybe we're simply not catching exceptions correctly.
					// What happens is that the VM becomes completely unresponsive, and we are unable to SSH into it, and we have to reset it.
					// The size of an A1 preview is 2384 x 1684, and that is fine, but an A0 causes us to hang.
					// This is a small VM, with only 3.6 GB RAM.
					// In these calculations, we need to take deviceScaleFactor into consideration, because page.setViewport()
					// takes css pixels for it's width/height, so the real image width is width*deviceScaleFactor.
					// OK.. one other massive thing...

					// I don't really understand why, but I'm just throwing more fuel at this problem
					let scale = deviceScaleFactor;
					if (scale < 1)
						scale = 1;

					let aspect = width / height;
					if (aspect >= 1) {
						width = maxSize / scale;
						height = width / aspect;
					} else {
						height = maxSize / scale;
						width = height * aspect;
					}
					width = Math.floor(width);
					height = Math.floor(height);
				}

				console.info(`R:${renderID} Rendering png ${width} x ${height} @ ${deviceScaleFactor}`);
				try {
					await page.setViewport({
						width: width,
						height: height,
						deviceScaleFactor: deviceScaleFactor,
					});
				} catch (error) {
					let e = "Viewport " + error.toString();
					console.error(e);
					res.status(500).send(e);
					return;
				}

				let png;
				try {
					png = await page.screenshot({
						type: 'png',
						omitBackground: true,
						fullPage: true
					});

				} catch (error) {
					let e = "Screenshot " + error.toString();
					console.error(e);
					res.status(500).send(e);
					return;
				}
				res.setHeader('content-type', 'image/png');
				res.send(png);
				console.info(`R:${renderID} Rendering ${width} x ${height} @ ${deviceScaleFactor} complete`);
			} else {
				res.status(400).send(`Unknown format ${format}. Valid formats are pdf,png`);
			}
			console.info(`R:${renderID} Closing page (clean exit)`);
		} catch (error) {
			console.error(error);
			if (!res.headersSent) {
				res.status(500).send(error.toString());
			}
			console.info(`R:${renderID} Error during render (exception handler)`);
		} finally {
			// Always close the page to free its renderer process memory.
			// The browser itself stays alive for the next request.
			if (page) {
				try {
					await page.close();
				} catch (closeErr) {
					console.warn(`R:${renderID} Failed to close page: ${closeErr}`);
				}
			}
			activeConcurrent--;
			console.info(`R:${renderID} Active renders now: ${activeConcurrent}/${MAX_CONCURRENT}`);
		}
	})();
}

function version(req, res) {
	res.send({
		version: '1.5.0'
	});
}

function ping(req, res) {
	res.send({
		timestamp: +new Date()
	});
}

function status(req, res) {
	res.send({
		activeConcurrent,
		maxConcurrent: MAX_CONCURRENT,
		totalRendered: renderCount,
		browserConnected: !!(browserInstance && browserInstance.connected),
	});
}

// The original API was called html2pdf, but this has grown to be able to produce PNGs,
// so that's why it got another name "render".
app.post('/html2pdf', render);
app.post('/render', render);

app.get('/version', version);
app.get('/ping', ping);
app.get('/status', status);

app.listen(PORT, HOST);
console.log(`Running on http://${HOST}:${PORT}`);
console.log(`MAX_CONCURRENT = ${MAX_CONCURRENT}`);

// Pre-launch the browser so the first request doesn't pay the startup cost
getBrowser().catch(err => console.error('Failed to pre-launch browser:', err));

if (ENABLE_HTTPS) {
	let options = {
		key: fs.readFileSync('/opt/htmlrender/ssl/ssl.key'),
		cert: fs.readFileSync('/opt/htmlrender/ssl/ssl.crt')
	};

	https.createServer(options, app).listen(SPORT);
	console.log(`Running on https://${HOST}:${SPORT}`);
}
