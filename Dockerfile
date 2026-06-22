# syntax=docker/dockerfile:1

# Builds the long-lived relay together with the web (companion app) bundle it
# serves. This image is the live-view service; the MCP server itself stays on the
# host (Claude spawns it over stdio) and only needs to reach this container.

# ---- Stage 1: compile the relay (TypeScript -> dist/) ----------------------
FROM node:24-alpine AS server-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---- Stage 2: build the companion web app (Vite -> web/dist/) --------------
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 3: runtime ------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    RELAY_PORT=3030 \
    EXCALIDRAW_OUTPUT_DIR=/data

# Only production deps (the relay needs `ws`; dev tooling is left behind).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled relay + the web bundle it serves from ../web/dist.
COPY --from=server-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web/dist

# Scenes persist here; mount a volume to keep them across restarts.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${RELAY_PORT}/scenes" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/relay.js"]