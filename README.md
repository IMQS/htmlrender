# imqs-html2pdf
Small node express/puppeteer server that receives html via a post request and renders the html in chromuim-headerless and returns the resulting pdf.

# Run Server
Install dependencies: `npm install`

Start server: `npm start`

# Docker

Build container: `docker build -t imqs-html2pdf .`

Run container: `docker run -p 8080:8080 -d imqs-html2pdf`

Tag container: `docker tag imqs-html2pdf gcr.io/html2pdf-207011/imqs-html2pdf`

Push container: `docker push gcr.io/html2pdf-207011/imqs-html2pdf`
