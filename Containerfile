FROM docker.io/library/node:24-bookworm@sha256:f9b3548b20b15b705b66aeecaeac7dd690c73d5e4661357aac02e60e3d38c88a AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM docker.io/library/node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae
WORKDIR /app
ENV NODE_ENV=production EXOMEM_DATABASE=/data/exomem.sqlite EXOMEM_ADMIN_HOST=0.0.0.0 EXOMEM_MCP_HOST=0.0.0.0
ARG EXOMEM_COMMIT=unknown
ENV EXOMEM_COMMIT=$EXOMEM_COMMIT
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY deploy/backup.mjs ./backup.mjs
USER node
EXPOSE 3210 3211
CMD ["node", "dist/server/server/index.js"]
