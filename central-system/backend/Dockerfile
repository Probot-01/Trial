# syntax=docker/dockerfile:1
#
# NetraSetu central backend -- Render deployment, SIH online-demo round only.
# Pure Node: no ml-pipeline, no Python, no MATLAB. This deployment always runs
# INFERENCE_BACKEND=remote (see services/gradingOrchestrator.js), which calls
# the separate ml-inference-service on Hugging Face Spaces instead of a local
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
# unmodified as Render's preDeployCommand -- the same scripts local dev
# already uses, not a Docker-specific migration path.

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

# The one-off provisioning scripts (db/migrations are run via package.json's
# own `npm run migrate`, already copied above with db/) -- these two reach
# outside central-system/backend by design (one key/account per PHC, shared
# tooling), same relative path math as `npm run migrate`.
COPY scripts/provisionPhcKey.js ./scripts/provisionPhcKey.js
COPY scripts/seedDemoUsers.js   ./scripts/seedDemoUsers.js

ENV NODE_ENV=production
WORKDIR /app/central-system/backend
CMD ["node", "server.js"]
