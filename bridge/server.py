#!/usr/bin/env python3
"""AWTRIX2-Next: an AWTRIX3-style HTTP bridge for an AWTRIX2 Host."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

try:
    import websocket as websocket_client
except ImportError:  # local development can still use the stdlib fallback
    websocket_client = None

try:
    from PIL import Image as PILImage
except ImportError:
    PILImage = None


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("AWTRIX_NEXT_DATA", ROOT / "data"))
STATE_FILE = DATA / "state.json"
HOST_URL = os.environ.get("AWTRIX_HOST_URL", "http://127.0.0.1:7000").rstrip("/")
HOST_ROOT = Path(os.environ.get("AWTRIX_HOST_ROOT", "/opt/awtrix2"))
GIF_DIR = DATA / "gifs"
HOST_GIF_DIR = Path(os.environ.get("AWTRIX_HOST_GIF_DIR", HOST_ROOT / "gifs"))
STARTED_AT = time.time()
LOCK = threading.RLock()
HOST_MUTATION_LOCK = threading.Lock()
LAST_HOST_MUTATION = 0.0
AUTOMATION_WAKE = threading.Event()
RUNNING_AUTOMATIONS: set[str] = set()
APP_CONFIG_LOCK = threading.Lock()
GIF_PLAYLIST_LOCK = threading.Lock()
GIF_PLAYLIST_GENERATION = 0
GIF_TIMEOUT_LOCK = threading.Lock()
GIF_TIMEOUT_GENERATION = 0
GIF_MAX_PLAY_SECONDS = max(30, int(os.environ.get("AWTRIX_GIF_MAX_PLAY_SECONDS", "120")))


def _read_meminfo() -> dict[str, int]:
    """Return Linux memory counters in bytes; gracefully degrade in local dev."""
    values: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return values


def _process_rss_bytes() -> int:
    try:
        for line in Path("/proc/self/status").read_text(encoding="ascii").splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def _port_open(port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _tcp_established_count(port: int) -> int:
    """Count established connections whose local endpoint is *port*."""
    count = 0
    for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        try:
            rows = table.read_text(encoding="ascii").splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            try:
                local_port = int(fields[1].rsplit(":", 1)[1], 16)
                if local_port == port and fields[3] == "01":
                    count += 1
            except (IndexError, ValueError):
                continue
    return count


def system_health_snapshot() -> dict:
    mem = _read_meminfo()
    total = mem.get("MemTotal", 0)
    available = mem.get("MemAvailable", mem.get("MemFree", 0))
    used = max(0, total - available)
    memory_percent = round((used / total) * 100, 1) if total else 0
    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    disk = shutil.disk_usage(HOST_ROOT if HOST_ROOT.exists() else ROOT)
    try:
        load = [round(value, 2) for value in os.getloadavg()]
    except (AttributeError, OSError):
        load = [0.0, 0.0, 0.0]

    host_online = host_ping()
    matrix_connections = _tcp_established_count(7001)
    ports = {str(port): _port_open(port) for port in (7000, 7001, 7100)}
    level = "healthy"
    if not host_online or not ports["7000"] or not ports["7001"]:
        level = "critical"
    elif matrix_connections == 0 or memory_percent >= 85 or not ports["7100"]:
        level = "degraded"

    return {
        "status": level,
        "checked_at": int(time.time()),
        "host": {"online": host_online, "last_ok": int(STATE.get("last_host_ok", 0)), "last_error": STATE.get("last_error", "")},
        "matrix": {"online": matrix_connections > 0, "connections": matrix_connections},
        "bridge": {"online": True, "pid": os.getpid(), "uptime": int(time.time() - STARTED_AT), "rss_bytes": _process_rss_bytes()},
        "system": {
            "memory_total": total, "memory_used": used, "memory_percent": memory_percent,
            "swap_total": swap_total, "swap_used": max(0, swap_total - swap_free),
            "disk_total": disk.total, "disk_used": disk.used,
            "disk_percent": round((disk.used / disk.total) * 100, 1) if disk.total else 0,
            "load": load,
        },
        "ports": ports,
        "recovery": {"enabled": True, "policy": "ExitOnOutOfMemoryError + systemd restart", "heap_limit_mb": 768},
    }


APP_CATALOG = {
    "Bilibili": {"label": "哔哩哔哩", "icon": 9, "version": "1.0", "description": "显示 Bilibili UP 主的粉丝数量。"},
    "BinaryClock": {"label": "二进制时钟", "icon": 708, "version": "1.0", "description": "以二进制像素格式显示当前时间。"},
    "Countdown": {"label": "倒计时", "icon": 68, "version": "1.1", "description": "显示距离目标日期还剩多少天。"},
    "CustomApp": {"label": "自定义应用", "icon": 1060, "version": "1.1", "description": "接收 API、自动化和外部服务推送的自定义内容。"},
    "Date": {"label": "日期", "icon": 1156, "version": "1.0", "description": "显示日期、星期和当前日期高亮。"},
    "DayOfTheWeek": {"label": "星期", "icon": 414, "version": "1.0", "description": "显示今天是星期几以及当年的第几周。"},
    "Dice": {"label": "骰子", "icon": 783, "version": "1.0", "description": "在矩阵屏上掷一个或多个骰子。"},
    "DouyinFans": {"label": "抖音粉丝", "icon": 758, "version": "1.0", "description": "使用抖音开放平台数据显示授权账号粉丝数量。"},
    "DrinkWater": {"label": "喝水提醒", "icon": 1238, "version": "1.1", "description": "按间隔提醒喝水并追踪每日饮水目标。"},
    "GameOfLife": {"label": "生命游戏", "icon": 712, "version": "1.0", "description": "在 32×8 矩阵上运行康威生命游戏。"},
    "GifPlayer": {"label": "GIF 动画", "icon": 709, "version": "1.0", "description": "播放桥接层推送的 GIF 像素动画。"},
    "HappyBirthday": {"label": "生日祝福", "icon": 1302, "version": "1.2", "description": "播放生日动画并显示指定姓名。"},
    "LookingEyes": {"label": "动态眼睛", "icon": 709, "version": "1.0", "description": "显示会四处观察的像素眼睛动画。"},
    "Matrix": {"label": "矩阵雨", "icon": 321, "version": "1.0", "description": "播放经典绿色数字雨像素动画。"},
    "MessageBoard": {"label": "留言板", "icon": 187, "version": "1.0", "description": "滚动显示一条可自定义的常驻消息。"},
    "Moon": {"label": "月相", "icon": 348, "version": "1.0", "description": "显示当前月相和月亮状态。"},
    "OpenWeather": {"label": "天气", "icon": 349, "version": "1.2", "description": "通过 OpenWeather 显示所在地的天气和温度。"},
    "Pong": {"label": "乒乓动画", "icon": 680, "version": "1.0", "description": "播放像素风 Pong 乒乓球动画。"},
    "Reminder": {"label": "每月提醒", "icon": 806, "version": "1.0", "description": "在每月指定日期显示提醒文字。"},
    "Time": {"label": "时间", "icon": 13, "version": "1.2", "description": "显示当前时间，可配置秒、日期、星期与 12 小时制。"},
    "YearProgress": {"label": "年度进度", "icon": 916, "version": "1.0", "description": "显示今年已经过去的百分比。"},
}

APP_SECRET_KEYS = {"APIKey", "BusinessToken"}


DEFAULT_STATE = {
    "custom_apps": {},
    "notifications": [],
    "settings": {"BRI": 120, "ATIME": 7, "SSPEED": 100, "ATRANS": True},
    "indicators": {"1": "#000000", "2": "#000000", "3": "#000000"},
    "current_app": "Time",
    "last_payload": {"text": "AWTRIX NEXT", "color": "#ffb000", "center": True},
    "last_host_ok": 0,
    "last_error": "",
    "automations": {},
    "automation_logs": [],
    "custom_meta": {},
}


def load_state() -> dict:
    DATA.mkdir(parents=True, exist_ok=True)
    if not STATE_FILE.exists():
        return json.loads(json.dumps(DEFAULT_STATE))
    try:
        saved = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        merged = json.loads(json.dumps(DEFAULT_STATE))
        merged.update(saved)
        merged["settings"].update(saved.get("settings", {}))
        return merged
    except (OSError, ValueError, TypeError):
        return json.loads(json.dumps(DEFAULT_STATE))


STATE = load_state()


def save_state() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(STATE, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


def host_request(path: str, payload: dict | list | None = None, method: str = "POST") -> tuple[int, str]:
    global LAST_HOST_MUTATION
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"{HOST_URL}{path}",
        data=body,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with HOST_MUTATION_LOCK:
            if method.upper() != "GET":
                remaining = 1.15 - (time.monotonic() - LAST_HOST_MUTATION)
                if remaining > 0:
                    time.sleep(remaining)
            with urlopen(request, timeout=6) as response:
                text = response.read().decode("utf-8", "replace")
                if method.upper() != "GET":
                    LAST_HOST_MUTATION = time.monotonic()
                with LOCK:
                    STATE["last_host_ok"] = int(time.time())
                    STATE["last_error"] = ""
                return response.status, text
    except HTTPError as exc:
        message = exc.read().decode("utf-8", "replace")
        with LOCK:
            STATE["last_error"] = f"Host HTTP {exc.code}: {message[:160]}"
        raise RuntimeError(STATE["last_error"]) from exc


def host_ping() -> bool:
    try:
        request = Request(f"{HOST_URL}/", method="GET", headers={"Accept": "text/html"})
        with urlopen(request, timeout=3) as response:
            response.read(128)
        with LOCK:
            STATE["last_host_ok"] = int(time.time())
            STATE["last_error"] = ""
        return True
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        with LOCK:
            STATE["last_error"] = f"Host health check failed: {exc}"
        return False
    except (URLError, TimeoutError, OSError) as exc:
        with LOCK:
            STATE["last_error"] = f"Host unreachable: {exc}"
        raise RuntimeError(STATE["last_error"]) from exc


def websocket_event(event: str, params: dict | None = None) -> None:
    """Send one B4J WebSocket event without a third-party dependency."""
    target = urlparse(HOST_URL)
    host = target.hostname or "127.0.0.1"
    port = target.port or 7000
    event_message = json.dumps(
        {"type": "event", "event": event, "params": params or {}},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if websocket_client is not None:
        connection = websocket_client.create_connection(
            f"ws://{host}:{port}/myapps/ws",
            timeout=3,
            origin=f"http://{host}:{port}",
        )
        try:
            # B4J sends dozens of DOM initialization frames. Events such as
            # enable_app are ignored until that stream has completed.
            connection.settimeout(0.18)
            for _ in range(160):
                try:
                    connection.recv()
                except Exception:
                    break
            connection.send(event_message)
            connection.settimeout(0.8)
            try:
                connection.recv()
            except Exception:
                pass
        finally:
            connection.close()
        return

    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    request = (
        "GET /myapps/ws HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Origin: http://{host}:{port}\r\n\r\n"
    ).encode("ascii")
    sock = socket.create_connection((host, port), timeout=4)
    try:
        sock.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response and len(response) < 16384:
            chunk = sock.recv(2048)
            if not chunk:
                break
            response.extend(chunk)
        if not response.startswith(b"HTTP/1.1 101"):
            raise RuntimeError("AWTRIX Host WebSocket handshake failed")
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        )
        if accept not in response:
            raise RuntimeError("AWTRIX Host WebSocket validation failed")

        payload = event_message.encode("utf-8")
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        sock.sendall(bytes(header) + mask + masked)
        sock.settimeout(0.6)
        try:
            while sock.recv(4096):
                pass
        except (TimeoutError, socket.timeout, OSError):
            pass
        close_mask = secrets.token_bytes(4)
        close_payload = struct.pack("!H", 1000)
        close_masked = bytes(value ^ close_mask[index % 4] for index, value in enumerate(close_payload))
        try:
            sock.sendall(bytes([0x88, 0x80 | len(close_payload)]) + close_mask + close_masked)
        except OSError:
            pass
    finally:
        sock.close()


def websocket_app_order(order: list[str]) -> None:
    """Persist the app loop through AWTRIX2's native sort-apps WebSocket."""
    if websocket_client is None:
        raise RuntimeError("应用排序需要 websocket-client 支持")

    target = urlparse(HOST_URL)
    host = target.hostname or "127.0.0.1"
    port = target.port or 7000
    connection = websocket_client.create_connection(
        f"ws://{host}:{port}/applist/ws",
        timeout=4,
        origin=f"http://{host}:{port}",
    )
    try:
        # The Host initializes the page before accepting automatic UI events.
        connection.settimeout(0.22)
        for _ in range(240):
            try:
                connection.recv()
            except Exception:
                break

        serialized = json.dumps(
            [{"id": name} for name in order],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        connection.send(json.dumps(
            {"type": "event", "event": "list_changed", "params": {"list": serialized}},
            ensure_ascii=False,
            separators=(",", ":"),
        ))
        # Keep both events on the same connection: AWTRIX2 stores the pending
        # list on the webapplist session until save_click commits it.
        time.sleep(0.12)
        connection.send(json.dumps(
            {"type": "event", "event": "save_click", "params": {}},
            ensure_ascii=False,
            separators=(",", ":"),
        ))
        connection.settimeout(0.8)
        try:
            connection.recv()
        except Exception:
            pass
    finally:
        connection.close()


def color_triplet(value) -> list[int] | None:
    """Convert AWTRIX3-style colors to the RGB triplet required by AWTRIX2."""
    if isinstance(value, str):
        text = value.lstrip("#")
        if len(text) == 6:
            try:
                return [int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)]
            except ValueError:
                return None
    if isinstance(value, list) and len(value) >= 3:
        try:
            return [max(0, min(255, int(value[index]))) for index in range(3)]
        except (TypeError, ValueError):
            return None
    return None


