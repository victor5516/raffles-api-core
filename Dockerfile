# --- BUILD STAGE ---
    FROM node:20-alpine AS builder

    WORKDIR /app

    # Install dependencies
    COPY package*.json ./
    RUN npm ci

    # Copy source code
    COPY . .

    # Build the application
    RUN npm run build

    # --- PRODUCTION STAGE ---
    FROM node:20-alpine AS production

    WORKDIR /app

    ENV NODE_ENV production

    COPY package*.json ./

    # Install only production dependencies (save space)
    RUN npm ci --only=production && npm cache clean --force

    # Copy the build from the previous stage
    COPY --from=builder /app/dist ./dist

    USER node

    EXPOSE 3000

    CMD ["node", "dist/src/main.js"]