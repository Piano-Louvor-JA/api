# Build stage
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build
# Prune devDependencies, keep compiled native modules (better-sqlite3)
# Evita npm ci --omit=dev no runtime (prepare: husky not found)
RUN npm prune --omit=dev

# Runtime stage
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./db/migrations
# WT-5: receiver browser em /palco (serveStatic)
COPY static/ ./static/
RUN mkdir -p data media
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/v1/health').then(r=>{if(!r.ok)throw new Error('unhealthy')}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
