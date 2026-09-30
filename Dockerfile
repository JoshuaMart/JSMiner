FROM node:24.21.0-bookworm-slim AS validate
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json redocly.yaml biome.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY docs/src/content/docs/reference/api.md ./docs/src/content/docs/reference/api.md
RUN pnpm install --frozen-lockfile && pnpm check

FROM validate AS runtime
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
