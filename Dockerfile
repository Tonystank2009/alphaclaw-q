FROM node:22-bookworm-slim

# System tools alphaclaw expects: git (workspace backup), curl (gog install), cron (hourly sync)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl cron procps tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (cache layer)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source
COPY . .

# Build the setup UI bundle
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
