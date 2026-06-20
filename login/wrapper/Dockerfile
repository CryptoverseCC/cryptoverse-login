# syntax=docker/dockerfile:1
#
# Build context is the Cargo workspace root (`login/`).
#   docker build -f wrapper/Dockerfile <repo>/login
#
# The wrapper's HTML templates are compiled into the binary (include_str!), so
# the runtime image only needs the binary.

FROM rust:1.95-bookworm AS backend
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core ./core
COPY wrapper ./wrapper
# The workspace lists `login` as a member, so its manifest+sources must be
# present for resolution even though we only build the wrapper binary.
COPY login/Cargo.toml ./login/Cargo.toml
COPY login/src ./login/src
RUN cargo build --release -p wrapper

FROM debian:bookworm-slim AS final
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=backend /src/target/release/wrapper /usr/local/bin/wrapper
ENV PORT=3000
USER app
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["wrapper"]
