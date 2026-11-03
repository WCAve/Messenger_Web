# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build

# ---- runtime ----
# The server has no runtime npm dependencies (Node 22 ships sqlite, fetch and WebSocket).
FROM node:22-alpine
RUN apk add --no-cache su-exec tzdata
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    PUID=99 \
    PGID=100
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/dist web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings=ExperimentalWarning", "server/dist/index.js"]
