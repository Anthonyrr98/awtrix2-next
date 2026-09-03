#!/bin/sh
set -eu

cd "$(dirname "$0")"
docker load -i awtrix2-next-images.tar
[ -f .env ] || cp .env.example .env
docker compose up -d
docker compose ps
echo "Host: http://SERVER_IP:7000/"
echo "AWTRIX2 Next: http://SERVER_IP:7000/awtrix-next/"

