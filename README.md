# imqs-html2pdf
Small node express/puppeteer server that receives html via a post request and renders the html in chromuim-headerless and returns the resulting pdf.

# Run Server
Install dependencies: `npm install`

Start server: `npm start`

# Docker

`ruby docker-build.rb -t latest`

`docker run -p 8080:8080 -d imqs/imqs-html2pdf`
