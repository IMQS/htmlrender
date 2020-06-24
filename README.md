# htmlrender
Small node express/puppeteer server that receives HTML via a POST request, and uses Chrome Headless (Puppeteer) to render the document to PDF or PNG.

>> This service was originally called imqs-html2pdf, but once it starting doing things other than PDF, we renamed it to htmlrender

# Run Server
Install dependencies: `npm install`
Start server: `npm start`

# Examples

    curl -H "Content-Type:text/html" -d "<h1>Hello world</h1>" "localhost:8080/render?format=pdf" --output test.pdf
    curl -H "Content-Type:text/html" -d "<h1>Hello world</h1>" "localhost:8080/render?format=png" --output test.png
    curl -H "Content-Type:text/html" -d @example.html "localhost:8080/render?format=pdf" --output test.pdf

# Docker

Build container: `docker build -t htmlrender .`
Run container: `docker run -p 8080:2078 htmlrender`

From here on out, we use the old name `imqs-html2pdf`, to avoid pointless churn work

Tag container: `docker tag htmlrender gcr.io/html2pdf-207011/imqs-html2pdf`
Push container: `docker push gcr.io/html2pdf-207011/imqs-html2pdf`
Deploy new container onto GCP VM: `gcloud compute instances update-container imqs-puppeteer-server --container-image gcr.io/html2pdf-207011/imqs-html2pdf`
