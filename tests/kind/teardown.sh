#!/usr/bin/env bash
set -euo pipefail
export KIND_EXPERIMENTAL_PROVIDER=podman
kind delete cluster --name cryptoverse-login
echo "kind cluster 'cryptoverse-login' deleted."
