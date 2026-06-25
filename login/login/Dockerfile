# syntax=docker/dockerfile:1
#
# Build context is the Cargo workspace root (`login/`), because the `login`
# binary and the shared `core` crate live in the same workspace.
#   docker build -f login/Dockerfile <repo>/login

############################################
# Stage 1 — build the React/TS SPA (thin)  #
############################################
FROM node:20-bookworm-slim AS frontend
# The Vite/wagmi/MUI toolchain is pure JS (esbuild ships prebuilt binaries), so
# no native build toolchain is needed — just TLS roots for the registry.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# NB: do NOT set NODE_ENV=production before install — Vite, @vitejs/plugin-react
# and typescript are devDependencies and yarn would skip them. `vite build`
# always builds in production mode regardless.
COPY login/frontend/package.json login/frontend/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY login/frontend ./
# Storybook stories are dev-only and not reachable from the app entry points.
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
# Server-rendered minijinja templates (device verification page) are bundled into
# the binary via include_str!, so they must be present at compile time.
COPY login/templates ./login/templates
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
