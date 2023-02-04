FROM node:alpine AS builder

ENV NODE_OPTIONS=--openssl-legacy-provider

RUN apk add --no-cache \
  git \
  python3 \
  alpine-sdk \
  make \
  g++ \
  jpeg-dev \
  cairo-dev \
  giflib-dev \
  pango-dev

RUN mkdir -p /tmp/builder
WORKDIR /tmp/builder

FROM builder as frontendBuilder

ENV NODE_OPTIONS=--openssl-legacy-provider
ENV NODE_ENV=production

COPY frontend/package.json .
COPY frontend/yarn.lock .
RUN yarn install --only=production
COPY frontend .
RUN yarn build

FROM builder as backendBuilder

ENV NODE_OPTIONS=--openssl-legacy-provider
#ENV NODE_ENV=production

COPY backend/package.json .
COPY backend/yarn.lock .
RUN yarn
COPY backend .
RUN npx webpack

FROM node:alpine as final

RUN apk add --no-cache dumb-init

ENV NODE_OPTIONS=--openssl-legacy-provider
ENV NODE_ENV=production

RUN mkdir -p /app
WORKDIR /app

COPY --chown=node:node --from=backendBuilder /tmp/builder/build/ /app/
COPY --chown=node:node --from=frontendBuilder /tmp/builder/build/ /app/public/login/

RUN mkdir -p /app/views/
RUN mv /app/public/login/index.html /app/views/index.html

USER node

CMD ["dumb-init", "node", "--enable-source-maps", "/app/server.js"]
