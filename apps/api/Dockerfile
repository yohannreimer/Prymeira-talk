FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @prymeira-talk/api exec prisma generate --schema prisma/schema.prisma
RUN pnpm --filter @prymeira-talk/api build

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3002

EXPOSE 3002

CMD ["sh", "-c", "pnpm --filter @prymeira-talk/api exec prisma migrate deploy --schema prisma/schema.prisma && pnpm --filter @prymeira-talk/api exec tsx src/server.ts"]
