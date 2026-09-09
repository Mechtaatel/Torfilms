FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN npm run build:p2p
ENV TORFILMS_BRIDGE_HOST=0.0.0.0 TORFILMS_BRIDGE_NATIVE_RTC=0 TORFILMS_CATALOG_READONLY=1
CMD ["node", "bridge.js"]
