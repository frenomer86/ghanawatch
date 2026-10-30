# GhanaWatch production image: one image, two roles (web, pipeline).
# Build:  docker build -t ghanawatch .
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Without this the optional onnxruntime-node (detector 3.0) fails its GPU download at install and is silently
# dropped from the image; its CPU runtime ships inside the package.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build prerenders pages without a database; dynamic pages render at request time.
RUN APP_SECRET=buildtime0123456789abcdef0123456789abcdef npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app ./
RUN mkdir -p /app/.data && chown app:app /app/.data
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:3000/api/v1/freshness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
