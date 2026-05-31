# ott-store on Railway.
#
# Uses the official Playwright image so Chromium + all system libraries are
# preinstalled (Phase 2: ResellKeys browser automation). Pinned to match the
# `playwright` npm version in package.json (1.49.1) so the bundled browser
# revision matches the JS client exactly.
#
# IMPORTANT: WORKDIR is /app so the app's `data/` dir resolves to /app/data,
# which is exactly where the Railway persistent volume (RAILWAY_VOLUME_MOUNT_PATH)
# is mounted — the live store.db + WhatsApp session survive every deploy.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source (node_modules, data/, .git, .env excluded via .dockerignore).
COPY . .

ENV NODE_ENV=production
# Browsers are preinstalled in the base image at this path.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Railway provides PORT at runtime; index.js binds to process.env.PORT.
CMD ["node", "src/index.js"]
