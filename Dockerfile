# docker build -t imqs/htmlrender:latest .

FROM node:20

RUN apt-get update && \
	apt-get install -yq gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 \
	libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 \
	libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
	libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
	fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf woff2  \
	ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget libgbm1 && \
	wget https://github.com/Yelp/dumb-init/releases/download/v1.2.1/dumb-init_1.2.1_amd64.deb && \
	dpkg -i dumb-init_*.deb && rm -f dumb-init_*.deb && \
	apt-get clean && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/htmlrender

# We install in two phases, so that the npm install is generally cached, even if you change server.js

# This is the slow phase, where we download and install Puppeteer
COPY package*.json ./
RUN npm install

# This is the second phase, which is always very fast
COPY server.js ./

HEALTHCHECK CMD curl --fail http://localhost:2078/ping || exit 1

CMD ["npm", "start"]
