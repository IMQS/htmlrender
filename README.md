# imqs-html2pdf
Small node express/puppeteer server that receives html via a post request, uses Chrome Headless to render the document to PDF or PNG.

# Run Server
Install dependencies: `npm install`

Start server: `npm start`

# Examples

    curl -H "Content-Type:text/html" -d "<h1>Hello world</h1>" "localhost:8080/render?format=pdf" --output test.pdf
    curl -H "Content-Type:text/html" -d "<h1>Hello world</h1>" "localhost:8080/render?format=png" --output test.png
    curl -H "Content-Type:text/html" -d @example.html "localhost:8080/render?format=pdf" --output test.pdf

# Docker

Build container: `docker build -t imqs-html2pdf .`

Run container: `docker run -p 8080:8080 -d imqs-html2pdf`

Tag container: `docker tag imqs-html2pdf gcr.io/html2pdf-207011/imqs-html2pdf`

Push container: `docker push gcr.io/html2pdf-207011/imqs-html2pdf`
