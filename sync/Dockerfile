FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN npm ci --workspaces --include-workspace-root || npm install

ENV NODE_ENV=production

WORKDIR /app/sync
CMD ["npx", "tsx", "src/runner.ts"]
