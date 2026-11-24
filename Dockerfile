# ---- BASE ----
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS node-runtime

FROM node-runtime AS base
RUN npm install -g pnpm

# ---- BUILDER ----
FROM base AS builder
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/web/package.json ./packages/web/
COPY packages/socket/package.json ./packages/socket/
COPY packages/e2e/package.json ./packages/e2e/
COPY packages/streaming/package.json ./packages/streaming/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Streaming chỉ là JS thuần (không cần build): gom code + dependency production vào /out/streaming.
# --legacy vì streaming không phụ thuộc workspace package nào, không cần inject-workspace-packages.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @razzia/streaming deploy --prod --legacy /out/streaming \
    && rm -f /out/streaming/src/*.test.mjs /out/streaming/scripts/*.test.mjs

# ---- WEB ----
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS nginx-runtime
RUN apk upgrade --no-cache && apk add --no-cache nginx

COPY docker/nginx-static.conf /etc/nginx/razzia-static.conf
COPY --from=builder /app/packages/web/dist /app/web

EXPOSE 3000

FROM nginx-runtime AS web
COPY docker/nginx-web.conf /etc/nginx/http.d/default.conf

CMD ["nginx", "-g", "daemon off;"]

# ---- SOCKET AND HTTP API ----
FROM node-runtime AS socket
WORKDIR /app

ENV NODE_ENV=production CONFIG_PATH=/app/config SOCKET_PORT=3001
COPY --from=builder /app/packages/socket/dist/index.cjs /app/socket/index.cjs

EXPOSE 3001

CMD ["node", "/app/socket/index.cjs"]

# ---- STREAMING WORKER ----
# publisher / score-worker / stats-worker dùng chung image, khác nhau ở command
# (compose hoặc Helm đặt). Metric: publisher 9101, score 9102, stats 9103.
FROM node-runtime AS worker
WORKDIR /app

ENV NODE_ENV=production
COPY --from=builder --chown=node:node /out/streaming /app
USER node

CMD ["node", "src/score-worker.mjs"]

# ---- DB MIGRATION ----
# Chạy một lần trước khi socket khởi động: compose service `migrate`, trên EKS là Helm hook Job.
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS migrate
RUN apk add --no-cache postgresql-client

COPY packages/socket/migrations /migrations
COPY --chmod=755 docker/migrate.sh /usr/local/bin/migrate
RUN sed -i 's/\r$//' /usr/local/bin/migrate

USER nobody
CMD ["migrate", "/migrations"]

# ---- COMBINED RUNNER ----
FROM nginx-runtime AS runner

RUN apk add --no-cache nodejs s6

COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY --chmod=755 docker/s6 /etc/s6
# s6 executes these scripts directly, so normalize Windows checkouts.
RUN sed -i 's/\r$//' /etc/s6/nginx/run /etc/s6/nginx/finish /etc/s6/socket/run

COPY --from=builder /app/packages/socket/dist/index.cjs /app/socket/index.cjs

CMD ["s6-svscan", "/etc/s6"]
