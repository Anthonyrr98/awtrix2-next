#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker Engine and the Compose plugin are required." >&2
    exit 1
fi

if [ ! -f runtime/awtrix.jar ] && [ ! -f runtime/awtrix2-host.jar ]; then
    echo "Place your AWTRIX2 Host runtime in ./runtime first." >&2
    exit 1
fi

rm -rf .bundle-runtime dist-private
mkdir -p .bundle-runtime dist-private
trap 'rm -rf .bundle-runtime' EXIT INT TERM

# Exclude machine-specific state and credentials from the reusable image.
tar -C runtime \
    --exclude='./config' \
    --exclude='./logs' \
    --exclude='./backups' \
    --exclude='./Apps/*.ax' \
    --exclude='*.log' \
    -cf - . | tar -C .bundle-runtime -xf -

docker build -f docker/Dockerfile.host-bundled -t awtrix2-next-host:bundle .
docker build \
    --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://pypi.org/simple}" \
    -f docker/Dockerfile.bridge \
    -t awtrix2-next-bridge:bundle .
docker build -f docker/Dockerfile.gateway -t awtrix2-next-gateway:bundle .
docker save -o dist-private/awtrix2-next-images.tar \
    awtrix2-next-host:bundle \
    awtrix2-next-bridge:bundle \
    awtrix2-next-gateway:bundle
cp compose.private.yaml dist-private/compose.yaml
cp .env.example dist-private/.env.example
cp deploy-private.sh dist-private/deploy.sh
tar -czf awtrix2-next-private-bundle.tar.gz -C dist-private .

echo "Created: awtrix2-next-private-bundle.tar.gz"
echo "Keep it private: it contains your AWTRIX2 Host binary."
