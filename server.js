'use strict';

const express = require('express');
const puppeteer = require('puppeteer');
const bodyParser = require('body-parser');

// Constants
const PORT = 2078;
const HOST = '0.0.0.0';

// App
const app = express();

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
	const pageSize = req.query['pagesize'] || 'A4';
	const pageLandscape = req.query['pagelandscape'] === 'true';

	let width = req.query['width'] || 210 * 4;
	let height = req.query['height'] || 297 * 4;
	let deviceScaleFactor = req.query['deviceScaleFactor'] || 1.0;
	let topMargin = req.query['top'] || 0;
	let bottomMargin = req.query['bottom'] || 0;

	let bodyHtml;
	let headerHtml;
	let footerHtml;
	let isHeaderFooter = false;

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

	(async () => {
		let browser;
		try {
			browser = await puppeteer.launch({
				args: ['--no-sandbox', '--disable-setuid-sandbox']
			});
			let page = await browser.newPage();
			await page.setContent(bodyHtml, {
				waitUntil: 'domcontentloaded'
			});

			if (format == 'pdf') {
				console.info(`R:${renderID} Rendering pdf ${pageSize} ${pageLandscape}`);
				let pdf = await page.pdf({
					format: pageSize,
					landscape: pageLandscape,
					printBackground: true,
					displayHeaderFooter: isHeaderFooter,
					headerTemplate: headerHtml,
					footerTemplate: footerHtml,
					margin: {
						top: topMargin,
						bottom: bottomMargin
					}
				});
				res.setHeader('content-type', 'application/pdf');
				res.send(pdf);
			} else if (format == 'png') {
				console.info(`R:${renderID} Rendering png ${width} x ${height} @ ${deviceScaleFactor}`);
				await page.setViewport({
					width: width,
					height: height,
					deviceScaleFactor: deviceScaleFactor,
				});

				let png = await page.screenshot({
					type: 'png',
					omitBackground: true,
					fullPage: true
				});
				res.setHeader('content-type', 'image/png');
				res.send(png);
				console.info(`R:${renderID} Rendering ${width} x ${height} @ ${deviceScaleFactor} complete`);
			} else {
				res.status(400).send(`Unknown format ${format}. Valid formats are pdf,png`);
			}
			console.info(`R:${renderID} Closing brower (clean exit)`);
			await browser.close()
		} catch (error) {
			console.error(error);
			res.status(400).send(error);
			console.info(`R:${renderID} Closing brower (exception handler)`);
			await browser.close()
		}
	})();
}

function version(req, res) {
	res.send({
		version: '1.4'
	});
}

function ping(req, res) {
	res.send({
		timestamp: +new Date()
	});
}

// The original API was called html2pdf, but this has grown to be able to produce PNGs,
// so that's why it got another name "render".
app.post('/html2pdf', render);
app.post('/render', render);

app.get('/version', version);
app.get('/ping', ping);

app.listen(PORT, HOST);
console.log(`Running on http://${HOST}:${PORT}`);
