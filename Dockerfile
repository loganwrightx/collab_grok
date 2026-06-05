# Self-contained Docker image for collab-grok
# Build with: docker build -t collab-grok .
# Run with: docker run -p 3000:3000 -e XAI_API_KEY=sk-... collab-grok

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install build dependencies for native modules like better-sqlite3 (node-gyp needs Python, make, g++)
# Use virtual to cleanly remove after
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci \
  && apk del .build-deps

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

# Note: .env.example is committed for reference but not copied into the image.
# Real config comes from environment variables at runtime (XAI_API_KEY etc.)

# tsx is listed in dependencies so we can use it to run the TS server directly


# Environment
ENV NODE_ENV=production
# PORT is provided by the platform (Render, etc.) at runtime.
# The server code falls back to 3000 if not set.

# Expose is documentation only
EXPOSE 3000

# Start command (uses tsx from deps, loads .env if present but prefer env vars)
CMD ["npm", "start"]
