'use strict';

const express = require('express');
const puppeteer = require('puppeteer');

// Constants
const PORT = 5314;
const HOST = '0.0.0.0';

// App
const app = express();
app.use(function (req, res, next) {
	if (req.is('text/*')) {
		req.text = '';
		req.setEncoding('utf8');
		req.on('data', function (chunk) { req.text += chunk });
		req.on('end', next);
	} else {
		next();
	}
});

app.post('/html2pdf', (req, res) => {
	const html = req.text;
	const link = req.query['link'];

	const pageSize = req.query['pagesize'] || 'A4';
	const pageLandscape = req.query['pagelandscape'] === 'true';

	(async () => {
		try {
			const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
			const page = await browser.newPage();
			if (link)
				await page.goto(link, { waitUntil: 'networkidle2' });
			else
				await page.setContent(html);

			await page.pdf({ format: pageSize, landscape: pageLandscape, printBackground: true })
				.then((value) => {
					res.setHeader("content-type", "application/pdf");
					res.send(value);
				});

			await browser.close();
		} catch (error) {
			console.error(error);
		}
	})();
});

app.get('/reportpdff', (req, res) => {
	const link = req.query['link'];

	const pageSize = 'A4';
	const pageLandscape = false;

	(async () => {
		try {
			const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
			const page = await browser.newPage();
			console.log(req);
			page.setCookie(req.cookies);
			await page.goto(link, { waitUntil: 'networkidle2' });

			await page.pdf({ format: pageSize, landscape: pageLandscape, printBackground: true })
				.then((value) => {
					res.setHeader("content-type", "application/pdf");
					res.send(value);
				});

			await browser.close();
		} catch (error) {
			console.error(error);
		}
	})();
});

app.listen(PORT, HOST);
console.log(`Running on http://${HOST}:${PORT}`);
