# nullsink proxy — container image.
#
# Build (from core/):   docker build --platform linux/amd64 -t nullsink:dev .
# Run:                  docker run --rm -p 8080:8080 \
#                         -e ANTHROPIC_API_KEY=sk-... \
#                         -v nullsink-data:/data nullsink:dev
# Health:               curl localhost:8080/healthz   # -> "ok <version>"
#
# The image is a single self-contained binary (Bun --compile embeds the runtime, so
# there are zero npm deps to install) on a shell-less distroless base. That single-
# binary, no-shell shape is what makes the eventual attested-enclave story clean —
# there is nothing for an operator to exec into.

# ── build: compile the proxy to one static-ish linux-x64 binary ──
FROM oven/bun:1.3.14 AS build
WORKDIR /src
# Only what the compile needs (no node_modules, no install — the proxy has no runtime deps).
COPY package.json bunfig.toml tsconfig.json ./
COPY src ./src
RUN bun build --compile --target=bun-linux-x64 src/index.ts --outfile /out/nullsink \
 && mkdir -p /out/data

# ── runtime: glibc + ca-certs only, nonroot, no shell ──
# The binary's only shared-lib deps are core glibc (libc, ld-linux, libpthread, libdl,
# libm — verified via DT_NEEDED); it statically links libstdc++/libgcc and bundles its
# own TLS, so distroless/base (glibc + ca-certificates) is sufficient.
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /out/nullsink /usr/local/bin/nullsink
# Pre-create /data owned by the distroless nonroot uid so the SQLite ledgers open even
# when no volume is mounted.
COPY --from=build --chown=65532:65532 /out/data /data

# The app defaults HOST to loopback (safe on a bare box); inside a container it must bind
# all interfaces so the fronting proxy (Tinfoil shim / Caddy) can reach it.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/balances.db \
    PENDING_DB_PATH=/data/pending.db

EXPOSE 8080

# The two SQLite ledgers (balances + the irreplaceable pending payment↔token link). On
# Tinfoil this maps to an ephemeral ramdisk — durable, sealed storage for /data is the
# open design item, NOT solved here (see internal backlog: "AD enclave self-host").
VOLUME ["/data"]

# No Docker HEALTHCHECK: distroless has no shell/curl. Orchestrators (and Tinfoil's own
# healthcheck config) probe GET /healthz over HTTP instead.
ENTRYPOINT ["/usr/local/bin/nullsink"]
