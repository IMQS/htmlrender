curl -d "<h1>Hello World</h1>" \
 -H "Content-Type: text/plain" \
 -X POST https://localhost:2079/render --output fresh.pdf
