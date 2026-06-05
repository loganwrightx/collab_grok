# Self-contained Docker image for collab-grok
# Build with: docker build -t collab-grok .
# Run with: docker run -p 3000:3000 -e XAI_API_KEY=sk-... collab-grok

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all deps (including dev for build)
RUN npm ci

# Copy source
COPY . .

# Build client (and server uses tsx at runtime)
RUN npm run build:client

# Production image
FROM node:20-alpine

WORKDIR /app

# Copy only necessary files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/.env.example ./.env.example

# Install only production deps? But we need tsx for start
# tsx is in dependencies, so ok

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start command (uses tsx from deps, loads .env if present but prefer env vars)
CMD ["npm", "start"]
