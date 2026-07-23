# Use Node.js LTS
FROM node:22-alpine

WORKDIR /app

# Copy package.json first for layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy everything else
COPY . .

# Railway sets PORT env; default fallback 3002
ENV PORT=3002

EXPOSE 3002

CMD ["node", "standalone-server.mjs"]
