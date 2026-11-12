# Node's exact public runtime floor, running natively with Rust 1.98's musl-1.2.5 baseline.
FROM node:22.0.0-alpine3.19@sha256:9459e243f620fff19380c51497493e91db1454f5a30847efe5bc5e50920748d5 AS node
FROM rust:1.98.0-alpine3.22@sha256:2e452153b2dc6bed8ef123c4801cfd3f637e7c092846f974ecdce5e64af3120c
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
ENV CARGO_HOME=/tmp/native-cargo
ENV HOME=/tmp/native-home
WORKDIR /source
