FROM node:14-alpine AS builder

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

COPY frontend/package.json .
COPY frontend/yarn.lock .
COPY frontend/deps ./deps
RUN yarn
COPY frontend .
RUN yarn build

FROM builder as backendBuilder

COPY backend/package.json .
COPY backend/yarn.lock .
RUN yarn
COPY backend .
RUN npx webpack

FROM node:alpine

RUN mkdir -p /app
WORKDIR /app

COPY --from=backendBuilder /tmp/builder/build/ /app/
COPY --from=frontendBuilder /tmp/builder/build/ /app/public/login/

RUN mkdir -p /app/views/
RUN mv /app/public/login/index.html /app/views/index.html

ENTRYPOINT node /app/server.js
