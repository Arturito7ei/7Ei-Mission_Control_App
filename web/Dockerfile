# 7Ei Mission Control web (Next.js) — self-host image (MCA-DIST S5.3).
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Web degrades gracefully without Clerk keys at build time (trusted-local mode).
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
