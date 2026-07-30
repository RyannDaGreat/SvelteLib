#!/usr/bin/env bash
# Command. Downloads the runtimes the SHIPPED bundle vendors (the user ruling:
# "could installing node and uv be done locally inside the bundle?" — yes):
#   runtimes/node/  — the official self-contained node dist (node + npm)
#   runtimes/uv     — the single static uv binary (bootstraps Python itself)
# Idempotent (skips what already exists and runs --version as the sanity
# check); pinned versions so builds are reproducible. Run by `npm run
# package:dmg` before electron-builder; CI runs the same script.
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION=22.14.0
UV_VERSION=0.6.10
ARCH=arm64   # Apple Silicon; an x64 build would parameterize this

mkdir -p runtimes

if [ ! -x "runtimes/node/bin/node" ]; then
  echo "fetching node ${NODE_VERSION}…"
  curl -fL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.xz" -o runtimes/node.tar.xz
  rm -rf runtimes/node
  tar -xf runtimes/node.tar.xz -C runtimes
  mv "runtimes/node-v${NODE_VERSION}-darwin-${ARCH}" runtimes/node
  rm runtimes/node.tar.xz
fi
runtimes/node/bin/node --version

if [ ! -x "runtimes/uv" ]; then
  echo "fetching uv ${UV_VERSION}…"
  curl -fL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz" -o runtimes/uv.tar.gz
  tar -xzf runtimes/uv.tar.gz -C runtimes
  mv runtimes/uv-aarch64-apple-darwin/uv runtimes/uv
  rm -rf runtimes/uv-aarch64-apple-darwin runtimes/uv.tar.gz
fi
runtimes/uv --version

echo "runtimes ready."
