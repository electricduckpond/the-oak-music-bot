# Use an official Node.js LTS base image (Debian-based for native module compatibility)
FROM node:24-slim

# Install system dependencies required by:
# - @discordjs/opus (build tools + libs)
# - libsodium-wrappers
# - ffmpeg-static fallback
# - youtube-dl-exec (yt-dlp)
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    libtool \
    autoconf \
    automake \
    ffmpeg \
    wget \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install yt-dlp manually (more reliable than pip inside Docker)
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -O /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the bot code
COPY . .

# Ensure ffmpeg-static is used if system ffmpeg is missing
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Run the bot
CMD ["npm", "run", "bot"]