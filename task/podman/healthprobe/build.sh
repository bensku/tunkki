#!/usr/bin/env bash
# Builds the health probe. The agent binary is x86-64 only for now, so is this.
# The binary is committed, so that deploying does not require Go.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-s -w -buildid=' -o healthprobe .
