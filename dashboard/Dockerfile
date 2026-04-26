FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN npm ci --workspaces --include-workspace-root || npm install

ENV NODE_ENV=production

WORKDIR /app/dashboard
RUN npm run build

EXPOSE 3000
CMD ["npx", "next", "start"]
