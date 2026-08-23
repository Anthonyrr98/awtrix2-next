#!/bin/sh
set -eu

if [ -f /opt/awtrix2/awtrix.jar ]; then
    HOST_JAR=/opt/awtrix2/awtrix.jar
elif [ -f /opt/awtrix2/awtrix2-host.jar ]; then
    HOST_JAR=/opt/awtrix2/awtrix2-host.jar
else
    echo "AWTRIX2 Host runtime missing." >&2
    echo "Copy your legally obtained Host files into ./runtime first." >&2
    echo "Expected awtrix.jar or awtrix2-host.jar in that directory." >&2
    exit 64
fi

mkdir -p /opt/awtrix2/Apps /opt/awtrix2/config
tar -xOf /opt/awtrix2-next/GifPlayer.tar.gz GifPlayer.jar > /opt/awtrix2/Apps/GifPlayer.jar

exec java ${JAVA_OPTS:-"-Xms64m -Xmx768m -XX:+ExitOnOutOfMemoryError"} -jar "$HOST_JAR"

