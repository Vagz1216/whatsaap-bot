FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
COPY validate-env.js ./validate-env.js
COPY get-chat-id.js ./get-chat-id.js

RUN mkdir -p /app/data/wa-auth && chown -R app:app /app
USER app

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 CMD node scripts/healthcheck.js
CMD ["npm", "start"]
