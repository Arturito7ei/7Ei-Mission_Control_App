FROM node:22-alpine

WORKDIR /app

# Install ALL dependencies (tsx is in devDeps, needed to run TypeScript)
COPY package*.json ./
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Run TypeScript source directly with tsx (no tsc build step needed)
CMD ["npx", "tsx", "src/index.ts"]
