FROM golang:1.26-bookworm AS japanese-worker-build

WORKDIR /worker
COPY workers/japanese-worker/go.mod workers/japanese-worker/go.sum ./
RUN go mod download
COPY workers/japanese-worker/ ./

ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS="${TARGETOS:-linux}" GOARCH="${TARGETARCH:-amd64}" \
  go build -trimpath -ldflags='-s -w' -o /out/japanese-worker .

FROM node:22-bookworm-slim AS app-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json prompt.txt ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=app-build --chown=node:node /app/dist ./dist
COPY --from=app-build --chown=node:node /app/prompt.txt ./prompt.txt
COPY --from=japanese-worker-build --chown=node:node /out/japanese-worker ./workers/japanese-worker/japanese-worker
RUN mkdir -p /app/data/production && chown -R node:node /app/data

USER node
CMD ["node", "dist/index.js"]
