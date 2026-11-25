# syntax=docker/dockerfile:1
FROM golang:1.26-bookworm AS japanese-worker-build

WORKDIR /worker
COPY workers/japanese-worker/go.mod workers/japanese-worker/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
  go mod download
COPY workers/japanese-worker/ ./

ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \
  CGO_ENABLED=0 GOOS="${TARGETOS:-linux}" GOARCH="${TARGETARCH:-amd64}" \
  go build -trimpath -ldflags='-s -w' -o /out/japanese-worker .

FROM node:22.23.4-bookworm-slim AS app-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund
COPY tsconfig.json prompt.txt Bokete.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.4-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# リンクプレビューで、添付上限を超える動画の低画質版（映像と音声）を再エンコードせずに結合するため
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --no-audit --no-fund
COPY --from=app-build --chown=node:node /app/dist ./dist
COPY --from=app-build --chown=node:node /app/prompt.txt ./prompt.txt
COPY --from=app-build --chown=node:node /app/Bokete.json ./Bokete.json
COPY --from=japanese-worker-build --chown=node:node /out/japanese-worker ./workers/japanese-worker/japanese-worker
RUN mkdir -p /app/data/production && chown -R node:node /app/data

USER node
CMD ["node", "dist/index.js"]
