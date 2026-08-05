FROM node:20-alpine

# Install git
RUN apk update && apk add --no-cache ffmpeg git

# Create the directory!
RUN mkdir -p /usr/src/bot
WORKDIR /usr/src/bot

# Copy and Install our bot
COPY package.json /usr/src/b"params": "8AEB",ot
RUN npm install

# Our precious bot
COPY . /usr/src/bot

# Start me!
CMD ["node", "index.js"]