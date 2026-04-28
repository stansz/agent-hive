FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

ENV PI_TELEMETRY=0
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/index.js"]
