FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.mjs ./
COPY src/ ./src/
ENV STEAMEDCLAW_BASE_URL=https://steamedclaw.com
ENV STEAMEDCLAW_STATE_DIR=/data/steamedclaw
# Inside a container the MCP port must be reachable from the compose network.
ENV HOST=0.0.0.0
ENV PORT=8765
EXPOSE 8765
CMD ["node", "index.mjs"]
