# syntax=docker/dockerfile:1
#
# NetraSetu PHC local backend -- Render deployment, SIH online-demo round
# only. This service normally runs on-site at a PHC with a real MATLAB
# quality gate and a persistent local SQLite file; here it runs with
# QUALITY_GATE_ALLOW_FALLBACK=1 (the existing JS quality-gate port, see
# services/qualityGateFallback.js -- an already-supported, explicit opt-in,
# not a new code path) and an EPHEMERAL SQLite file: Render's free web-service
# filesystem resets on every deploy, which is fine for a demo and wrong for a
# real PHC -- the final round still runs this on-site, unchanged.
#
# Build context is the REPO ROOT (see render.yaml's dockerContext). The
# quality-gate-matlab/ and test/ directories are not needed here and are
# deliberately not copied -- no MATLAB exists on this host.

FROM node:22-slim

# better-sqlite3 has no prebuilt binary for this platform/Node combo and
# falls back to compiling from source (node-gyp) during npm ci -- needs
# Python plus a C++ toolchain. sharp ships its own prebuilt libvips, so this
# is better-sqlite3's requirement alone.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY phc-local-app/backend/package.json phc-local-app/backend/package-lock.json \
     ./phc-local-app/backend/
RUN cd phc-local-app/backend && npm ci --omit=dev

COPY phc-local-app/backend/server.js phc-local-app/backend/loadEnv.js \
     ./phc-local-app/backend/
COPY phc-local-app/backend/db         ./phc-local-app/backend/db
COPY phc-local-app/backend/middleware ./phc-local-app/backend/middleware
COPY phc-local-app/backend/routes     ./phc-local-app/backend/routes
COPY phc-local-app/backend/services   ./phc-local-app/backend/services
COPY phc-local-app/backend/scripts    ./phc-local-app/backend/scripts

ENV NODE_ENV=production
WORKDIR /app/phc-local-app/backend
# Creates the one demo technician login on first start -- `|| true` because
# `technician.js add` exits 1 (not a crash, just process.exitCode) when the
# account already exists, which happens on every restart after the first;
# without `|| true` that would short-circuit this && chain and the server
# would never start again after the very first boot. Fixed password (not
# the script's own random default) so it's known ahead of time rather than
# needing Shell access (not available on Render's free tier) to read it
# back from a log after the fact.
CMD node scripts/technician.js add demo "Demo Technician" --admin --password "Fundus-Comet-52" || true; exec node server.js
