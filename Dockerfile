# ---- build ----
# Runs on the build machine's own CPU for every target: the output is plain JavaScript, and npm under
# ARM emulation crashes ("Illegal instruction").
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
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
# Debian (13, trixie) rather than Alpine: the AI runtimes for sticker search (ONNX) only exist for
# glibc systems, and trixie's ffmpeg (7.1) is what the video conversion is written against.
FROM node:22-trixie-slim
# ffmpeg (and heif-dec with the HEVC decoder plugin, for iPhone photos) convert files the networks can't take as they are (server/src/convert.ts).
# On Intel machines, the drivers for the video chip (Quick Sync through VAAPI): used when /dev/dri is passed in.
# iHD (Broadwell and newer) is in Debian's non-free section; i965 covers older chips.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends tzdata ffmpeg libheif-examples libheif-plugin-libde265 \
 && if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver; fi \
 && rm -rf /var/lib/apt/lists/* \
 && command -v setpriv && command -v heif-dec && ffmpeg -hide_banner -encoders | grep -q libx264
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
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings=ExperimentalWarning", "server/dist/index.js"]
