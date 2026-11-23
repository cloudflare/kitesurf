# syntax=docker/dockerfile:1

# The Kitesurf engine on workerd alone, for CDP clients such as Playwright and Puppeteer. Build it
# from the repository root:
#
#   docker build -f docker/Dockerfile -t kitesurf .
#   docker run --rm -p 127.0.0.1:8787:8787 kitesurf
#
# Build arguments:
#   DEVTOOLS=1     bundle the Chrome DevTools frontend at /inspector/ (50 MB, 11 MB compressed)
#   BAZEL_FLAGS    extra `bazel build` flags, for example --jobs=4
#   VERSION        the engine's KITESURF_VERSION

ARG NODE_IMAGE=node:24-bookworm-slim

# The engine bundle is the same on every platform, so it builds once, natively on the build host.
FROM --platform=$BUILDPLATFORM debian:bookworm AS engine-build
ARG BUILDARCH
ARG DEVTOOLS=0
ARG BAZEL_FLAGS=
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ gcc git libc6-dev \
    python3 unzip xz-utils zip \
  && rm -rf /var/lib/apt/lists/*
# Behind a TLS-inspecting proxy, `--secret id=ca_certificates,src=<root.pem>` adds its root to the
# system store and, through a JRE's store, to Bazel's downloader: its JVM ignores the system store.
RUN --mount=type=secret,id=ca_certificates \
  set -eu; \
  if [ -s /run/secrets/ca_certificates ]; then \
    cp /run/secrets/ca_certificates /usr/local/share/ca-certificates/extra.crt; \
    update-ca-certificates; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates-java openjdk-17-jre-headless; \
    rm -rf /var/lib/apt/lists/*; \
    echo "startup --host_jvm_args=-Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts" \
      > /etc/bazel.bazelrc; \
  fi
# Bazelisk downloads the Bazel that .bazelversion pins.
RUN set -eu; \
  case "$BUILDARCH" in \
    amd64) sha=a248ae2b2b62b5baebb748f6fba7203bff1a27e5d01b55399a8406744cb539e8 ;; \
    arm64) sha=b2bcc040c213b44586b121bda6d983c35df121b917c3a7a66fb16f2fa0df1a4f ;; \
    *) echo "no Bazelisk build for $BUILDARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSLo /usr/local/bin/bazel \
    "https://github.com/bazelbuild/bazelisk/releases/download/v1.30.0/bazelisk-linux-$BUILDARCH"; \
  echo "$sha  /usr/local/bin/bazel" | sha256sum -c -; \
  chmod +x /usr/local/bin/bazel
WORKDIR /src
COPY . .
# The cache mount keeps Bazelisk's download and Bazel's output base between builds. bazel-bin
# points into it, so the outputs are copied out in the same step.
RUN --mount=type=cache,id=kitesurf-bazel,target=/root/.cache \
  set -eu; \
  flags=""; \
  if [ "$DEVTOOLS" = 1 ]; then flags="--config=devtools"; fi; \
  bazel build --lockfile_mode=error $flags $BAZEL_FLAGS //docker:engine; \
  mkdir -p /out; \
  cp -RL bazel-bin/packages/engine/dist bazel-bin/packages/engine/public \
    bazel-bin/docker/config.capnp bazel-bin/docker/env.sh /out/; \
  bazel shutdown

# `--build-context engine=<dir>` replaces this stage with a bundle built outside the image, as the
# Docker workflow does. The engine-build stage then never runs.
FROM scratch AS engine
COPY --from=engine-build /out/ /

# workerd is per platform: install the release that the lockfile pins for the target, the one that
# Miniflare runs for the WPT and e2e lanes.
FROM ${NODE_IMAGE} AS workerd-install
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/engine-server/package.json packages/engine-server/
RUN --mount=type=secret,id=ca_certificates \
  set -eu; \
  if [ -s /run/secrets/ca_certificates ]; then \
    export NODE_EXTRA_CA_CERTS=/run/secrets/ca_certificates; \
  fi; \
  npm install --global pnpm@9.15.4; \
  pnpm install --frozen-lockfile --prod --ignore-scripts --filter @kitesurf/engine-server; \
  set -- node_modules/.pnpm/@cloudflare+workerd-linux-*/node_modules/@cloudflare/*/bin/workerd; \
  if [ $# -ne 1 ] || [ ! -f "$1" ]; then echo "expected one workerd, found: $*" >&2; exit 1; fi; \
  mkdir -p /out; \
  cp "$1" /out/workerd

# `--build-context workerd=<dir>` replaces this stage with a directory that holds another workerd
# binary for the target platform, such as a patched build.
FROM scratch AS workerd
COPY --from=workerd-install /out/workerd /workerd

FROM debian:bookworm-slim
# workerd verifies TLS peers against the system store; curl runs the health check.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin kitesurf
COPY LICENSE NOTICE /usr/share/doc/kitesurf/
COPY licenses /usr/share/doc/kitesurf/licenses
COPY --from=workerd /workerd /usr/local/bin/workerd
COPY --from=engine / /opt/kitesurf
COPY docker/front.js docker/entrypoint.sh /opt/kitesurf/
ARG VERSION=dev
LABEL org.opencontainers.image.title="Kitesurf" \
  org.opencontainers.image.description="Kitesurf browser engine on workerd, served over CDP" \
  org.opencontainers.image.source="https://github.com/cloudflare/kitesurf" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="$VERSION"
# KITESURF_NATIVE_EVAL runs CDP evaluation and page eval on V8 instead of boa, which only a local
# runtime allows. An empty value keeps boa, as on Cloudflare. The other engine vars default to
# the values in env.sh, and workerd's V8 flags are in its config (//docker:workerd_config).
ENV KITESURF_PORT=8787 \
  KITESURF_NATIVE_EVAL=1 \
  KITESURF_VERSION=$VERSION
USER kitesurf
WORKDIR /opt/kitesurf
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --start-interval=1s \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${KITESURF_PORT}/health" || exit 1
ENTRYPOINT ["/opt/kitesurf/entrypoint.sh"]
