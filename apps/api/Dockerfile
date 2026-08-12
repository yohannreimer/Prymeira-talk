FROM node:22-alpine AS builder
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @prymeira-talk/api build:prod
RUN pnpm --filter @prymeira-talk/api deploy --prod /runtime
RUN cd /runtime && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache ffmpeg \
  && corepack enable \
  && corepack prepare pnpm@10.0.0 --activate
COPY --from=builder /runtime ./
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3002

EXPOSE 3002

CMD ["node", "dist/server.js"]
