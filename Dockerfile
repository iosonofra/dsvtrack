# ==============================================================================
# DSV Tracking Center - Dockerfile (Alpine Linux)
# ==============================================================================

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Installazione dipendenze minime per HTTPS e timezone
RUN apk add --no-cache tzdata ca-certificates

# Copia e installazione dipendenze di produzione
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional

# Copia dei sorgenti applicativi
COPY src ./src
COPY public ./public
COPY .env.example ./.env.example

# Creazione cartella persistente per dati
RUN mkdir -p /app/data && chown -R node:node /app

VOLUME ["/app/data"]

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
