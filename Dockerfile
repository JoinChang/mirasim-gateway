# syntax=docker/dockerfile:1
FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts drizzle.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY config.json ./config.json
COPY src ./src
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# serve auto-applies migrations on startup (buildRuntime)
CMD ["node","dist/index.js","serve"]
