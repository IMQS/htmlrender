curl -d "<h1>Hello World</h1>" \
 -H "Content-Type: text/plain" \
 -X POST http://localhost:2078/render --output fresh.pdf
