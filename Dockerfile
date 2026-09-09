FROM node:20-bookworm-slim

# python3, make, g++ dibutuhkan untuk mengompilasi native binding better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Folder untuk database SQLite. Di Coolify, mount volume persisten ke path ini
# (Storage -> Add -> Destination Path: /app/data) supaya data peserta tidak
# hilang setiap kali aplikasi di-redeploy.
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
