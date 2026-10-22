# Pictaria Server — single-container bundle.
# No runtime npm dependencies: the image is Node + the source tree.
FROM node:24.22.1-alpine3.24@sha256:feb76650b7195319268c59cb2d419c732d6c499b13bf5296f16ab59eb1f0a4f3

WORKDIR /app

COPY package.json ./
COPY LICENSE ./
COPY src/ src/
COPY public/ public/
COPY prompts/ prompts/
COPY taxonomy/ taxonomy/
COPY bin/ bin/

# All persistent state lives in one mountable volume.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4080 \
    DATABASE_PATH=/data/enrichment.sqlite \
    ALBUMS_DATA_FILE=/data/smart-albums.json \
    FRAME_DB_PATH=/data/frame.db \
    SETTINGS_PATH=/data/settings.json \
    WAKE_WORD_MODELS_DIR=/data/wake-word-models \
    INSIGHTS_DB_PATH=/data/insights.sqlite \
    BACKUP_DIR_DEFAULT=/data/backups

RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 4080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "src/server.mjs"]
