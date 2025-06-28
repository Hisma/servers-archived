# Runtime stage only (dist folder present)
FROM node:24-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Chromium & Puppeteer runtime deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      wget gnupg \
      fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
      libxss1 libgtk2.0-0 libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install production JS dependencies
COPY package.json ./
RUN npm install --only=production --ignore-scripts

# Copy built output
COPY dist ./dist

# Run as non-root user
USER node

EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
