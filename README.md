# htmlrender
Small node express/puppeteer server that receives HTML via a POST request, and uses Chrome Headless (Puppeteer) to render the document to PDF or PNG.

>> This service was originally called imqs-html2pdf, but once it starting doing things other than PDF, we renamed it to htmlrender

# Run Server
Install dependencies: `npm install`
Start server: `npm start`

# Examples

    curl -H "Content-Type:text/html" -d "<h1>Hello world</h1>" "localhost:2078/render?format=pdf" --output test.pdf
    curl -H "Content-Type:text/html" -d "<h1>Hello world</h1>" "localhost:2078/render?format=png" --output test.png
    curl -H "Content-Type:text/html" -d "<h1>Hello world (size clamped)</h1>" "localhost:2078/render?format=png&width=5000&height=3000" --output test.png
    curl -H "Content-Type:text/html" -d "<h1>Hello world (massive DPR)</h1>" "localhost:2078/render?format=png&deviceScaleFactor=4" --output test.png
    curl -H "Content-Type:text/html" -d "<h1>Hello world (massive DPR)</h1>" "localhost:2078/render?format=png&width=2000&height=1414&deviceScaleFactor=0.75" --output test.png
    curl -H "Content-Type:text/html" -d @example.html "localhost:2078/render?format=pdf" --output test.pdf

# Docker

Build container: `docker build -t imqs/htmlrender:master .`
Run container: `docker run -p 2078:2078 imqs/htmlrender:master`
Test container: `curl -H "Content-Type:text/html" -d "<h1>Hello container</h1>" "localhost:2078/render?format=png" --output test.png`
Push container: `docker push imqs/htmlrender:master`
