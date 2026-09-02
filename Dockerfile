# Two stages: the first compiles TypeScript, the second carries only the compiled output and the
# production dependencies. The compiler and the type packages never reach the running image.

FROM node:20-alpine AS build

WORKDIR /app

# Dependencies first, so editing source doesn't reinstall node_modules on every rebuild.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Drop root: the process needs no write access to anything but /tmp.
USER node

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
