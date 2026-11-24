# Containerized agent (legacy docker mode). Prefer install-host.sh for a real
# host shell in the web terminal; this image runs the tunnel + local API inside
# alpine with the host docker socket and /home/server mounted.
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose bash

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY check.js link.js server.js transfer-agent.js tunnel.js ./
RUN node check.js

CMD ["node", "tunnel.js"]
