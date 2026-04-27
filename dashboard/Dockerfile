FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN npm ci --workspaces --include-workspace-root || npm install

ENV NODE_ENV=production

# NEXT_PUBLIC_* values must be present at `next build` time so Next.js inlines
# them into the client bundle. Railway exposes service env vars to Docker
# builds only when declared as ARG.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_WA_NUMBER
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_WA_NUMBER=$NEXT_PUBLIC_WA_NUMBER

WORKDIR /app/dashboard
RUN npm run build

EXPOSE 3000
CMD ["npx", "next", "start"]
