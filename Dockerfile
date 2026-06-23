# Containerized agent (legacy docker mode). Prefer install-host.sh for a real
# host shell in the web terminal; this image runs the tunnel + local API inside
# alpine with the host docker socket and /home/server mounted.
FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose bash

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . ./

CMD ["node", "tunnel.js"]