def v2_payload(payload: dict, *, app_id: int | None = None, force: bool = True) -> dict:
    """Translate AWTRIX3 page fields to the stable AWTRIX2 notification schema."""
    text_value = payload.get("text", payload.get("data", ""))
    if isinstance(text_value, list):
        text_value = "".join(str(item.get("t", "")) for item in text_value if isinstance(item, dict))
    result = {
        "data": str(text_value),
        "force": force,
        "repeat": max(1, int(payload.get("repeat", 1) or 1)),
    }
    if payload.get("duration") is not None:
        result["duration"] = max(1, int(payload["duration"]))
    color = color_triplet(payload.get("color"))
    if color is not None:
        result["color"] = color
    background = color_triplet(payload.get("background"))
    if background is not None:
        result["background"] = background
    if payload.get("rainbow") is not None:
        result["rainbow"] = bool(payload["rainbow"])
    if payload.get("noScroll") is not None:
        result["scrolling"] = not bool(payload["noScroll"])
    if payload.get("progress") is not None:
        try:
            result["progress"] = max(0, min(100, int(payload["progress"])))
        except (TypeError, ValueError):
            pass
    progress_color = color_triplet(payload.get("progressC", payload.get("progressColor")))
    if progress_color is not None:
        result["progressColor"] = progress_color
    progress_background = color_triplet(payload.get("progressBC", payload.get("progressBackground")))
    if progress_background is not None:
        result["progressBackground"] = progress_background
    if payload.get("icon") is not None:
        result["icon"] = payload["icon"]
    if payload.get("pushIcon") is not None:
        try:
            push_icon = max(0, min(2, int(payload["pushIcon"])))
        except (TypeError, ValueError):
            push_icon = 0
        result["moveIcon"] = push_icon > 0
        result["repeatIcon"] = push_icon == 2
    elif payload.get("moveIcon") is not None:
        result["moveIcon"] = bool(payload["moveIcon"])
        if payload.get("repeatIcon") is not None:
            result["repeatIcon"] = bool(payload["repeatIcon"])
    if payload.get("scrollSpeed") is not None:
        try:
            # AWTRIX3 uses a speed percentage; AWTRIX2 expects the frame interval
            # in milliseconds. 65 ms is the Host's normal scrolling interval.
            percent = max(10, min(500, int(payload["scrollSpeed"])))
            result["speed"] = max(13, min(650, round(6500 / percent)))
        except (TypeError, ValueError):
            pass
    if isinstance(payload.get("bar"), list):
        result["barchart"] = payload["bar"][:16]
    if isinstance(payload.get("line"), list):
        result["linechart"] = payload["line"][:16]
    if payload.get("frame") is not None:
        result["frame"] = bool(payload["frame"])
    frame_color = color_triplet(payload.get("frameC", payload.get("frameColor")))
    if frame_color is not None:
        result["frameColor"] = frame_color
    if app_id is not None:
        result["ID"] = app_id
    return result


