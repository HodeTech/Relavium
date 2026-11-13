# Exact Node 22.0.0 version, executed natively in Rust 1.98's musl-1.2.5 profile.
# The Node binary's source image does not establish an older executed libc baseline.
# node:22.0.0-alpine3.19 baseline
FROM node@sha256:9459e243f620fff19380c51497493e91db1454f5a30847efe5bc5e50920748d5 AS node
# rust:1.98.0-alpine3.22 baseline
FROM rust@sha256:2e452153b2dc6bed8ef123c4801cfd3f637e7c092846f974ecdce5e64af3120c
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
ENV CARGO_HOME=/tmp/native-cargo
ENV HOME=/tmp/native-home
ARG FIXTURE_UID=10001
ARG FIXTURE_GID=10001
RUN mkdir -p /relavium-native-lower /fixture && \
    chown "${FIXTURE_UID}:${FIXTURE_GID}" /fixture && chmod 700 /fixture && \
    for name in success append cancel error crash unavailable \
      changed-bytes changed-mode changed-mtime changed-identity changed-xattr \
      changed-nlink changed-ctime host-success host-append host-changed host-cancel \
      host-publish-cancel host-committed-cancel; do \
      printf 'before' > "/relavium-native-lower/$name"; \
    done && \
    chown -R "${FIXTURE_UID}:${FIXTURE_GID}" /relavium-native-lower && \
    chmod 700 /relavium-native-lower && chmod 600 /relavium-native-lower/*
ENV RELAVIUM_TEST_LOWER_ROOT=/relavium-native-lower
WORKDIR /source
# CI supplies its source-owner UID:GID; direct invocation also defaults to non-root.
USER 10001:10001
