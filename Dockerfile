# Server agent — runs on the user's own machine and dials out to the hub.
FROM node:20-alpine
# docker-cli/compose: control the user's stack · bash/procps: terminal + process list
RUN apk add --no-cache docker-cli docker-cli-compose bash procps openssh-client
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . ./
# tunnel.js is the entrypoint; it spawns server.js (local API) itself.
CMD ["node", "tunnel.js"]
