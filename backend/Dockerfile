FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install all dependencies (including tsx for running TypeScript)
COPY package*.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Run TypeScript source directly with tsx (no tsc build step needed)
CMD ["npx", "tsx", "src/index.ts"]
