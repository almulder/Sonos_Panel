# Debian-based "slim" rather than Alpine -- avoids any potential
# musl-libc compatibility issues with native dependencies in the
# package tree, at the cost of a somewhat larger image. Worth it for a
# home-server deployment where reliability matters more than a few
# extra MB.
FROM node:18-slim

WORKDIR /app

# Install dependencies first (separately from copying the rest of the
# source) so Docker can cache this layer -- rebuilds after a code-only
# change don't need to re-run npm install.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY public/ ./public/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