FONT = {
    " ": ("000", "000", "000", "000", "000"),
    "A": ("010", "101", "111", "101", "101"), "B": ("110", "101", "110", "101", "110"),
    "C": ("011", "100", "100", "100", "011"), "D": ("110", "101", "101", "101", "110"),
    "E": ("111", "100", "110", "100", "111"), "F": ("111", "100", "110", "100", "100"),
    "G": ("011", "100", "101", "101", "011"), "H": ("101", "101", "111", "101", "101"),
    "I": ("111", "010", "010", "010", "111"), "J": ("001", "001", "001", "101", "010"),
    "K": ("101", "101", "110", "101", "101"), "L": ("100", "100", "100", "100", "111"),
    "M": ("101", "111", "111", "101", "101"), "N": ("101", "111", "111", "111", "101"),
    "O": ("010", "101", "101", "101", "010"), "P": ("110", "101", "110", "100", "100"),
    "Q": ("010", "101", "101", "111", "011"), "R": ("110", "101", "110", "101", "101"),
    "S": ("011", "100", "010", "001", "110"), "T": ("111", "010", "010", "010", "010"),
    "U": ("101", "101", "101", "101", "111"), "V": ("101", "101", "101", "101", "010"),
    "W": ("101", "101", "111", "111", "101"), "X": ("101", "101", "010", "101", "101"),
    "Y": ("101", "101", "010", "010", "010"), "Z": ("111", "001", "010", "100", "111"),
    "0": ("111", "101", "101", "101", "111"), "1": ("010", "110", "010", "010", "111"),
    "2": ("110", "001", "010", "100", "111"), "3": ("110", "001", "010", "001", "110"),
    "4": ("101", "101", "111", "001", "001"), "5": ("111", "100", "110", "001", "110"),
    "6": ("011", "100", "111", "101", "111"), "7": ("111", "001", "010", "010", "010"),
    "8": ("111", "101", "111", "101", "111"), "9": ("111", "101", "111", "001", "110"),
    "!": ("010", "010", "010", "000", "010"), "?": ("110", "001", "010", "000", "010"),
    ".": ("000", "000", "000", "000", "010"), ":": ("000", "010", "000", "010", "000"),
    "-": ("000", "000", "111", "000", "000"),
}


def rgb_value(value, default="#ffb000") -> int:
    if isinstance(value, list) and len(value) >= 3:
        return (int(value[0]) << 16) | (int(value[1]) << 8) | int(value[2])
    text = str(value or default).lstrip("#")
    try:
        return int(text[:6], 16)
    except ValueError:
        return int(default.lstrip("#"), 16)


