FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json redocly.yaml biome.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY qualification ./qualification
COPY workers/node ./workers/node
COPY docs/src/content/docs/reference/api.md ./docs/src/content/docs/reference/api.md
RUN pnpm install --frozen-lockfile && pnpm build

FROM build AS validate
RUN pnpm check

FROM build AS packaged
RUN pnpm --filter @jsminer/api deploy --prod --legacy /out

FROM docker:29.4.0-cli AS docker-cli

FROM node:24.21.0-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/JoshuaMart/JSMiner" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production JSMINER_CONFIG=/data/.local/config.json
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=packaged /out /app
COPY scripts/init-local-config.mjs /app/init-config.mjs
COPY LICENSE /app/LICENSE
RUN mkdir /data && chown node:node /data
WORKDIR /data
USER node
EXPOSE 3000
CMD ["node", "/app/dist/main.js"]
