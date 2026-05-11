FROM node:22-bookworm-slim

# System tools alphaclaw expects: git (workspace backup), curl (gog install), cron (hourly sync)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl cron procps tini psmisc lsof \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (build needs esbuild from devDependencies)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy source
COPY . .

# Build the setup UI bundle
RUN npm run build

# Prune dev deps after build to keep runtime image small
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
