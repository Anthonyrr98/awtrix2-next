# AWTRIX2 Next

An unofficial, non-commercial AWTRIX2 extension focused on reliable remote operation. It combines an ESP8266 controller firmware, an AWTRIX2-to-AWTRIX3-style HTTP bridge, and a WAN-stable GIF player.

## Highlights

- Offline clock: when the Host connection is lost, the matrix keeps showing local time with a red offline indicator.
- Automatic recovery: throttled reconnect attempts and controller restart after a prolonged Host outage.
- Stable GIF playback: 4 FPS playback, a 120-second hard limit, playlists, and automatic recovery.
- Web control panel: notifications, custom apps, GIF upload/playback, automations, settings, and system health.
- Watchdog deployment files for Linux/systemd.

## Repository layout

- `controller/` — PlatformIO ESP8266 controller source, bundled libraries, and ready-to-flash firmware.
- `gifplayer/` — B4J GifPlayer plugin source.
- `bridge/` — Python bridge, browser UI, systemd service, and watchdog files.

## Quick start

### Controller firmware

The prebuilt NodeMCU/ESP8266 image is:

`controller/firmware/awtrix2-controller-auto-recovery-offline-clock.bin`

To build from source, install PlatformIO and run from `controller/`:

```bash
pio run -e nodemcuv2
```

Flashing firmware can erase or replace device configuration. Keep a private backup of your own device before flashing; full flash backups are intentionally not included in this public repository because they may contain Wi-Fi credentials.

### Bridge

```bash
cd bridge
python3 -m pip install -r requirements.txt
export AWTRIX_HOST_URL=http://127.0.0.1:7000
python3 server.py --host 127.0.0.1 --port 7100
```

For a production server, review `awtrix2-next.service`, the reverse-proxy example, and the watchdog files under `bridge/deploy/`. Configure addresses and paths for your own environment.

## Stability defaults

- GIF rendering cadence: 250 ms per frame (4 FPS).
- Maximum continuous GIF run: 120 seconds.
- Host reconnect attempts: throttled to reduce connection storms.
- Offline fallback: local NTP-backed clock and a red status dot.

## Security

Do not commit device flash backups, `.env` files, application state, API keys, or service credentials. This repository contains no server state or complete device backup.

## Credits and license

AWTRIX was created by Blueforcer, with AWTRIX2 controller work credited in the upstream source to Blueforcer and Mazze2000. This repository is an unofficial modified continuation and is not affiliated with or endorsed by the original authors.

The AWTRIX2-derived work is provided under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International license. See `LICENSE` and component license files. Bundled third-party libraries retain their own license notices.

