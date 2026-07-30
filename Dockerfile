# Build stage
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

# Production stage
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Expose port
EXPOSE 3002

# Start server
CMD ["node", "server.js"]
