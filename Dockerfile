FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 CLAUDE_DIR=/data/claude CODEX_DIR=/data/codex
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server.js"]
