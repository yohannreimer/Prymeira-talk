#!/usr/bin/env bash
set -euo pipefail
# Preserve stdin, filenames and generated files for the real media tests. These tools need no network.
exec docker run --rm -i --network none \
  --user "$(id -u):$(id -g)" \
  --volume /tmp:/tmp --volume /private/tmp:/private/tmp \
  --volume "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}:${GITHUB_WORKSPACE}" \
  --workdir "$PWD" \
  prymeira-talk-validation-media "$(basename "$0")" "$@"
