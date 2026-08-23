# AWTRIX2 Next bridge

This service exposes an AWTRIX3-style HTTP surface in front of an AWTRIX2 Host and its ESP8266 controller.

Set `AWTRIX_HOST_URL` to the reachable AWTRIX2 Host address. `AWTRIX_PUBLIC_IP` is optional and is only used for diagnostic display metadata.

Main endpoints include `/api/health`, `/api/stats`, `/api/notify`, `/api/custom`, `/api/automations`, `/api/settings`, and `/api/power`.

Pillow decodes uploaded GIFs. `websocket-client` provides reliable application switching after the B4J page handshake.

