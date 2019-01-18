'use strict';

const express = require('express');
const puppeteer = require('puppeteer');

// Constants
const PORT = 80;
const HOST = '0.0.0.0';

// App
const app = express();
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
	if (req.text === undefined) {
		res.status(400).send('The body must have Content-Type:text/html');
		return;
	}

	var html = req.text;
	var format = req.query['format'] || 'pdf';
	var pageSize = req.query['pagesize'] || 'A4';
	var pageLandscape = req.query['pagelandscape'] === 'true';
	var width = req.query['width'] || 210 * 4;
	var height = req.query['height'] || 297 * 4;
	var deviceScaleFactor = req.query['deviceScaleFactor'] || 1.0;

	width = parseInt(width);
	height = parseInt(height);
	deviceScaleFactor = parseFloat(deviceScaleFactor);

	(async () => {
		try {
			const browser = await puppeteer.launch(
				{ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
			const page = await browser.newPage();
			await page.setContent(html);

			if (format == 'pdf') {
				await page.pdf({
					format: pageSize,
					landscape: pageLandscape,
					printBackground: true
				}).then((value) => {
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

			await browser.close();
		} catch (error) {
			console.error(error);
			res.status(400).send(error);
		}
	})();
}

// The original API was called html2pdf, but this has grown to be able to produce PNGs,
// so that's why it got another name "render".
app.post('/html2pdf', render);
app.post('/render', render);

app.listen(PORT, HOST);
console.log(`Running on http://${HOST}:${PORT}`);
