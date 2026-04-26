FROM node:22-bookworm-slim

WORKDIR /app

# Copy the whole monorepo so workspaces resolve. Railway's nixpacks builder
# typically handles this; this Dockerfile is for local `docker build` parity.
COPY . .

RUN npm ci --workspaces --include-workspace-root || npm install

ENV NODE_ENV=production
# Railway volume mount target for Baileys auth persistence.
ENV TONO_DATA_DIR=/data

WORKDIR /app/tono
CMD ["npx", "tsx", "src/runner.ts"]
