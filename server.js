'use strict';

const express = require('express');
const puppeteer = require('puppeteer');
const bodyParser = require('body-parser');

// Constants
const PORT = 80;
const HOST = '0.0.0.0';

// App
const app = express();

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
	
	width = parseInt(width);
	height = parseInt(height);
	deviceScaleFactor = parseFloat(deviceScaleFactor);
	topMargin = parseInt(topMargin);
	bottomMargin = parseInt(bottomMargin);

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
		try {
			const browser = await puppeteer.launch({
				args: ['--no-sandbox', '--disable-setuid-sandbox']
			});
			const page = await browser.newPage();
			await page.setContent(bodyHtml, {
				waitUntil: 'domcontentloaded'
			});

			if (format == 'pdf') {				
				await page.pdf({
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
					})
					.then((value) => {
						res.setHeader('content-type', 'application/pdf');
						res.send(value);
					});
			} else if (format == 'png') {
				await page.setViewport({
					width: width,
					height: height,
					deviceScaleFactor: deviceScaleFactor,
				});

				await page.screenshot({
					type: 'png',
					omitBackground: true,
					fullPage: true
				}).then(data => {
					res.setHeader('content-type', 'image/png');
					res.send(data);
				});
			} else {
				res.status(400).send(`Unknown format ${format}. Valid formats are pdf,png`);
			}
			await browser.close()
		} catch (error) {
			console.error(error);
			res.status(400).send(error);
		}
	})();
}

function version(req, res) {
	res.send({
		version: '1.1'
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
