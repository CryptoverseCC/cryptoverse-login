# ------------------------------------------------------------------------------
# Cargo Build Stage
# ------------------------------------------------------------------------------

FROM rust:latest as cargo-build

ARG name

RUN apt-get update

RUN apt-get install musl-tools -y

RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /usr/src/${name}

COPY Cargo.toml Cargo.toml

RUN mkdir src/

RUN echo "fn main() {println!(\"if you see this, the build broke\")}" > src/main.rs

RUN RUSTFLAGS=-Clinker=musl-gcc cargo build --release --target=x86_64-unknown-linux-musl

RUN rm -f target/x86_64-unknown-linux-musl/release/deps/${name}*

COPY . .

RUN RUSTFLAGS=-Clinker=musl-gcc cargo build --release --target=x86_64-unknown-linux-musl

# ------------------------------------------------------------------------------
# Final Stage
# ------------------------------------------------------------------------------

FROM alpine:latest

ARG name

RUN addgroup -g 1000 ${name}

RUN adduser -D -s /bin/sh -u 1000 -G ${name} ${name}

WORKDIR /home/${name}/bin/

COPY --from=cargo-build /usr/src/${name}/target/x86_64-unknown-linux-musl/release/${name} .

RUN chown ${name}:${name} ${name}

USER ${name}

CMD ["./${name}"]