def render_screen(payload: dict) -> list[int]:
    background = rgb_value(payload.get("background"), "#050604")
    pixels = [background] * 256
    text_value = payload.get("text", "")
    if isinstance(text_value, list):
        text_value = "".join(str(item.get("t", "")) for item in text_value if isinstance(item, dict))
    text_value = str(text_value).upper()
    color = rgb_value(payload.get("color"), "#ffb000")
    width = max(0, len(text_value) * 4 - 1)
    x0 = max(0, (32 - width) // 2) if payload.get("center", True) and width <= 32 else 1
    if width > 32:
        x0 = 32 - (int(time.time() * 5) % (width + 32))
    for char_index, char in enumerate(text_value):
        glyph = FONT.get(char, FONT["?"])
        for y, row in enumerate(glyph):
            for x, bit in enumerate(row):
                px = x0 + char_index * 4 + x
                py = y + 1
                if bit == "1" and 0 <= px < 32:
                    if payload.get("rainbow"):
                        hue = (char_index * 43 + x * 17) % 255
                        pixel_color = ((255 - hue) << 16) | (hue << 8) | 80
                    else:
                        pixel_color = color
                    pixels[py * 32 + px] = pixel_color
    if payload.get("progress") is not None:
        amount = max(0, min(100, int(payload["progress"])))
        progress_background_value = payload.get("progressBC")
        if progress_background_value is None:
            progress_background_value = payload.get("background")
        progress_background = rgb_value(progress_background_value, "#050604")
        for x in range(32):
            pixels[7 * 32 + x] = progress_background
        for x in range(round(32 * amount / 100)):
            pixels[7 * 32 + x] = rgb_value(payload.get("progressC"), "#00d084")
    return pixels


# ---------------------------------------------------------------------------
# GIF playback: decode in the bridge, render via the GifPlayer Host app
# ---------------------------------------------------------------------------

MATRIX_BG = (5, 6, 4)


def rgb888_to_rgb565(r: int, g: int, b: int) -> int:
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def _gif_composite(frame) -> "PILImage.Image":
    rgba = frame.convert("RGBA")
    bg = PILImage.new("RGBA", rgba.size, (*MATRIX_BG, 255))
    return PILImage.alpha_composite(bg, rgba).convert("RGB")


def _resize_to_matrix(img, mode: str = "contain") -> "PILImage.Image":
    if img.size == (32, 8):
        return img
    if mode == "cover":
        src_ratio = img.width / max(1, img.height)
        if src_ratio > 4:
            new_h = 8
            new_w = round(8 * src_ratio)
        else:
            new_w = 32
            new_h = round(32 / src_ratio)
        resized = img.resize((new_w, new_h), PILImage.LANCZOS)
        left = (new_w - 32) // 2
        top = (new_h - 8) // 2
        return resized.crop((left, top, left + 32, top + 8))
    img.thumbnail((32, 8), PILImage.LANCZOS)
    canvas = PILImage.new("RGB", (32, 8), MATRIX_BG)
    canvas.paste(img, ((32 - img.width) // 2, (8 - img.height) // 2))
    return canvas


def decode_gif(data: bytes, *, max_frames: int = 64, resize_mode: str = "contain") -> dict:
    if PILImage is None:
        raise RuntimeError("GIF 解码需要 Pillow：pip install Pillow")
    try:
        img = PILImage.open(io.BytesIO(data))
    except Exception as exc:
        raise ValueError(f"无法解析图片：{exc}") from exc
    if getattr(img, "format", "") != "GIF":
        raise ValueError("文件不是 GIF 格式")
    frames: list[list[int]] = []
    delays: list[int] = []
    try:
        while len(frames) < max_frames:
            rgb = _resize_to_matrix(_gif_composite(img), resize_mode)
            frames.append([rgb888_to_rgb565(r, g, b) for r, g, b in rgb.getdata()])
            delays.append(max(20, min(1000, int(img.info.get("duration", 100)))))
            img.seek(img.tell() + 1)
    except EOFError:
        pass
    if not frames:
        raise ValueError("GIF 没有可解码的帧")
    return {
        "frames": frames,
        "delay": round(sum(delays) / len(delays)),
        "loop": int(img.info.get("loop", 0)),
        "frame_count": len(frames),
    }


def gif_safe_name(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", str(name).strip())[:40]
    if not safe:
        raise ValueError("GIF 名称无效")
    return safe


def gif_path(name: str) -> Path:
    return GIF_DIR / f"{gif_safe_name(name)}.json"


def save_gif(name: str, decoded: dict) -> str:
    GIF_DIR.mkdir(parents=True, exist_ok=True)
    stem = gif_safe_name(name)
    path = GIF_DIR / f"{stem}.json"
    payload = {"name": stem, "delay": decoded["delay"], "loop": decoded.get("loop", 0), "frames": decoded["frames"]}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    return stem


def list_gifs() -> list[dict]:
    GIF_DIR.mkdir(parents=True, exist_ok=True)
    result = []
    for path in sorted(GIF_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            result.append({
                "name": data.get("name", path.stem),
                "frames": len(data.get("frames", [])),
                "delay": data.get("delay", 100),
                "loop": data.get("loop", 0),
                "size": path.stat().st_size,
            })
        except (OSError, ValueError, TypeError):
            continue
    return result


def delete_gif(name: str) -> bool:
    path = gif_path(name)
    if path.exists():
        path.unlink()
        return True
    return False


def _cancel_gif_playlist() -> None:
    global GIF_PLAYLIST_GENERATION
    with GIF_PLAYLIST_LOCK:
        GIF_PLAYLIST_GENERATION += 1


def _cancel_gif_timeout() -> None:
    global GIF_TIMEOUT_GENERATION
    with GIF_TIMEOUT_LOCK:
        GIF_TIMEOUT_GENERATION += 1


def _arm_gif_timeout() -> None:
    global GIF_TIMEOUT_GENERATION
    with GIF_TIMEOUT_LOCK:
        GIF_TIMEOUT_GENERATION += 1
        generation = GIF_TIMEOUT_GENERATION

    def worker() -> None:
        time.sleep(GIF_MAX_PLAY_SECONDS)
        with GIF_TIMEOUT_LOCK:
            if generation != GIF_TIMEOUT_GENERATION:
                return
        stop_gif()

    threading.Thread(target=worker, daemon=True, name="gif-timeout").start()


def play_gif(name: str, *, loop: int | None = None, playlist_generation: int | None = None) -> dict:
    if playlist_generation is None:
        _cancel_gif_playlist()
    path = gif_path(name)
    if not path.exists():
        raise ValueError("GIF 不存在")
    data = json.loads(path.read_text(encoding="utf-8"))
    if loop is not None:
        data["loop"] = max(0, int(loop))
    data["name"] = path.stem
    HOST_GIF_DIR.mkdir(parents=True, exist_ok=True)
    current = HOST_GIF_DIR / "current.json"
    tmp = current.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(current)
    try:
        websocket_event("switch_click", {"app": "GifPlayer"})
    except RuntimeError as exc:
        with LOCK:
            STATE["last_error"] = str(exc)
    with LOCK:
        STATE["current_app"] = f"GifPlayer:{path.stem}"
        STATE["last_payload"] = {"text": f"GIF {path.stem}", "color": "#ff69b4", "center": True}
        save_state()
    if playlist_generation is None:
        _arm_gif_timeout()
    return {"name": path.stem, "frames": len(data["frames"]), "delay": data["delay"], "loop": data["loop"]}


def _gif_playlist_worker(generation: int, names: list[str]) -> None:
    while True:
        for name in names:
            with GIF_PLAYLIST_LOCK:
                if generation != GIF_PLAYLIST_GENERATION:
                    return
            try:
                result = play_gif(name, loop=0, playlist_generation=generation)
            except (OSError, ValueError, TypeError):
                continue
            duration = max(3.0, result["frames"] * result["delay"] / 1000.0)
            deadline = time.monotonic() + duration
            while time.monotonic() < deadline:
                with GIF_PLAYLIST_LOCK:
                    if generation != GIF_PLAYLIST_GENERATION:
                        return
                time.sleep(min(0.25, max(0.01, deadline - time.monotonic())))


def play_all_gifs() -> dict:
    global GIF_PLAYLIST_GENERATION
    names = [item["name"] for item in list_gifs()]
    if not names:
        raise ValueError("还没有保存的 GIF")
    with GIF_PLAYLIST_LOCK:
        GIF_PLAYLIST_GENERATION += 1
        generation = GIF_PLAYLIST_GENERATION
    threading.Thread(target=_gif_playlist_worker, args=(generation, names), daemon=True, name="gif-playlist").start()
    _arm_gif_timeout()
    return {"count": len(names), "names": names, "max_play_seconds": GIF_MAX_PLAY_SECONDS}


def gif_preview(name: str) -> dict:
    path = gif_path(name)
    if not path.exists():
        raise ValueError("GIF 不存在")
    data = json.loads(path.read_text(encoding="utf-8"))
    first = data.get("frames", [])[0] if data.get("frames") else []
    pixels = []
    for value in first:
        r = ((value >> 11) & 0x1F) << 3
        g = ((value >> 5) & 0x3F) << 2
        b = (value & 0x1F) << 3
        pixels.append((r << 16) | (g << 8) | b)
    return {"width": 32, "height": 8, "pixels": pixels, "delay": data.get("delay", 100), "frames": len(data.get("frames", []))}


def stop_gif() -> None:
    _cancel_gif_playlist()
    _cancel_gif_timeout()
    with LOCK:
        STATE["current_app"] = "Time"
        save_state()
    try:
        websocket_event("switch_click", {"app": "Time"})
    except RuntimeError as exc:
        with LOCK:
            STATE["last_error"] = str(exc)


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_source_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_source_url(value: str) -> str:
    """Allow public HTTPS JSON sources without exposing the server's private network."""
    url = str(value or "").strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("数据地址必须是无账号信息的公网 HTTPS URL")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError(f"无法解析数据地址：{exc}") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
        if not ip.is_global:
            raise ValueError("数据地址不能指向本机、内网或保留地址")
    return url


def fetch_json_source(url: str) -> object:
    request = Request(
        validate_source_url(url),
        method="GET",
        headers={"Accept": "application/json", "User-Agent": "AWTRIX2-Next/3.0"},
    )
    opener = build_opener(SafeRedirectHandler())
    with opener.open(request, timeout=10) as response:
        raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("数据响应超过 1 MB")
    return json.loads(raw.decode("utf-8-sig"))


def extract_json_path(value: object, path: str) -> object:
    normalized = re.sub(r"\[(\d+)\]", r".\1", str(path or "").strip().strip("."))
    if not normalized:
        return value
    current = value
    for token in normalized.split("."):
        if isinstance(current, list):
            if not token.isdigit():
                raise ValueError(f"JSON 路径 {path!r} 在数组处需要数字下标")
            index = int(token)
            if index >= len(current):
                raise ValueError(f"JSON 路径 {path!r} 的下标越界")
            current = current[index]
        elif isinstance(current, dict):
            if token not in current:
                raise ValueError(f"JSON 路径中不存在字段 {token!r}")
            current = current[token]
        else:
            raise ValueError(f"JSON 路径 {path!r} 无法继续读取 {token!r}")
    return current


def normalize_automation(payload: dict, existing: dict | None = None) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("自动化任务必须是 JSON 对象")
    source_url = validate_source_url(str(payload.get("source_url", "")))
    interval = max(30, min(86_400, int(payload.get("interval", 300) or 300)))
    mode = str(payload.get("mode", "notification"))
    if mode not in {"notification", "custom", "log"}:
        raise ValueError("显示方式必须是 notification、custom 或 log")
    job_id = str(payload.get("id") or (existing or {}).get("id") or secrets.token_hex(5))
    job_id = re.sub(r"[^a-zA-Z0-9_-]", "", job_id)[:40]
    if not job_id:
        raise ValueError("任务 ID 无效")
    name = str(payload.get("name", "数据任务")).strip()[:48] or "数据任务"
    app_name = re.sub(r"[^a-zA-Z0-9_-]", "_", str(payload.get("app_name", name)).strip())[:32] or job_id
    old = existing or {}
    enabled = bool(payload.get("enabled", True))
    previous_status = str(old.get("status", "waiting"))
    if not enabled:
        status = "paused"
    elif previous_status == "paused":
        status = "waiting"
    else:
        status = previous_status
    return {
        "id": job_id,
        "name": name,
        "enabled": enabled,
        "source_url": source_url,
        "json_path": str(payload.get("json_path", "")).strip()[:240],
        "template": str(payload.get("template", "{value}"))[:160] or "{value}",
        "interval": interval,
        "mode": mode,
        "app_name": app_name,
        "show_on_update": bool(payload.get("show_on_update", False)),
        "color": input_color(payload.get("color"), "#67d5d1"),
        "background": input_color(payload.get("background"), "#050604"),
        "icon": str(payload.get("icon", "")).strip()[:120],
        "duration": max(1, min(300, int(payload.get("duration", 10) or 10))),
        "rainbow": bool(payload.get("rainbow", False)),
        "lifetime": max(0, min(604_800, int(payload.get("lifetime", 0) or 0))),
        "lifetimeMode": 1 if int(payload.get("lifetimeMode", 0) or 0) == 1 else 0,
        "created_at": int(old.get("created_at", time.time())),
        "last_run": int(old.get("last_run", 0)),
        "last_success": int(old.get("last_success", 0)),
        "next_run": int(old.get("next_run", time.time() + interval)),
        "last_value": old.get("last_value"),
        "last_error": str(old.get("last_error", "")),
        "failures": int(old.get("failures", 0)),
        "status": status,
    }


def input_color(value, default: str) -> str:
    triplet = color_triplet(value)
    if triplet is None:
        triplet = color_triplet(default) or [0, 0, 0]
    return "#" + "".join(f"{part:02x}" for part in triplet)


def automation_log(job_id: str, level: str, message: str) -> None:
    with LOCK:
        STATE["automation_logs"] = (STATE.get("automation_logs", []) + [{
            "at": int(time.time()), "job_id": job_id, "level": level, "message": str(message)[:500]
        }])[-200:]


def automation_payload(job: dict, value: object) -> dict:
    if isinstance(value, (dict, list)):
        display_value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    elif value is None:
        display_value = "—"
    elif isinstance(value, bool):
        display_value = "true" if value else "false"
    else:
        display_value = str(value)
    text = job["template"].replace("{value}", display_value).replace("{name}", job["name"])
    result = {
        "text": text[:160],
        "color": job["color"],
        "background": job["background"],
        "duration": job["duration"],
        "rainbow": job["rainbow"],
        "center": True,
    }
    if job.get("icon"):
        result["icon"] = job["icon"]
    return result


def run_automation(job_id: str, trigger: str = "schedule") -> None:
    with LOCK:
        if job_id in RUNNING_AUTOMATIONS or job_id not in STATE.get("automations", {}):
            return
        RUNNING_AUTOMATIONS.add(job_id)
        job = dict(STATE["automations"][job_id])
        STATE["automations"][job_id]["status"] = "running"
        STATE["automations"][job_id]["last_run"] = int(time.time())
        save_state()
    automation_log(job_id, "info", f"开始{('手动' if trigger == 'manual' else '定时')}更新")
    try:
        last_error = None
        data = None
        for attempt in range(3):
            try:
                data = fetch_json_source(job["source_url"])
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.5 * (2 ** attempt))
        if last_error is not None:
            raise last_error
        value = extract_json_path(data, job["json_path"])
        payload = automation_payload(job, value)
        if job["mode"] == "notification":
            host_request("/api/v3/notify", v2_payload(payload, force=True))
            with LOCK:
                STATE["notifications"] = (STATE.get("notifications", []) + [{
                    "id": secrets.token_hex(4), "at": int(time.time()), "status": "automated",
                    "automation": job_id, **payload,
                }])[-30:]
                STATE["current_app"] = "Notification"
                STATE["last_payload"] = payload
        elif job["mode"] == "custom":
            host_request("/api/v3/customapp", v2_payload(payload, app_id=0, force=True))
            with LOCK:
                STATE["custom_apps"][job["app_name"]] = payload
                STATE["custom_meta"][job["app_name"]] = {"updated_at": int(time.time()), "automation": job_id}
                if job["show_on_update"]:
                    STATE["current_app"] = job["app_name"]
                    STATE["last_payload"] = payload
            if job["show_on_update"]:
                websocket_event("switch_click", {"app": "CustomApp"})
        now = int(time.time())
        with LOCK:
            current = STATE.get("automations", {}).get(job_id)
            if current is not None:
                current.update({
                    "last_success": now, "next_run": now + job["interval"], "last_value": value,
                    "last_error": "", "failures": 0, "status": "healthy",
                })
                save_state()
        automation_log(job_id, "ok", f"更新成功：{str(value)[:180]}")
    except Exception as exc:
        now = int(time.time())
        with LOCK:
            current = STATE.get("automations", {}).get(job_id)
            if current is not None:
                failures = int(current.get("failures", 0)) + 1
                retry_after = min(job["interval"], 30 * (2 ** min(failures - 1, 5)))
                current.update({
                    "next_run": now + retry_after, "last_error": f"{type(exc).__name__}: {exc}"[:500],
                    "failures": failures, "status": "error",
                })
                save_state()
        automation_log(job_id, "error", f"更新失败，将自动重试：{type(exc).__name__}: {exc}")
    finally:
        with LOCK:
            RUNNING_AUTOMATIONS.discard(job_id)
            save_state()


def automation_scheduler() -> None:
    while True:
        now = int(time.time())
        due: list[str] = []
        stale_actions: list[tuple[str, dict]] = []
        changed = False
        with LOCK:
            for job_id, job in STATE.get("automations", {}).items():
                if job.get("enabled") and now >= int(job.get("next_run", 0)) and job_id not in RUNNING_AUTOMATIONS:
                    due.append(job_id)
                lifetime = int(job.get("lifetime", 0) or 0)
                last_success = int(job.get("last_success", 0) or 0)
                if lifetime and last_success and now - last_success > lifetime and job.get("status") not in {"stale", "running"}:
                    job["status"] = "stale"
                    changed = True
                    if job.get("mode") == "custom":
                        app_name = job.get("app_name", job_id)
                        if int(job.get("lifetimeMode", 0)) == 0:
                            STATE["custom_apps"].pop(app_name, None)
                            STATE["custom_meta"].pop(app_name, None)
                        elif app_name in STATE["custom_apps"]:
                            stale_payload = dict(STATE["custom_apps"][app_name])
                            stale_payload.update({"frame": True, "frameC": "#ff2d2d"})
                            STATE["custom_apps"][app_name] = stale_payload
                            stale_actions.append((app_name, stale_payload))
                    automation_log(job_id, "warning", "数据超过生命周期，已标记为过期")
            if changed:
                save_state()
        for app_name, payload in stale_actions:
            try:
                host_request("/api/v3/customapp", v2_payload(payload, app_id=0, force=True))
            except RuntimeError as exc:
                automation_log(app_name, "error", f"过期标记发送失败：{exc}")
        for job_id in due:
            threading.Thread(target=run_automation, args=(job_id,), daemon=True).start()
        AUTOMATION_WAKE.wait(2)
        AUTOMATION_WAKE.clear()


def get_loop() -> list[str]:
    path = HOST_ROOT / "config" / "apploop.json"
    try:
        apps = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        apps = ["Time", "Date", "CustomApp"]
    custom = list(STATE.get("custom_apps", {}).keys())
    result = [name for name in apps if name != "CustomApp"]
    return result + custom


def host_app_order() -> list[str]:
    path = HOST_ROOT / "config" / "apploop.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list):
            return []
        result = []
        for name in value:
            if isinstance(name, str) and name not in result:
                result.append(name)
        return result
    except (OSError, ValueError, TypeError):
        return []


def enabled_host_apps() -> set[str]:
    return set(host_app_order())


def installed_apps() -> list[str]:
    apps_dir = HOST_ROOT / "Apps"
    try:
        names = {path.stem for path in apps_dir.glob("*.ax") if re.fullmatch(r"[A-Za-z0-9_]+", path.stem)}
    except OSError:
        names = set()
    ordered = [name for name in APP_CATALOG if name in names]
    return ordered + sorted(names.difference(ordered), key=str.casefold)


def app_settings_path(name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_]+", name or "") or name not in installed_apps():
        raise ValueError("App 不存在")
    return HOST_ROOT / "Apps" / f"{name}.ax"


def app_settings_command(action: str, path: Path, patch_path: Path | None = None) -> dict:
    helper_root = ROOT / "tools"
    host_jar = HOST_ROOT / "awtrix.jar"
    command = [
        os.environ.get("JAVA_BIN", "/usr/bin/java"),
        "-cp", f"{helper_root}{os.pathsep}{host_jar}",
        "AppSettingsTool", action, str(path),
    ]
    if patch_path is not None:
        command.append(str(patch_path))
    process = subprocess.run(command, capture_output=True, text=True, timeout=12, check=False)
    if process.returncode != 0:
        message = (process.stderr or process.stdout or "读取 App 设置失败").strip().splitlines()[-1]
        raise RuntimeError(message[:240])
    try:
        value = json.loads(process.stdout.strip())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("App 设置格式无效") from exc
    if not isinstance(value, dict):
        raise RuntimeError("App 设置不是对象")
    return value


def read_app_settings(name: str, *, mask_secrets: bool = True) -> dict:
    value = app_settings_command("read", app_settings_path(name))
    if mask_secrets:
        for key in APP_SECRET_KEYS.intersection(value):
            value[key] = "" if not value[key] else "••••••••"
    return value


def app_catalog() -> list[dict]:
    installed = installed_apps()
    loop = [name for name in host_app_order() if name in installed]
    enabled = set(loop)
    names = loop + [name for name in installed if name not in enabled]
    result = []
    for name in names:
        info = APP_CATALOG.get(name, {})
        result.append({
            "name": name,
            "label": info.get("label", re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)),
            "icon": info.get("icon"),
            "version": info.get("version", "1.0"),
            "description": info.get("description", "AWTRIX2 设备应用。"),
            "enabled": name in enabled,
            "current": STATE.get("current_app") == name,
            "order": loop.index(name) + 1 if name in enabled else None,
        })
    return result


def write_host_app_order(order: list) -> list[str]:
    if not isinstance(order, list) or any(not isinstance(name, str) for name in order):
        raise ValueError("应用顺序必须是名称数组")
    if len(order) != len(set(order)):
        raise ValueError("应用顺序中存在重复项")
    current = host_app_order()
    if set(order) != set(current):
        raise ValueError("排序必须包含全部已启用应用，且不能包含未启用应用")
    installed = set(installed_apps())
    if any(name not in installed for name in order):
        raise ValueError("排序中包含未安装应用")
    with APP_CONFIG_LOCK:
        websocket_app_order(order)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            saved = host_app_order()
            if saved == order:
                return saved
            time.sleep(0.2)
    raise RuntimeError("AWTRIX2 Host 未确认新的应用顺序")


def write_app_settings(name: str, patch: dict, *, allow_enabled: bool = False, reload_host: bool = True) -> dict:
    path = app_settings_path(name)
    current = app_settings_command("read", path)
    clean = {}
    for key, value in patch.items():
        if key == "Enabled" and not allow_enabled:
            continue
        if key not in current:
            raise ValueError(f"未知设置：{key}")
        if key in APP_SECRET_KEYS and (value in ("", None) or "•" in str(value)):
            continue
        clean[key] = value
    if not clean:
        return read_app_settings(name)
    backup = path.with_suffix(".ax.next-backup")
    shutil.copy2(path, backup)
    patch_file = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
            json.dump(clean, handle, ensure_ascii=False)
            patch_file = Path(handle.name)
        app_settings_command("write", path, patch_file)
        if reload_host:
            host_request("/api/v3/special/reload", {})
    except Exception:
        shutil.copy2(backup, path)
        raise
    finally:
        if patch_file is not None:
            patch_file.unlink(missing_ok=True)
    return read_app_settings(name)


def set_host_app_enabled(name: str, enabled: bool) -> bool:
    write_app_settings(name, {"Enabled": enabled}, allow_enabled=True, reload_host=False)
    loop_path = HOST_ROOT / "config" / "apploop.json"
    try:
        apps = json.loads(loop_path.read_text(encoding="utf-8"))
        if not isinstance(apps, list):
            apps = []
    except (OSError, ValueError, TypeError):
        apps = []
    apps = [str(item) for item in apps if isinstance(item, str) and item != name]
    if enabled:
        apps.append(name)
    loop_backup = loop_path.with_suffix(".json.next-backup")
    shutil.copy2(loop_path, loop_backup)
    loop_temp = loop_path.with_suffix(".json.next-tmp")
    loop_temp.write_text(json.dumps(apps, ensure_ascii=False, indent=2), encoding="utf-8")
    loop_temp.replace(loop_path)
    try:
        host_request("/api/v3/special/reload", {})
    except Exception:
        shutil.copy2(loop_backup, loop_path)
        write_app_settings(name, {"Enabled": not enabled}, allow_enabled=True, reload_host=False)
        raise
    return enabled


class Handler(BaseHTTPRequestHandler):
    server_version = "AWTRIX2-Next/3.6"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def json_body(self) -> dict | list:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(min(length, 1_048_576))
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, (dict, list)):
            raise ValueError("JSON body must be an object or array")
        return value

    def send_json(self, value, status=HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        if not path.is_file() or STATIC not in path.resolve().parents:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self.send_json(system_health_snapshot())
            return
        if path == "/api/stats":
            if time.time() - STATE.get("last_host_ok", 0) >= 10:
                host_ping()
            with LOCK:
                host_online = time.time() - STATE.get("last_host_ok", 0) < 45
                self.send_json({
                    "app": STATE.get("current_app", "Time"),
                    "matrix": _tcp_established_count(7001) > 0,
                    "host": host_online,
                    "version": "AWTRIX2 Host 2045 + Next 3.6",
                    "controller": "ESP8266EX",
                    "uptime": int(time.time() - STARTED_AT),
                    "ip_address": os.environ.get("AWTRIX_PUBLIC_IP", "not configured"),
                    "apps": len(get_loop()),
                    "notifications": len(STATE.get("notifications", [])),
                    "automations": len(STATE.get("automations", {})),
                    "automation_errors": sum(1 for job in STATE.get("automations", {}).values() if job.get("status") in {"error", "stale"}),
                    "last_error": STATE.get("last_error", ""),
                })
            return
        if path == "/api/loop":
            self.send_json({name: {} for name in get_loop()})
            return
        if path == "/api/apps":
            self.send_json(app_catalog())
            return
        if path == "/api/apps/settings":
            name = parse_qs(parsed.query).get("name", [""])[0].strip()
            try:
                settings = read_app_settings(name)
                self.send_json({"name": name, "settings": settings, "secret_keys": sorted(APP_SECRET_KEYS.intersection(settings))})
            except ValueError as exc:
                self.send_json({"success": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            except RuntimeError as exc:
                self.send_json({"success": False, "error": str(exc)}, HTTPStatus.BAD_GATEWAY)
            return
        if path == "/api/settings":
            with LOCK:
                self.send_json(STATE["settings"])
            return
        if path == "/api/screen":
            with LOCK:
                payload = dict(STATE.get("last_payload", {}))
                self.send_json({"width": 32, "height": 8, "pixels": render_screen(payload), "source": "bridge", "payload": payload})
            return
        if path == "/api/custom":
            with LOCK:
                self.send_json(STATE.get("custom_apps", {}))
            return
        if path == "/api/notifications":
            with LOCK:
                self.send_json(list(reversed(STATE.get("notifications", []))))
            return
        if path == "/api/automations":
            with LOCK:
                jobs = []
                for job in STATE.get("automations", {}).values():
                    item = dict(job)
                    item["running"] = item["id"] in RUNNING_AUTOMATIONS
                    jobs.append(item)
                jobs.sort(key=lambda item: (item.get("created_at", 0), item.get("name", "")))
                self.send_json(jobs)
            return
        if path == "/api/automation/logs":
            query = parse_qs(parsed.query)
            job_id = query.get("id", [""])[0]
            with LOCK:
                logs = list(reversed(STATE.get("automation_logs", [])))
                if job_id:
                    logs = [entry for entry in logs if entry.get("job_id") == job_id]
                self.send_json(logs[:80])
            return
        if path == "/api/gifs":
            self.send_json(list_gifs())
            return
        if path == "/api/gif/preview":
            name = parse_qs(parsed.query).get("name", [""])[0].strip()
            try:
                self.send_json(gif_preview(name))
            except ValueError as exc:
                self.send_json({"success": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/effects":
            self.send_json(["Matrix", "Twinkle", "Fade", "Rainbow"])
            return
        if path == "/api/transitions":
            self.send_json(["Slide", "Fade", "Matrix"])
            return
        if path in ("/", "/index.html", "/screen", "/fullscreen"):
            self.send_file(STATIC / "index.html")
            return
        safe = (STATIC / path.lstrip("/")).resolve()
        self.send_file(safe)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/custom":
            name = parse_qs(parsed.query).get("name", [""])[0]
            with LOCK:
                existed = STATE["custom_apps"].pop(name, None) is not None
                save_state()
            self.send_json({"success": existed, "name": name})
            return
        if parsed.path == "/api/gif":
            name = parse_qs(parsed.query).get("name", [""])[0]
            existed = delete_gif(name)
            self.send_json({"success": existed, "name": name})
            return
        if parsed.path == "/api/automations":
            job_id = parse_qs(parsed.query).get("id", [""])[0]
            with LOCK:
                job = STATE.get("automations", {}).pop(job_id, None)
                if job and job.get("mode") == "custom":
                    app_name = job.get("app_name", job_id)
                    STATE["custom_apps"].pop(app_name, None)
                    STATE["custom_meta"].pop(app_name, None)
                save_state()
            AUTOMATION_WAKE.set()
            self.send_json({"success": job is not None, "id": job_id})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            payload = self.json_body()
            if path == "/api/notify":
                if not isinstance(payload, dict) or not str(payload.get("text", "")).strip():
                    raise ValueError("text is required")
                translated = v2_payload(payload, force=True)
                _, host_response = host_request("/api/v3/notify", translated)
                record = {
                    "id": secrets.token_hex(4),
                    "at": int(time.time()),
                    "status": "sent",
                    **payload,
                }
                with LOCK:
                    STATE["notifications"] = (STATE.get("notifications", []) + [record])[-30:]
                    STATE["last_payload"] = payload
                    STATE["current_app"] = "Notification"
                    save_state()
                self.send_json({"success": True, "queued": True, "id": record["id"], "host": host_response.strip("$\n ")})
                return
            if path == "/api/gif":
                if not isinstance(payload, dict):
                    raise ValueError("GIF 上传必须是 JSON 对象")
                name = str(payload.get("name", "")).strip()
                if not name:
                    raise ValueError("name is required")
                resize_mode = str(payload.get("resize", "contain"))
                if resize_mode not in ("contain", "cover"):
                    resize_mode = "contain"
                if payload.get("data"):
                    raw = base64.b64decode(str(payload["data"]), validate=False)
                elif payload.get("url"):
                    url = validate_source_url(str(payload["url"]))
                    request = Request(url, method="GET", headers={"User-Agent": "AWTRIX2-Next/3.0"})
                    opener = build_opener(SafeRedirectHandler())
                    with opener.open(request, timeout=15) as response:
                        raw = response.read(5_242_881)
                else:
                    raise ValueError("需要 data(base64) 或 url 字段")
                if len(raw) > 5_242_880:
                    raise ValueError("GIF 文件超过 5 MB")
                decoded = decode_gif(raw, resize_mode=resize_mode)
                if payload.get("loop") is not None:
                    decoded["loop"] = max(0, int(payload["loop"]))
                stem = save_gif(name, decoded)
                self.send_json({"success": True, "name": stem, "frames": decoded["frame_count"], "delay": decoded["delay"]})
                return
            if path == "/api/gif/play":
                if not isinstance(payload, dict):
                    raise ValueError("必须是 JSON 对象")
                name = str(payload.get("name", "")).strip()
                loop = payload.get("loop")
                result = play_gif(name, loop=loop)
                self.send_json({"success": True, **result})
                return
            if path == "/api/gif/play-all":
                result = play_all_gifs()
                self.send_json({"success": True, **result})
                return
            if path == "/api/gif/stop":
                stop_gif()
                self.send_json({"success": True})
                return
            if path == "/api/automations":
                if not isinstance(payload, dict):
                    raise ValueError("自动化任务必须是 JSON 对象")
                incoming_id = str(payload.get("id", ""))
                with LOCK:
                    existing = STATE.get("automations", {}).get(incoming_id) if incoming_id else None
                job = normalize_automation(payload, existing)
                if existing and any(
                    existing.get(key) != job.get(key)
                    for key in ("source_url", "json_path", "template", "interval", "mode")
                ):
                    job.update({"next_run": int(time.time()) + job["interval"], "status": "waiting", "last_error": ""})
                with LOCK:
                    STATE.setdefault("automations", {})[job["id"]] = job
                    save_state()
                AUTOMATION_WAKE.set()
                self.send_json({"success": True, "automation": job})
                return
            if path == "/api/automations/run":
                job_id = str(payload.get("id", "")) if isinstance(payload, dict) else ""
                with LOCK:
                    exists = job_id in STATE.get("automations", {})
                    running = job_id in RUNNING_AUTOMATIONS
                if not exists:
                    raise ValueError("自动化任务不存在")
                if running:
                    self.send_json({"success": True, "id": job_id, "running": True})
                    return
                threading.Thread(target=run_automation, args=(job_id, "manual"), daemon=True).start()
                self.send_json({"success": True, "id": job_id, "running": True})
                return
            if path == "/api/automations/toggle":
                job_id = str(payload.get("id", "")) if isinstance(payload, dict) else ""
                enabled = bool(payload.get("enabled", True)) if isinstance(payload, dict) else True
                with LOCK:
                    job = STATE.get("automations", {}).get(job_id)
                    if job is None:
                        raise ValueError("自动化任务不存在")
                    job["enabled"] = enabled
                    if enabled:
                        job["next_run"] = min(int(job.get("next_run", time.time())), int(time.time()) + 2)
                        job["status"] = "waiting"
                    else:
                        job["status"] = "paused"
                    save_state()
                AUTOMATION_WAKE.set()
                self.send_json({"success": True, "id": job_id, "enabled": enabled})
                return
            if path == "/api/custom":
                name = parse_qs(parsed.query).get("name", [""])[0].strip()
                if not name:
                    raise ValueError("name query parameter is required")
                if isinstance(payload, list):
                    payload = payload[0] if payload else {}
                if not isinstance(payload, dict):
                    raise ValueError("custom app must be a JSON object")
                translated = v2_payload(payload, app_id=0, force=True)
                _, host_response = host_request("/api/v3/customapp", translated)
                with LOCK:
                    STATE["custom_apps"][name] = payload
                    STATE["last_payload"] = payload
                    STATE["current_app"] = name
                    save_state()
                try:
                    websocket_event("switch_click", {"app": "CustomApp"})
                except RuntimeError as exc:
                    with LOCK:
                        STATE["last_error"] = str(exc)
                self.send_json({"success": True, "name": name, "slot": 0, "host": host_response.strip("$\n ")})
                return
            if path == "/api/settings":
                if not isinstance(payload, dict):
                    raise ValueError("settings must be a JSON object")
                host_request("/api/v3/settings", payload)
                with LOCK:
                    STATE["settings"].update(payload)
                    save_state()
                self.send_json({"success": True, "settings": STATE["settings"]})
                return
            if path == "/api/apps/settings":
                name = parse_qs(parsed.query).get("name", [""])[0].strip()
                if not isinstance(payload, dict):
                    raise ValueError("App 设置必须是 JSON 对象")
                settings = write_app_settings(name, payload)
                self.send_json({"success": True, "name": name, "settings": settings})
                return
            if path == "/api/apps/toggle":
                name = str(payload.get("name", "")).strip() if isinstance(payload, dict) else ""
                enabled = bool(payload.get("enabled", True)) if isinstance(payload, dict) else True
                app_settings_path(name)
                actual = set_host_app_enabled(name, enabled)
                self.send_json({"success": True, "name": name, "enabled": actual})
                return
            if path == "/api/apps/order":
                order = payload.get("order", []) if isinstance(payload, dict) else []
                saved = write_host_app_order(order)
                self.send_json({"success": True, "order": saved, "apps": app_catalog()})
                return
            if path == "/api/switch":
                name = str(payload.get("name", "")) if isinstance(payload, dict) else ""
                if not name:
                    raise ValueError("name is required")
                target = "CustomApp" if name in STATE.get("custom_apps", {}) else name
                if target == "CustomApp":
                    custom_payload = STATE["custom_apps"][name]
                    host_request("/api/v3/customapp", v2_payload(custom_payload, app_id=0, force=True))
                websocket_event("switch_click", {"app": target})
                with LOCK:
                    STATE["current_app"] = name
                    STATE["last_payload"] = STATE.get("custom_apps", {}).get(name, {"text": name, "color": "#ffb000"})
                    save_state()
                self.send_json({"success": True, "name": name})
                return
            if path in ("/api/nextapp", "/api/previousapp"):
                apps = get_loop()
                current = STATE.get("current_app", apps[0] if apps else "Time")
                index = apps.index(current) if current in apps else 0
                index = (index + (1 if path.endswith("nextapp") else -1)) % len(apps)
                name = apps[index]
                target = "CustomApp" if name in STATE.get("custom_apps", {}) else name
                if target == "CustomApp":
                    host_request("/api/v3/customapp", v2_payload(STATE["custom_apps"][name], app_id=0, force=True))
                websocket_event("switch_click", {"app": target})
                with LOCK:
                    STATE["current_app"] = name
                    save_state()
                self.send_json({"success": True, "name": name})
                return
            if path == "/api/notify/dismiss":
                with LOCK:
                    STATE["current_app"] = "Time"
                    save_state()
                websocket_event("switch_click", {"app": "Time"})
                self.send_json({"success": True})
                return
            if path == "/api/power":
                power = bool(payload.get("power", True)) if isinstance(payload, dict) else True
                brightness = STATE["settings"].get("BRI", 120) if power else 0
                host_request("/api/v3/settings", {"BRI": brightness})
                self.send_json({"success": True, "power": power})
                return
            if path.startswith("/api/indicator"):
                number = path[-1]
                color = payload.get("color", "#000000") if isinstance(payload, dict) else "#000000"
                with LOCK:
                    STATE["indicators"][number] = color
                    save_state()
                self.send_json({"success": True, "indicator": int(number), "color": color})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"success": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except RuntimeError as exc:
            self.send_json({"success": False, "error": str(exc)}, HTTPStatus.BAD_GATEWAY)
        except Exception as exc:  # keep the appliance API alive and return a useful error
            self.send_json({"success": False, "error": f"{type(exc).__name__}: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    parser = argparse.ArgumentParser(description="AWTRIX2-Next bridge")
    parser.add_argument("--host", default=os.environ.get("AWTRIX_NEXT_BIND", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("AWTRIX_NEXT_PORT", "7100")))
    args = parser.parse_args()
    threading.Thread(target=automation_scheduler, name="automation-scheduler", daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"AWTRIX2-Next listening on http://{args.host}:{args.port} -> {HOST_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
