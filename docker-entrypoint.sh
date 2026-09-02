#!/bin/sh
# Seed before serving, so `docker compose up` yields an API with data in it.
#
# A seeding failure logs loudly but does NOT stop the API. The alternative — crash-looping the
# container — hides the reason behind a restart spinner, whereas a live API still answers
# /health and returns an empty, clearly-empty product list that a reviewer can diagnose.
# Re-run by hand at any time with:  docker compose exec api npm run seed
set -e

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "[entrypoint] seeding (SEED_FORCE=${SEED_FORCE:-false})…"
  if node dist/src/scripts/seed.js; then
    echo "[entrypoint] seed complete"
  else
    echo "[entrypoint] ==============================================================="
    echo "[entrypoint] SEED FAILED — the API will start, but data may be missing."
    echo "[entrypoint] Retry with: docker compose exec api npm run seed"
    echo "[entrypoint] ==============================================================="
  fi
else
  echo "[entrypoint] SEED_ON_START=false — skipping seed"
fi

exec "$@"
