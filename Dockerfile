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

# ---- sticker OCR: the ONNX runtime for Node and PaddleOCR's PP-OCRv5 models (server/src/ocr.ts) ----
# Fetched on the build machine; the runtime package carries Linux binaries for both x64 and arm64.
FROM --platform=$BUILDPLATFORM node:22-trixie-slim AS ocr
WORKDIR /ocr
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
# --ignore-scripts: its install script only fetches the GPU (CUDA) version, which isn't used
RUN npm init -y >/dev/null \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund onnxruntime-node@1.22.0 \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 \
 && ls node_modules/onnxruntime-node/bin/napi-v*/linux
# The models as RapidOCR publishes them in ONNX form (their checksums from RapidOCR's default_models.yaml)
ARG OCR_MODELS=https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0
RUN mkdir models && cd models \
 && curl -fsSL --retry 3 -o det.onnx "$OCR_MODELS/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx" \
 && curl -fsSL --retry 3 -o rec.onnx "$OCR_MODELS/onnx/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile.onnx" \
 && curl -fsSL --retry 3 -o dict.txt "$OCR_MODELS/paddle/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile/ppocrv5_latin_dict.txt" \
 && printf '%s  %s\n' 4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae det.onnx b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a rec.onnx | sha256sum -c - \
 && wc -l dict.txt && sha256sum dict.txt

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
 && apt-get install -y --no-install-recommends tzdata ffmpeg libheif-examples libheif-plugin-libde265 webp \
 && if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver; fi \
 && rm -rf /var/lib/apt/lists/* \
 && command -v setpriv && command -v heif-dec && ffmpeg -hide_banner -encoders | grep -q libx264
WORKDIR /app
ENV NODE_ENV=production \
    OCR_MODELS_DIR=/app/models/ocr \
    DATA_DIR=/data \
    PORT=3000 \
    PUID=99 \
    PGID=100
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/dist web/dist
COPY --from=ocr /ocr/node_modules node_modules
COPY --from=ocr /ocr/models models/ocr
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings=ExperimentalWarning", "server/dist/index.js"]
