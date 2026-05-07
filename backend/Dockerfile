FROM node:20-slim

# Installa Ghostscript
RUN apt-get update && \
    apt-get install -y ghostscript --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
