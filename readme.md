# htmlrender
Small node express/puppeteer server that receives HTML via a POST request, and uses Chrome Headless (Puppeteer) to render the document to PDF or PNG.

>> This service was originally called imqs-html2pdf, but once it starting doing things other than PDF, we renamed it to htmlrender

# Run Server
Install dependencies: `npm install`
Start server: `npm start`

# Known Issues

## Ubuntu 18.04

Currently this docker image fails to start on ubuntu 18.04 with the following
errors:
```
	1: 0xccd047 node::Assert(node::AssertionInfo const&) [node]
	2: 0xd4c2ee node::WorkerThreadsTaskRunner::WorkerThreadsTaskRunner(int) [node]
	3: 0xd4c3cc node::NodePlatform::NodePlatform(int, v8::TracingController*, v8::PageAllocator*) [node]
	4: 0xc6f786  [node]
	5: 0xc70c84 node::Start(int, char**) [node]
	6: 0x7f4b6bcd824a  [/lib/x86_64-linux-gnu/libc.so.6]
	7: 0x7f4b6bcd8305 __libc_start_main [/lib/x86_64-linux-gnu/libc.so.6]
	8: 0xbc7afe _start [node]
```

Docker image works fine on Ubuntu 20.04 and Arch Linux (2024-04-29)

## A0 issue
There is a bug somewhere - and it very much looks like a bug in chromium or puppeteer, which is causing this system
to become unresponsive when rendering A0 PNGs. I can't figure it out, because we clamp the resolution to 2000x2000,
and when rendering smaller page sizes, but at the same number of pixels, everything is fine.

The symptom is that the line "let png = await page.screenshot({" never returns, and doesn't cause an exception either.
I have spent a day trying to track it down, and am giving up now.
See https://imqssoftware.atlassian.net/browse/INF-954 for a paper trail.

I'm hoping that a future version of Puppeteer just magically fixes this.
Ben Harper, 2020-07-08

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
