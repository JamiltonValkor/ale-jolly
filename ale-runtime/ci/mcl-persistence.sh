#!/usr/bin/env bash
# Remote Cloud Build only. No images are published and no VM is provisioned.
set -euo pipefail

if [ "${MCL_REMOTE_PERSISTENCE:-}" != 1 ]; then
  printf '%s\n' 'Set MCL_REMOTE_PERSISTENCE=1 only in the authorized remote build.' >&2
  exit 2
fi

: "${BUILD_ID:?Cloud Build identifier required}"
: "${MCL_BRAIN_IMAGE:?Current source Brain image required}"
mcl_falkor_name="mcl-persistence-${BUILD_ID}"
mcl_falkor_image='falkordb/falkordb:v4.22.1@sha256:b0bdcac2cbaff989e77cb0610439b7a9289e86de033ccbbd4368b66fb680ae7a'

# The name is unique to this build. Never remove a container we did not create.
mcl_created=0
cleanup() {
  if [ "$mcl_created" = 1 ]; then
    docker rm -f "$mcl_falkor_name" >/dev/null
  fi
}
trap cleanup EXIT

docker run --detach --name "$mcl_falkor_name" --network cloudbuild "$mcl_falkor_image" >/dev/null
mcl_created=1
mcl_ready=0
for ((mcl_poll=0; mcl_poll<30; mcl_poll++)); do
  if docker exec "$mcl_falkor_name" redis-cli PING 2>/dev/null | grep -qx PONG; then
    mcl_ready=1
    break
  fi
  sleep 1
done
[ "$mcl_ready" = 1 ] || { printf '%s\n' 'Disposable FalkorDB did not become ready.' >&2; exit 1; }

docker run --rm --network cloudbuild --entrypoint python \
  --volume /workspace:/workspace --workdir /workspace/brain \
  "$MCL_BRAIN_IMAGE" tests/integration/mcl_persistence_canary.py --host "$mcl_falkor_name"
