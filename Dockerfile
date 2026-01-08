# Application container for crypto-hack services.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build

# Runtime image for service execution.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4001 4002 4003 4004 4005 4006
CMD ["node", "dist/src/services/auction-engine/index.js"]
