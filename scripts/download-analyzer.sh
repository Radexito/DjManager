#!/usr/bin/env bash
# Download the mixxx-analyzer standalone binary for local development.
# Usage: bash scripts/download-analyzer.sh
set -euo pipefail

DEST="build-resources"
mkdir -p "$DEST"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Linux)   ASSET="linux-x86_64";   EXT="tar.gz" ;;
  Darwin)  ASSET="macos-arm64";    EXT="zip"    ;;
  MINGW*|CYGWIN*|MSYS*) ASSET="windows-x86_64"; EXT="zip" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

RELEASE_JSON=$(curl -s https://api.github.com/repos/Radexito/mixxx-analyzer/releases/latest)
URL=$(echo "$RELEASE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
assets = [a for a in data['assets'] if '${ASSET}' in a['name']]
print(assets[0]['browser_download_url'])
")

echo "Downloading mixxx-analyzer for ${OS}/${ARCH}: $URL"

if [ "$EXT" = "tar.gz" ]; then
  curl -L "$URL" | tar -xz
  find . -maxdepth 3 -name "mixxx-analyzer" -not -path "./.git/*" \
    | head -1 | xargs -I{} mv {} "$DEST/analysis"
else
  curl -L "$URL" -o /tmp/analyzer.zip
  unzip -q /tmp/analyzer.zip -d /tmp/analyzer-tmp
  BINARY=$(find /tmp/analyzer-tmp -name "mixxx-analyzer*" | head -1)
  EXE_NAME="analysis"
  [[ "$BINARY" == *.exe ]] && EXE_NAME="analysis.exe"
  mv "$BINARY" "$DEST/$EXE_NAME"
  rm -rf /tmp/analyzer-tmp /tmp/analyzer.zip
fi

chmod +x "$DEST/analysis" 2>/dev/null || true
echo "✅ Binary saved to $DEST/analysis"
