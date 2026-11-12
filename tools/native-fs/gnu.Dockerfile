# Digest-pinned native compiler and glibc-2.28 sysroot; no QEMU or cross execution.
ARG RUST_IMAGE=rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922
ARG BASE_IMAGE
FROM ${RUST_IMAGE} AS rust
FROM ${BASE_IMAGE}
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ARG NODE_ARCH
ARG NODE_SHA256
RUN curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location "https://nodejs.org/dist/v22.0.0/node-v22.0.0-linux-${NODE_ARCH}.tar.xz" --output /tmp/node.tar.xz && \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --strict && \
    tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local && rm /tmp/node.tar.xz
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/tmp/native-cargo
ENV HOME=/tmp/native-home
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:${PATH}
WORKDIR /source
