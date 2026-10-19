ARG DOCKER_CLI_IMAGE=docker:29-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${DOCKER_CLI_IMAGE} AS cli
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --fetch-timeout=30000 --fetch-retries=1 && npm cache clean --force
FROM ${NODE_IMAGE}
LABEL openclaw.manager="true"
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOME=/tmp MANAGER_BIND_ADDRESS=0.0.0.0 MANAGER_CONTAINERIZED=1 DOCKER_HOST=unix:///var/run/docker.sock DOCKER_SOCKET=/var/run/docker.sock
WORKDIR /app
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json server.js Dockerfile ./
COPY src ./src
COPY public ./public
COPY control-ui-patches ./control-ui-patches
COPY scripts ./scripts
HEALTHCHECK --interval=20s --timeout=4s --start-period=20s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:'+process.env.MANAGER_PORT+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
