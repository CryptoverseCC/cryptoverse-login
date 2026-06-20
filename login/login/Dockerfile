# syntax=docker/dockerfile:1
#
# Build context is the Cargo workspace root (`login/`), because the `login`
# binary and the shared `core` crate live in the same workspace.
#   docker build -f login/Dockerfile <repo>/login

############################################
# Stage 1 — build the React/TS SPA (thin)  #
############################################
FROM node:20-bookworm-slim AS frontend
# Native build deps kept from the previous image so optional native modules in
# the production dependency tree still compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libgif-dev libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ENV NODE_ENV=production
COPY login/frontend/package.json login/frontend/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY login/frontend ./
# Storybook is a dev-only dependency and not installed in this image.
RUN rm -rf src/stories
RUN yarn build
# Output: /build/build/{static/, sentry.min.js, index.html, ...}

############################################
# Stage 2 — build the Rust `login` binary  #
############################################
FROM rust:1.95-bookworm AS backend
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core ./core
COPY login/Cargo.toml ./login/Cargo.toml
COPY login/src ./login/src
COPY wrapper ./wrapper
# Compile only the login binary (its deps include the shared core crate).
RUN cargo build --release -p login

############################################
# Stage 3 — runtime                        #
############################################
FROM debian:bookworm-slim AS final
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
WORKDIR /app

COPY --from=backend /src/target/release/login /usr/local/bin/login
# The SPA is served under the `/login` URL prefix, so place the build at
# public/login. `index.html` is the dynamic minijinja template — move it out of
# the static tree into templates/.
COPY --from=frontend /build/build /app/public/login
RUN mkdir -p /app/templates \
    && mv /app/public/login/index.html /app/templates/index.html \
    && chown -R app:app /app

ENV STATIC_DIR=/app/public \
    INDEX_TEMPLATE=/app/templates/index.html \
    PORT=3000
USER app
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["login"]
