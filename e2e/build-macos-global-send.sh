#!/usr/bin/env bash
set -euo pipefail

xcrun swiftc -parse-as-library -swift-version 5 e2e/macos-global-send.swift -o "$1" \
  -framework AppKit -framework Carbon -framework CoreGraphics
