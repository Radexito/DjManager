#!/bin/bash
set -e

mkdir -p ffmpeg
cd ffmpeg

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  echo "Downloading static Linux FFmpeg..."
  curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ
  mv ffmpeg-*-static/ffmpeg .
  mv ffmpeg-*-static/ffprobe .
  chmod +x ffmpeg ffprobe
  rm -rf ffmpeg-*-static
elif [[ "$OSTYPE" == "darwin"* ]]; then
  echo "MacOS installation: please install via brew 'brew install ffmpeg'"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  echo "Windows: download ffmpeg binaries manually or use winget/choco"
else
  echo "Unknown OS: please install FFmpeg manually"
fi

echo "FFmpeg installed."
