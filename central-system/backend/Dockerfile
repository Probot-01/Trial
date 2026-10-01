# syntax=docker/dockerfile:1
#
# NetraSetu central backend -- Render deployment, SIH online-demo round only.
# Pure Node: no ml-pipeline, no Python, no MATLAB. This deployment always runs
# INFERENCE_BACKEND=remote (see services/gradingOrchestrator.js), which calls
# the separate netrasetu-ml-inference Render service instead of a local
# Python process. ml-pipeline/ is deliberately NOT copied into this image --
# it is ~8GB on disk, almost entirely datasets and training artifacts this
# image never touches. Local dev (npm run dev:all) and a machine that runs
# the real matlab/python backends locally are completely unaffected; this is
# an alternate deploy target, not a replacement for either.
#
# Build context is the REPO ROOT (see render.yaml's dockerContext), and the
# repo's central-system/backend/scripts.* layout is preserved under /app
# rather than flattened, so the existing `npm run migrate` / `npm run
# seed-users` (package.json: `node ../../scripts/...`) work completely
# unmodified -- the same scripts local dev already uses, not a
# Docker-specific migration path.
#
# Run from CMD, not Render's preDeployCommand: Render's free tier does not
# support preDeployCommand at all (confirmed by the Blueprint apply step
# itself refusing render.yaml with it set -- not documented anywhere ahead
# of time). Both scripts are idempotent (see their own headers), so running
# them on every container START rather than once per deploy is still safe
# -- a crash-triggered restart just re-applies already-applied state.

FROM node:22-slim

WORKDIR /app

COPY central-system/backend/package.json central-system/backend/package-lock.json \
     ./central-system/backend/
RUN cd central-system/backend && npm ci --omit=dev

COPY central-system/backend/server.js central-system/backend/loadEnv.js \
     ./central-system/backend/
COPY central-system/backend/config   ./central-system/backend/config
COPY central-system/backend/db       ./central-system/backend/db
COPY central-system/backend/middleware ./central-system/backend/middleware
COPY central-system/backend/routes   ./central-system/backend/routes
COPY central-system/backend/services ./central-system/backend/services

# Repo-root scripts this image's own CMD and the one-off provisioning steps
# need -- all three reach outside central-system/backend by design (shared
# tooling, one key/account per PHC), same relative path math as package.json's
# `npm run migrate`/`npm run seed-users` already use locally. setupCentralDb.js
# is NOT optional: CMD below runs it on every container start (see this
# file's header) -- its absence was previously undetected because nothing
# had exercised this exact path end to end until local testing caught it.
COPY scripts/setupCentralDb.js        ./scripts/setupCentralDb.js
COPY scripts/provisionPhcKey.js       ./scripts/provisionPhcKey.js
COPY scripts/seedDemoUsers.js         ./scripts/seedDemoUsers.js
# Render's free tier has no Shell/Jobs, so the normal one-off
# `npm run provision-phc-key -- --create "<name>"` can't be run
# interactively for this deployment -- this idempotent twin runs from CMD
# instead and prints the new key to ordinary (Shell-free) logs exactly
# once. See its own header for why a restart can't create a duplicate PHC.
COPY scripts/provisionDemoPhcOnce.js  ./scripts/provisionDemoPhcOnce.js

ENV NODE_ENV=production
WORKDIR /app/central-system/backend
# Shell form (not exec-form JSON) so the migrate/seed/provision commands can
# run first; `exec` on the last one so node becomes PID 1 and receives
# SIGTERM directly for a graceful shutdown, instead of an intermediate
# shell swallowing it.
CMD npm run migrate && npm run seed-users && node ../../scripts/provisionDemoPhcOnce.js && exec node server.js
