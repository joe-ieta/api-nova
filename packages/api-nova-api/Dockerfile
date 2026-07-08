# Multi-stage Docker build for NestJS application
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json .npmrc ./
COPY packages/api-nova-api/package.json ./packages/api-nova-api/package.json
COPY packages/api-nova-parser/package.json ./packages/api-nova-parser/package.json
COPY packages/api-nova-server/package.json ./packages/api-nova-server/package.json

# Install dependencies
RUN npm ci --workspace api-nova-api --workspace api-nova-parser --workspace api-nova-server --include-workspace-root

# Copy source code
COPY tsconfig.json ./tsconfig.json
COPY packages/api-nova-api ./packages/api-nova-api
COPY packages/api-nova-parser ./packages/api-nova-parser
COPY packages/api-nova-server ./packages/api-nova-server

# Build application
RUN npm run build --workspace api-nova-parser && \
    npm run build --workspace api-nova-server && \
    npm run build --workspace api-nova-api

# Production stage
FROM node:20-alpine AS production

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json .npmrc ./
COPY packages/api-nova-api/package.json ./packages/api-nova-api/package.json
COPY packages/api-nova-parser/package.json ./packages/api-nova-parser/package.json
COPY packages/api-nova-server/package.json ./packages/api-nova-server/package.json

# Install production dependencies only
RUN npm ci --omit=dev --workspace api-nova-api --workspace api-nova-parser --workspace api-nova-server --include-workspace-root

# Copy built application from builder stage
COPY --from=builder /app/packages/api-nova-api/dist ./packages/api-nova-api/dist
COPY --from=builder /app/packages/api-nova-api/public ./packages/api-nova-api/public
COPY --from=builder /app/packages/api-nova-parser/dist ./packages/api-nova-parser/dist
COPY --from=builder /app/packages/api-nova-server/dist ./packages/api-nova-server/dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nestjs -u 1001

# Change ownership of the app directory
RUN chown -R nestjs:nodejs /app
USER nestjs

# Expose port
EXPOSE 9001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:9001/health || exit 1

# Start application
CMD ["node", "packages/api-nova-api/dist/src/main.js"]
