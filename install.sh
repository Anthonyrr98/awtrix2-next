#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Install Docker Engine with the Compose plugin first." >&2
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "The Docker Compose plugin is missing." >&2
    exit 1
fi

if [ ! -f runtime/awtrix.jar ] && [ ! -f runtime/awtrix2-host.jar ]; then
    echo "AWTRIX2 Host runtime is missing." >&2
    echo "Copy the complete, legally obtained Host directory into: $(pwd)/runtime" >&2
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from the safe defaults. Review it when publishing ports." 
fi

docker compose up -d --build
docker compose ps
echo "AWTRIX2 Next is starting. Open http://SERVER_IP:7100/"

