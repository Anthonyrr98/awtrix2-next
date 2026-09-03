"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  busy: 0, previewTimer: null, statsTimer: null, automationTimer: null, healthTimer: null,
  apps: {}, loopApps: [], automations: [], currentApp: "", lastScreen: null,
  deviceApps: [], deviceAppFilter: "all", selectedDeviceApp: null,
  favoriteApps: loadStoredList("awtrix-next-favorites"),
};

function loadStoredList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
  } catch { return []; }
}

function storeList(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage can be disabled */ }
}

function endpoint(path) {
  return new URL(path.replace(/^\//, ""), document.baseURI).toString();
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.json !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(endpoint(path), {
      method: options.method || "GET",
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!response.ok) throw new Error(value?.error || value || `HTTP ${response.status}`);
    return value;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toast(message, type = "ok") {
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.textContent = message;
  $("#toast-region").append(node);
  setTimeout(() => node.classList.add("leaving"), 3200);
  setTimeout(() => node.remove(), 3450);
}

function setConnection(mode, label) {
  const element = $("#connection-state");
  element.className = `state ${mode}`;
  $("span", element).textContent = label;
}

function formatUptime(seconds = 0) {
  const value = Number(seconds) || 0;
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days}天 ${hours}时` : `${hours}时 ${minutes}分`;
}

function setBusy(button, active) {
  if (!button) return;
  if (active) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.querySelector("span")?.replaceChildren("正在发送…");
  } else {
    if (button.dataset.label) button.innerHTML = button.dataset.label;
    button.disabled = false;
  }
}

function colorHex(value) {
  return `#${Number(value || 0).toString(16).padStart(6, "0").slice(-6)}`;
}

function inputColor(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) {
    return `#${value.slice(0, 3).map(part => Math.max(0, Math.min(255, Number(part) || 0)).toString(16).padStart(2, "0")).join("")}`;
  }
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function drawPixels(pixels = []) {
  const canvas = $("#matrix-preview");
  const ctx = canvas.getContext("2d");
  const cellW = canvas.width / 32;
  const cellH = canvas.height / 8;
  ctx.fillStyle = "#040504";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 32; x++) {
      const value = Number(pixels[y * 32 + x] || 0);
      const bright = value !== 0 && value !== 0x050604;
      ctx.fillStyle = bright ? colorHex(value) : ((x + y) % 2 ? "#10120e" : "#0c0e0b");
      if (bright) {
        ctx.shadowBlur = 12;
        ctx.shadowColor = ctx.fillStyle;
      }
      ctx.fillRect(x * cellW + 2.2, y * cellH + 2.2, cellW - 4.4, cellH - 4.4);
      ctx.shadowBlur = 0;
    }
  }
}

async function refreshScreen() {
  if (document.hidden || state.busy > 0) return;
  try {
    const screen = await api("api/screen", { timeout: 3000 });
    state.lastScreen = screen;
    drawPixels(screen.pixels);
    $("#preview-app").textContent = screen.payload?.text || "AWTRIX NEXT";
    $("#live-source").textContent = String(screen.source || "BRIDGE").toUpperCase();
  } catch { /* the status poll will expose the connection error */ }
}

async function refreshStats(quiet = true) {
  try {
    const stats = await api("api/stats");
    state.currentApp = stats.app || "";
    setConnection(stats.host ? "online" : "connecting", stats.host ? "链路在线" : "等待 Host");
    const values = {
      "#stat-app": stats.app || "—", "#stat-controller": stats.controller || "ESP8266EX",
      "#stat-apps": stats.apps ?? "—", "#stat-uptime": formatUptime(stats.uptime),
      "#stat-host": stats.host ? "ONLINE" : "WAIT", "#stat-automations": stats.automations ?? 0,
      "#stat-automation-errors": stats.automation_errors ?? 0, "#stat-version": stats.version || "—",
    };
    Object.entries(values).forEach(([selector, value]) => { const node = $(selector); if (node) node.textContent = value; });
    const badge = $("#stat-matrix");
    if (badge) {
      badge.textContent = stats.matrix ? "屏幕在线" : "屏幕离线";
      badge.classList.toggle("on", Boolean(stats.matrix));
    }
    const sync = $("#last-sync");
    if (sync) sync.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    renderAppLauncher();
    if (state.deviceApps.length) renderDeviceApps();
    if (!quiet) toast("状态已刷新");
  } catch (error) {
    setConnection("offline", "桥接离线");
    if (!quiet) toast(`刷新失败：${error.message}`, "error");
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function setHealthNode(selector, online, meta) {
  const node = $(selector);
  if (!node) return;
  node.classList.toggle("online", Boolean(online));
  node.classList.toggle("offline", !online);
  $(`${selector}-meta`).textContent = meta;
}

function setMetricBar(selector, percent) {
  const bar = $(selector);
  if (!bar) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  bar.style.width = `${value}%`;
  bar.classList.toggle("warn", value >= 70 && value < 85);
  bar.classList.toggle("danger", value >= 85);
}

async function refreshHealth(quiet = true) {
  const button = $("#refresh-health");
  if (button) button.classList.add("loading");
  try {
    const health = await api("api/health", { timeout: 6500 });
    const banner = $("#health-banner");
    const copy = {
      healthy: ["所有关键链路运行正常", "ALL SYSTEMS OPERATIONAL", "HEALTHY"],
      degraded: ["服务可用，但有项目需要关注", "SERVICE CHAIN DEGRADED", "ATTENTION"],
      critical: ["关键服务失联，请立即检查", "CRITICAL SERVICE FAILURE", "CRITICAL"],
    }[health.status] || ["正在检查系统状态", "CHECKING SERVICE CHAIN", "CHECKING"];
    banner.className = `health-banner ${health.status || "checking"}`;
    $("strong", banner).textContent = copy[0];
    $("small", banner).textContent = copy[1];
    $("b", banner).textContent = copy[2];

    setHealthNode("#health-bridge", health.bridge?.online, `PID ${health.bridge?.pid || "—"} · ${formatUptime(health.bridge?.uptime || 0)}`);
    setHealthNode("#health-host", health.host?.online, health.host?.online ? "HTTP 7000 · ONLINE" : "HTTP 7000 · UNREACHABLE");
    setHealthNode("#health-matrix", health.matrix?.online, health.matrix?.online ? `${health.matrix.connections} 条 MQTT 链路` : "等待屏幕连接");

    const system = health.system || {};
    $("#health-memory-value").textContent = `${system.memory_percent ?? 0}%`;
    $("#health-memory-meta").textContent = `${formatBytes(system.memory_used)} / ${formatBytes(system.memory_total)} · Swap ${formatBytes(system.swap_used)}`;
    setMetricBar("#health-memory-bar", system.memory_percent);
    $("#health-disk-value").textContent = `${system.disk_percent ?? 0}%`;
    $("#health-disk-meta").textContent = `${formatBytes(system.disk_used)} / ${formatBytes(system.disk_total)}`;
    setMetricBar("#health-disk-bar", system.disk_percent);
    const load = Array.isArray(system.load) ? system.load : [0, 0, 0];
    $("#health-load-value").textContent = load.join(" / ");
    $$("#health-load-bars i").forEach((bar, index) => { bar.style.height = `${Math.max(3, Math.min(20, (Number(load[index]) || 0) * 10))}px`; });
    $("#health-rss-value").textContent = formatBytes(health.bridge?.rss_bytes);
    $("#health-uptime-meta").textContent = `Next 已运行 ${formatUptime(health.bridge?.uptime || 0)}`;
    setMetricBar("#health-rss-bar", Math.min(100, ((health.bridge?.rss_bytes || 0) / (256 * 1024 * 1024)) * 100));

    Object.entries(health.ports || {}).forEach(([port, online]) => {
      const node = $(`[data-health-port="${port}"]`);
      if (!node) return;
      node.className = online ? "online" : "offline";
      $("b", node).textContent = online ? "OPEN" : "DOWN";
    });
    $("#health-recovery-policy").textContent = health.recovery?.policy || "未配置恢复策略";
    $("#health-heap").textContent = `${health.recovery?.heap_limit_mb || "—"} MB`;
    $("#health-last-error").textContent = health.host?.last_error || "暂无异常记录，Host 最近一次探测成功。";
    $("#health-last-ok").textContent = health.host?.last_ok ? `HOST LAST OK ${new Date(health.host.last_ok * 1000).toLocaleString("zh-CN", { hour12: false })}` : "HOST LAST OK —";
    $("#health-checked").textContent = `检测于 ${new Date((health.checked_at || Date.now() / 1000) * 1000).toLocaleTimeString("zh-CN", { hour12: false })}`;
    if (!quiet) toast("健康检测已完成");
  } catch (error) {
    const banner = $("#health-banner");
    if (banner) banner.className = "health-banner critical";
    if (banner) $("strong", banner).textContent = "健康接口不可用";
    if (!quiet) toast(`健康检测失败：${error.message}`, "error");
  } finally {
    if (button) button.classList.remove("loading");
  }
}

async function refreshLoop() {
  try {
    const apps = await api("api/loop");
    state.loopApps = Object.keys(apps || {});
    state.favoriteApps = state.favoriteApps.filter(name => state.loopApps.includes(name));
    storeList("awtrix-next-favorites", state.favoriteApps);
    renderAppLauncher();
  } catch { /* optional */ }
}

const APP_LABELS = {
  Time: ["时间", "时"], Date: ["日期", "日"], DayOfTheWeek: ["星期", "周"],
  OpenWeather: ["天气", "天"], Bilibili: ["哔哩哔哩", "B"], DouyinFans: ["抖音粉丝", "抖"],
  Moon: ["月相", "月"], BinaryClock: ["二进制时钟", "01"], AnotherTime: ["第二时区", "时"],
  Countdown: ["倒计时", "计"], Reminder: ["提醒", "醒"], DrinkWater: ["喝水提醒", "水"],
  GameOfLife: ["生命游戏", "生"], LookingEyes: ["动态眼睛", "眼"], Pong: ["乒乓动画", "P"],
  Dice: ["骰子", "骰"], HappyBirthday: ["生日祝福", "生"], MessageBoard: ["留言板", "信"],
  CustomApp: ["自定义应用", "自"],
};

const DATA_APPS = new Set(["OpenWeather", "Bilibili", "DouyinFans"]);

function appInfo(name) {
  const known = APP_LABELS[name];
  const custom = Object.prototype.hasOwnProperty.call(state.apps, name);
  return {
    label: known?.[0] || name.replace(/([a-z])([A-Z])/g, "$1 $2"),
    symbol: known?.[1] || name.slice(0, 2).toUpperCase(),
    type: custom ? "动态页面" : DATA_APPS.has(name) ? "数据应用" : "设备应用",
    kind: custom ? "custom" : DATA_APPS.has(name) ? "data" : "system",
  };
}

async function switchApplication(name, button = null) {
  if (!name || state.busy > 0) return;
  state.busy++;
  if (button) button.disabled = true;
  try {
    await api("api/switch", { method: "POST", json: { name } });
    state.currentApp = name;
    renderAppLauncher();
    toast(`已切换到 ${appInfo(name).label}`);
    await Promise.all([refreshStats(true), refreshScreen()]);
  } catch (error) { toast(`切换失败：${error.message}`, "error"); }
  finally { if (button) button.disabled = false; state.busy--; }
}

function toggleFavoriteApp(name) {
  if (state.favoriteApps.includes(name)) state.favoriteApps = state.favoriteApps.filter(value => value !== name);
  else state.favoriteApps = [name, ...state.favoriteApps].slice(0, 8);
  storeList("awtrix-next-favorites", state.favoriteApps);
  renderAppLauncher();
}

function appTile(name) {
  const info = appInfo(name);
  const tile = document.createElement("div");
  tile.className = `app-tile ${info.kind}${name === state.currentApp ? " current" : ""}`;
  tile.dataset.app = name;
  const launch = document.createElement("button");
  launch.type = "button";
  launch.className = "app-launch-button";
  launch.setAttribute("aria-label", `切换到${info.label}`);
  const emblem = document.createElement("span");
  emblem.className = "app-emblem";
  emblem.textContent = info.symbol;
  const copy = document.createElement("span");
  copy.className = "app-copy";
  const title = document.createElement("strong");
  title.textContent = info.label;
  const detail = document.createElement("small");
  detail.textContent = name === state.currentApp ? "正在显示 · LIVE" : `${info.type} · ${name}`;
  copy.append(title, detail);
  launch.append(emblem, copy);
  launch.addEventListener("click", () => switchApplication(name, launch));
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = `app-pin${state.favoriteApps.includes(name) ? " pinned" : ""}`;
  pin.textContent = state.favoriteApps.includes(name) ? "★" : "☆";
  pin.setAttribute("aria-label", `${state.favoriteApps.includes(name) ? "取消置顶" : "置顶"}${info.label}`);
  pin.addEventListener("click", () => toggleFavoriteApp(name));
  tile.append(launch, pin);
  return tile;
}

function renderAppLauncher() {
  const grid = $("#app-launcher");
  const favorites = $("#favorite-apps");
  if (!grid || !favorites) return;
  const query = ($("#app-search")?.value || "").trim().toLocaleLowerCase("zh-CN");
  const filtered = state.loopApps.filter(name => {
    const info = appInfo(name);
    return !query || `${name} ${info.label} ${info.type}`.toLocaleLowerCase("zh-CN").includes(query);
  });
  filtered.sort((left, right) => {
    if (left === state.currentApp) return -1;
    if (right === state.currentApp) return 1;
    return state.loopApps.indexOf(left) - state.loopApps.indexOf(right);
  });
  grid.replaceChildren();
  filtered.forEach(name => grid.append(appTile(name)));
  if (!filtered.length) grid.append(Object.assign(document.createElement("p"), { className: "empty-state", textContent: query ? "没有匹配的应用" : "没有可用应用" }));
  $("#app-launcher-count").textContent = `${filtered.length} / ${state.loopApps.length} APPS`;

  favorites.replaceChildren();
  const pinned = state.favoriteApps.filter(name => state.loopApps.includes(name));
  favorites.hidden = query.length > 0 || pinned.length === 0;
  pinned.forEach(name => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `favorite-chip${name === state.currentApp ? " current" : ""}`;
    button.textContent = appInfo(name).label;
    button.addEventListener("click", () => switchApplication(name, button));
    favorites.append(button);
  });
}

const APP_SETTING_META = {
  DisplayTime: ["显示时长", "应用每次停留的秒数；0 使用系统默认值。", "number"],
  UpdateInterval: ["更新间隔", "联网数据或内容的刷新间隔；0 使用应用默认值。", "number"],
  StartTime: ["开始时间", "应用每天允许显示的开始时间。", "time"],
  EndTime: ["结束时间", "应用每天停止显示的时间。", "time"],
  CustomColor: ["自定义颜色", "留空使用应用默认颜色，可填写 RGB 或应用支持的颜色值。", "text"],
  MID: ["UP 主 MID", "Bilibili 用户主页中的数字 MID。", "text"],
  APIKey: ["OpenWeather API Key", "密钥已安全隐藏；留空不会覆盖当前值。", "password"],
  Unit: ["温度单位", "OpenWeather 使用的单位，例如 metric。", "text"],
  LocationID: ["城市 ID", "OpenWeather 城市 Location ID。", "text"],
  OpenID: ["抖音 OpenID", "已授权抖音账号的 OpenID。", "text"],
  BusinessToken: ["业务 Token", "令牌已安全隐藏；留空不会覆盖当前值。", "password"],
  DateType: ["日期类型", "抖音接口请求使用的日期范围类型。", "text"],
  ShowSeconds: ["显示秒数", "在时钟中显示秒。", "boolean"],
  ShowWeekday: ["显示星期", "同时显示当前星期。", "boolean"],
  ShowDate: ["显示日期", "在时钟应用中轮播日期。", "boolean"],
  "12hrFormat": ["12 小时制", "使用 AM/PM 时间格式。", "boolean"],
  DisableBlinking: ["关闭闪烁", "关闭时钟分隔符的闪烁效果。", "boolean"],
  StartsSunday: ["周日为一周首日", "周序和日历从周日开始。", "boolean"],
  DateFormat: ["日期格式", "应用使用的日期格式字符串。", "text"],
  WeekdaysColor: ["工作日颜色", "日期应用中工作日的颜色值。", "text"],
  CurrentDayColor: ["当天颜色", "日期应用中当前日期的高亮颜色。", "text"],
  Date: ["目标日期", "倒计时的目标日期。", "date"],
  Identifier: ["标识文字", "用于区分倒计时或提醒的短标签。", "text"],
  IconID: ["图标 ID", "AWTRIX 图标库中的数字 ID。", "number"],
  DayOfMonth: ["每月日期", "每月第几天触发提醒。", "number"],
  ShowText: ["显示文字", "应用滚动显示的内容。", "text"],
  RemindEvery: ["提醒间隔", "两次喝水提醒之间的分钟数。", "number"],
  GlassVolume: ["每杯容量", "每次饮水的毫升数。", "number"],
  Goal: ["每日目标", "每天计划饮水的毫升数。", "number"],
  RemindSound: ["提醒声音", "提醒时使用的音效名称。", "text"],
  DrinkSound: ["完成声音", "记录饮水后使用的音效名称。", "text"],
  PlaySound: ["播放声音", "启用应用声音反馈。", "boolean"],
  AutoReset: ["自动重置", "生命游戏停止演化时自动生成新局。", "boolean"],
  Speed: ["动画速度", "动画更新速度。", "number"],
  Seeds: ["初始种子", "生命游戏初始化的随机像素数量。", "number"],
  ColorOld: ["旧细胞颜色", "生命游戏旧细胞的颜色值。", "text"],
  ColorNew: ["新细胞颜色", "生命游戏新细胞的颜色值。", "text"],
  NumberDice: ["骰子数量", "一次投掷的骰子数量。", "number"],
  Name: ["姓名", "生日祝福中显示的姓名。", "text"],
  ShowWeekOfYear: ["显示周数", "显示当前是当年的第几周。", "boolean"],
};

const COMMON_APP_SETTINGS = ["DisplayTime", "UpdateInterval", "StartTime", "EndTime", "CustomColor"];

function appSettingMeta(key, value) {
  const known = APP_SETTING_META[key];
  if (known) return { label: known[0], hint: known[1], type: known[2] };
  const label = key.replace(/([a-z])([A-Z])/g, "$1 $2");
  return { label, hint: "此项由该应用提供。", type: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "text" };
}

function deviceAppIcon(app, className = "device-app-icon") {
  const frame = document.createElement("div");
  frame.className = className;
  if (className === "drawer-app-icon") frame.id = "drawer-app-icon";
  const fallback = document.createElement("span");
  fallback.textContent = appInfo(app.name).symbol;
  frame.append(fallback);
  if (app.icon) {
    const image = document.createElement("img");
    image.src = `https://awtrix.blueforcer.de/icons/${encodeURIComponent(app.icon)}`;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("load", () => frame.classList.add("loaded"));
    image.addEventListener("error", () => image.remove());
    frame.prepend(image);
  }
  return frame;
}

function deviceAppCard(app) {
  const card = document.createElement("article");
  card.className = `device-app-card${app.enabled ? " enabled" : " disabled"}${app.name === state.currentApp ? " current" : ""}`;
  card.dataset.app = app.name;
  card.tabIndex = 0;
  const header = document.createElement("header");
  const title = document.createElement("div");
  title.className = "device-app-title";
  const titleText = document.createElement("strong");
  if (app.enabled && app.order) titleText.append(Object.assign(document.createElement("span"), { className: "device-app-order", textContent: String(app.order).padStart(2, "0") }));
  titleText.append(app.label);
  title.append(titleText, Object.assign(document.createElement("small"), { textContent: app.name }));
  const actions = document.createElement("div");
  actions.className = "device-app-actions";
  if (app.enabled) {
    const query = ($("#device-app-search")?.value || "").trim();
    const canReorder = !query && state.deviceAppFilter !== "disabled";
    const drag = document.createElement("button");
    drag.type = "button"; drag.className = "app-drag-handle"; drag.textContent = "⠿";
    drag.disabled = !canReorder;
    drag.title = canReorder ? "拖动调整 LED 显示顺序" : "清除搜索或切换到全部/已启用后排序";
    drag.setAttribute("aria-label", `${app.label}排序手柄`);
    drag.addEventListener("click", event => event.stopPropagation());
    drag.addEventListener("pointerdown", event => beginDeviceAppDrag(event, card, drag));
    drag.addEventListener("keydown", event => keyboardMoveDeviceApp(event, card));
    actions.append(drag);
  }
  const settings = document.createElement("button");
  settings.type = "button"; settings.textContent = "⚙"; settings.title = "应用设置"; settings.setAttribute("aria-label", `${app.label}设置`);
  settings.addEventListener("click", event => { event.stopPropagation(); openAppSettings(app); });
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.textContent = app.enabled ? "◉" : "○"; toggle.title = app.enabled ? "停用应用" : "启用应用"; toggle.setAttribute("aria-label", toggle.title);
  toggle.addEventListener("click", event => { event.stopPropagation(); toggleDeviceApp(app, !app.enabled, toggle); });
  actions.append(settings, toggle);
  header.append(title, actions);

  const body = document.createElement("div");
  body.className = "device-app-body";
  const icon = deviceAppIcon(app);
  const description = document.createElement("p");
  description.textContent = app.description;
  body.append(icon, description);

  const footer = document.createElement("footer");
  const status = document.createElement("span");
  status.className = "device-app-status";
  status.textContent = app.name === state.currentApp ? "● 正在显示" : app.enabled ? "● 已启用" : "○ 未启用";
  const version = document.createElement("b");
  version.textContent = `v${app.version}`;
  footer.append(status, version);
  card.append(header, body, footer);
  card.addEventListener("click", () => openAppSettings(app));
  card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAppSettings(app); } });
  return card;
}

let activeAppDrag = null;

function orderState(label, mode = "") {
  const node = $("#app-order-save-state");
  if (!node) return;
  node.textContent = label;
  node.className = mode;
}

function visibleEnabledCards() {
  return $$("#device-app-grid .device-app-card.enabled");
}

async function persistDeviceAppOrder() {
  const order = visibleEnabledCards().map(card => card.dataset.app);
  const expected = state.deviceApps.filter(app => app.enabled).length;
  if (order.length !== expected) return toast("请清除搜索并显示全部已启用应用后再排序", "error");
  orderState("正在保存…", "saving");
  try {
    const result = await api("api/apps/order", { method: "POST", json: { order }, timeout: 18000 });
    state.deviceApps = result.apps || state.deviceApps;
    renderDeviceApps();
    orderState("已同步到 LED", "saved");
    toast("LED 轮播顺序已更新");
    setTimeout(() => orderState("自动保存"), 2200);
  } catch (error) {
    orderState("保存失败", "error");
    toast(`排序保存失败：${error.message}`, "error");
    await refreshDeviceApps(true);
  }
}

function moveDraggedCard(clientX, clientY) {
  if (!activeAppDrag) return;
  const target = document.elementFromPoint(clientX, clientY)?.closest(".device-app-card.enabled");
  const card = activeAppDrag.card;
  if (!target || target === card || target.parentElement !== card.parentElement) return;
  const cards = visibleEnabledCards();
  const from = cards.indexOf(card), to = cards.indexOf(target);
  if (from < to) target.after(card);
  else target.before(card);
}

function beginDeviceAppDrag(event, card, handle) {
  if (event.button !== 0 || handle.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const initial = visibleEnabledCards().map(node => node.dataset.app).join("|");
  activeAppDrag = { card, handle, pointerId: event.pointerId, initial };
  card.classList.add("dragging");
  document.body.classList.add("sorting-apps");
  handle.setPointerCapture?.(event.pointerId);
  const move = moveEvent => moveDraggedCard(moveEvent.clientX, moveEvent.clientY);
  const finish = async finishEvent => {
    if (!activeAppDrag || finishEvent.pointerId !== activeAppDrag.pointerId) return;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    card.classList.remove("dragging");
    document.body.classList.remove("sorting-apps");
    const changed = initial !== visibleEnabledCards().map(node => node.dataset.app).join("|");
    activeAppDrag = null;
    if (changed) await persistDeviceAppOrder();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

async function keyboardMoveDeviceApp(event, card) {
  const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : 0;
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  const cards = visibleEnabledCards();
  const index = cards.indexOf(card);
  const target = cards[index + direction];
  if (!target) return;
  if (direction < 0) target.before(card); else target.after(card);
  await persistDeviceAppOrder();
  $( `.device-app-card[data-app="${CSS.escape(card.dataset.app)}"] .app-drag-handle` )?.focus();
}

function renderDeviceApps() {
  const grid = $("#device-app-grid");
  if (!grid) return;
  const query = ($("#device-app-search")?.value || "").trim().toLocaleLowerCase("zh-CN");
  const filtered = state.deviceApps.filter(app => {
    const filterMatch = state.deviceAppFilter === "all" || (state.deviceAppFilter === "enabled" ? app.enabled : !app.enabled);
    const queryMatch = !query || `${app.name} ${app.label} ${app.description}`.toLocaleLowerCase("zh-CN").includes(query);
    return filterMatch && queryMatch;
  });
  grid.replaceChildren();
  filtered.forEach(app => grid.append(deviceAppCard(app)));
  if (!filtered.length) grid.append(Object.assign(document.createElement("p"), { className: "empty-state", textContent: "没有匹配的设备应用" }));
  $("#device-app-total").textContent = state.deviceApps.length;
  $("#device-app-enabled").textContent = state.deviceApps.filter(app => app.enabled).length;
  orderState("自动保存");
}

async function refreshDeviceApps(quiet = false) {
  const refresh = $("#refresh-device-apps");
  if (refresh) refresh.disabled = true;
  try {
    state.deviceApps = await api("api/apps", { timeout: 12000 }) || [];
    renderDeviceApps();
    if (!quiet) toast("应用列表已刷新");
  } catch (error) {
    if (!quiet) toast(`读取应用失败：${error.message}`, "error");
  } finally { if (refresh) refresh.disabled = false; }
}

async function toggleDeviceApp(app, enabled, button = null) {
  if (button) button.disabled = true;
  try {
    const result = await api("api/apps/toggle", { method: "POST", json: { name: app.name, enabled }, timeout: 12000 });
    toast(`${app.label} 已${result.enabled ? "启用" : "停用"}`);
    await Promise.all([refreshDeviceApps(true), refreshLoop()]);
    if (state.selectedDeviceApp?.name === app.name) $("#drawer-app-enabled").checked = Boolean(result.enabled);
  } catch (error) { toast(`操作失败：${error.message}`, "error"); }
  finally { if (button) button.disabled = false; }
}

function appSettingField(key, value, secretKeys) {
  const meta = appSettingMeta(key, value);
  if (key === "Enabled") return null;
  const row = document.createElement("label");
  row.className = `app-setting-field${meta.type === "boolean" ? " boolean-field" : ""}`;
  row.dataset.setting = key;
  const copy = document.createElement("span");
  copy.append(Object.assign(document.createElement("strong"), { textContent: meta.label }), Object.assign(document.createElement("small"), { textContent: meta.hint }));
  let input;
  if (meta.type === "boolean") {
    input = document.createElement("input"); input.type = "checkbox"; input.checked = Boolean(value);
    const track = document.createElement("i");
    row.append(copy, input, track);
  } else {
    input = document.createElement("input");
    input.type = meta.type;
    if (meta.type === "number") input.step = "1";
    input.value = secretKeys.includes(key) ? "" : String(value ?? "");
    if (secretKeys.includes(key)) input.placeholder = value ? "已保存，留空不修改" : "尚未设置";
    row.append(copy, input);
  }
  input.name = key;
  input.dataset.originalType = typeof value;
  input.autocomplete = "off";
  return row;
}

async function openAppSettings(app) {
  state.selectedDeviceApp = app;
  $("#app-settings-title").textContent = app.label;
  $("#app-settings-subtitle").textContent = `${app.name} · v${app.version}`;
  $("#drawer-app-enabled").checked = Boolean(app.enabled);
  const oldIcon = $("#drawer-app-icon");
  oldIcon.replaceWith(deviceAppIcon(app, "drawer-app-icon"));
  $("#app-settings-fields").replaceChildren(Object.assign(document.createElement("p"), { className: "empty-state", textContent: "正在读取设置…" }));
  $("#app-settings-backdrop").hidden = false;
  $("#app-settings-drawer").classList.add("open");
  $("#app-settings-drawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  try {
    const result = await api(`api/apps/settings?name=${encodeURIComponent(app.name)}`, { timeout: 12000 });
    const settings = result.settings || {};
    const keys = Object.keys(settings).filter(key => key !== "Enabled").sort((left, right) => {
      const a = COMMON_APP_SETTINGS.indexOf(left), b = COMMON_APP_SETTINGS.indexOf(right);
      if (a >= 0 || b >= 0) return (a < 0 ? 99 : a) - (b < 0 ? 99 : b);
      return left.localeCompare(right);
    });
    const fields = $("#app-settings-fields");
    fields.replaceChildren();
    let commonHeading = false, specificHeading = false;
    keys.forEach(key => {
      const common = COMMON_APP_SETTINGS.includes(key);
      if (common && !commonHeading) { fields.append(Object.assign(document.createElement("h3"), { textContent: "通用设置" })); commonHeading = true; }
      if (!common && !specificHeading) { fields.append(Object.assign(document.createElement("h3"), { textContent: "应用专属设置" })); specificHeading = true; }
      const field = appSettingField(key, settings[key], result.secret_keys || []);
      if (field) fields.append(field);
    });
    if (!keys.length) fields.append(Object.assign(document.createElement("p"), { className: "empty-state", textContent: "这个应用没有可调整的设置" }));
  } catch (error) {
    $("#app-settings-fields").replaceChildren(Object.assign(document.createElement("p"), { className: "empty-state error-state", textContent: `设置读取失败：${error.message}` }));
  }
}

function closeAppSettings() {
  $("#app-settings-drawer").classList.remove("open");
  $("#app-settings-drawer").setAttribute("aria-hidden", "true");
  $("#app-settings-backdrop").hidden = true;
  document.body.classList.remove("drawer-open");
}

async function refreshSettings() {
  try {
    const settings = await api("api/settings");
    if (settings.BRI !== undefined) {
      $("#brightness").value = settings.BRI;
      updateBrightness();
    }
  } catch { /* optional */ }
}

function historyItem(record) {
  const item = document.createElement("div");
  item.className = "history-item";
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = record.text || "(空通知)";
  const time = document.createElement("time");
  time.textContent = new Date((record.at || 0) * 1000).toLocaleString("zh-CN", { hour12: false });
  content.append(title, time);
  const badge = document.createElement("b");
  badge.textContent = "DELIVERED";
  item.append(content, badge);
  return item;
}

async function refreshHistory() {
  const list = $("#notification-history");
  try {
    const records = await api("api/notifications");
    list.replaceChildren();
    records.slice(0, 12).forEach(record => list.append(historyItem(record)));
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "尚无发送记录";
      list.append(empty);
    }
  } catch (error) {
    toast(`读取发送记录失败：${error.message}`, "error");
  }
}

function registryItem(name, payload) {
  const item = document.createElement("div");
  item.className = "registry-item";
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = name;
  const detail = document.createElement("small");
  detail.textContent = typeof payload.text === "string" ? payload.text : JSON.stringify(payload.text || "");
  content.append(title, detail);
  const actions = document.createElement("div");
  actions.className = "registry-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => {
    $("#custom-name").value = name;
    $("#custom-text").value = payload.text || "";
    $("#custom-color").value = inputColor(payload.color, "#67d5d1");
    $("#custom-background").value = inputColor(payload.background, "#050604");
    $("#custom-progress").value = payload.progress ?? 0;
    $("#custom-progress-color").value = inputColor(payload.progressC, "#ffb000");
    $("#custom-progress-background").value = inputColor(payload.progressBC, "#20251e");
    $("#custom-icon").value = payload.icon ?? "";
    $("#custom-push-icon").value = String(payload.pushIcon ?? 0);
    $("#custom-scroll-speed").value = payload.scrollSpeed ?? 100;
    $("#custom-rainbow").checked = Boolean(payload.rainbow);
    $("#custom-no-scroll").checked = Boolean(payload.noScroll);
    $("#custom-json").value = JSON.stringify(payload, null, 2);
    $("#custom-json").focus();
  });
  const show = document.createElement("button");
  show.type = "button";
  show.textContent = "显示";
  show.addEventListener("click", () => runCommand("api/switch", { name }, `已切换到 ${name}`));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    try {
      await api(`api/custom?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`已删除 ${name}`);
      await Promise.all([refreshCustomApps(), refreshLoop()]);
    } catch (error) { toast(`删除失败：${error.message}`, "error"); }
  });
  actions.append(edit, show, remove);
  item.append(content, actions);
  return item;
}

async function refreshCustomApps() {
  const list = $("#custom-apps");
  try {
    const apps = await api("api/custom");
    state.apps = apps || {};
    renderAppLauncher();
    list.replaceChildren();
    Object.entries(state.apps).forEach(([name, payload]) => list.append(registryItem(name, payload)));
    $("#custom-count").textContent = `${Object.keys(state.apps).length} APPS`;
    if (!Object.keys(state.apps).length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "还没有动态页面";
      list.append(empty);
    }
  } catch (error) { toast(`读取动态页面失败：${error.message}`, "error"); }
}

function localClock(timestamp) {
  if (!timestamp) return "—";
  return new Date(Number(timestamp) * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

function nextRunLabel(job) {
  if (!job.enabled) return "已暂停";
  if (job.running) return "正在运行";
  const seconds = Math.max(0, Math.round(Number(job.next_run || 0) - Date.now() / 1000));
  if (seconds < 60) return `${seconds} 秒后`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟后`;
  return `${Math.ceil(seconds / 3600)} 小时后`;
}

function statusLabel(job) {
  if (job.running) return "RUNNING";
  const labels = { healthy: "HEALTHY", error: "ERROR", stale: "STALE", paused: "PAUSED", waiting: "WAITING" };
  return labels[job.status] || String(job.status || "WAITING").toUpperCase();
}

function setAutomationForm(job = null) {
  $("#automation-id").value = job?.id || "";
  $("#automation-name").value = job?.name || "我的数据任务";
  $("#automation-mode").value = job?.mode || "notification";
  $("#automation-interval").value = job?.interval || 300;
  $("#automation-duration").value = job?.duration || 10;
  $("#automation-url").value = job?.source_url || "";
  $("#automation-path").value = job?.json_path || "";
  $("#automation-template").value = job?.template || "{name} {value}";
  $("#automation-app-name").value = job?.app_name || "auto_data";
  $("#automation-icon").value = job?.icon || "";
  $("#automation-color").value = inputColor(job?.color, "#67d5d1");
  $("#automation-background").value = inputColor(job?.background, "#050604");
  $("#automation-lifetime").value = job?.lifetime ?? 0;
  $("#automation-lifetime-mode").value = String(job?.lifetimeMode ?? 0);
  $("#automation-enabled").checked = job?.enabled ?? true;
  $("#automation-show").checked = Boolean(job?.show_on_update);
  $("#automation-rainbow").checked = Boolean(job?.rainbow);
  $("#automation-save span").textContent = job ? "更新自动化" : "保存自动化";
}

function automationFormValue() {
  return {
    id: $("#automation-id").value || undefined,
    name: $("#automation-name").value.trim(),
    mode: $("#automation-mode").value,
    interval: Number($("#automation-interval").value),
    duration: Number($("#automation-duration").value),
    source_url: $("#automation-url").value.trim(),
    json_path: $("#automation-path").value.trim(),
    template: $("#automation-template").value,
    app_name: $("#automation-app-name").value.trim(),
    icon: $("#automation-icon").value.trim(),
    color: $("#automation-color").value,
    background: $("#automation-background").value,
    lifetime: Number($("#automation-lifetime").value),
    lifetimeMode: Number($("#automation-lifetime-mode").value),
    enabled: $("#automation-enabled").checked,
    show_on_update: $("#automation-show").checked,
    rainbow: $("#automation-rainbow").checked,
  };
}

function automationCard(job) {
  const card = document.createElement("div");
  card.className = `automation-card ${job.running ? "running" : job.status || "waiting"}${job.enabled ? "" : " paused"}`;
  const head = document.createElement("div");
  head.className = "automation-card-head";
  const title = document.createElement("div");
  title.className = "automation-card-title";
  const strong = document.createElement("strong");
  strong.textContent = job.name;
  const source = document.createElement("small");
  try { source.textContent = new URL(job.source_url).hostname; } catch { source.textContent = job.source_url; }
  title.append(strong, source);
  const status = document.createElement("b");
  status.className = "job-status";
  status.textContent = statusLabel(job);
  head.append(title, status);

  const meta = document.createElement("div");
  meta.className = "automation-card-meta";
  const last = document.createElement("span");
  last.append("上次 ", Object.assign(document.createElement("b"), { textContent: localClock(job.last_run) }));
  const next = document.createElement("span");
  next.append("下次 ", Object.assign(document.createElement("b"), { textContent: nextRunLabel(job) }));
  const value = document.createElement("span");
  value.append("结果 ", Object.assign(document.createElement("b"), { textContent: job.last_value == null ? "—" : String(job.last_value).slice(0, 28) }));
  const failures = document.createElement("span");
  failures.append("失败 ", Object.assign(document.createElement("b"), { textContent: String(job.failures || 0) }));
  meta.append(last, next, value, failures);

  const actions = document.createElement("div");
  actions.className = "automation-actions";
  const run = document.createElement("button");
  run.type = "button"; run.textContent = "运行"; run.disabled = Boolean(job.running);
  run.addEventListener("click", async () => {
    try {
      await api("api/automations/run", { method: "POST", json: { id: job.id } });
      toast(`${job.name} 已开始运行`);
      setTimeout(refreshAutomations, 350);
    } catch (error) { toast(`运行失败：${error.message}`, "error"); }
  });
  const edit = document.createElement("button");
  edit.type = "button"; edit.textContent = "编辑";
  edit.addEventListener("click", () => { setAutomationForm(job); $("#automation-form").scrollIntoView({ behavior: "smooth", block: "start" }); });
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.textContent = job.enabled ? "暂停" : "启用";
  toggle.addEventListener("click", async () => {
    try {
      await api("api/automations/toggle", { method: "POST", json: { id: job.id, enabled: !job.enabled } });
      toast(`${job.name} 已${job.enabled ? "暂停" : "启用"}`);
      await refreshAutomations();
    } catch (error) { toast(`操作失败：${error.message}`, "error"); }
  });
  const remove = document.createElement("button");
  remove.type = "button"; remove.textContent = "删除"; remove.className = "danger";
  remove.addEventListener("click", async () => {
    try {
      await api(`api/automations?id=${encodeURIComponent(job.id)}`, { method: "DELETE" });
      toast(`${job.name} 已删除`);
      await refreshAutomations();
    } catch (error) { toast(`删除失败：${error.message}`, "error"); }
  });
  actions.append(run, edit, toggle, remove);
  card.append(head, meta, actions);
  return card;
}

function automationLogItem(entry) {
  const item = document.createElement("div");
  item.className = `automation-log ${entry.level || "info"}`;
  const time = document.createElement("time");
  time.textContent = localClock(entry.at);
  const light = document.createElement("i");
  const message = document.createElement("span");
  const job = state.automations.find(value => value.id === entry.job_id);
  message.textContent = `${job?.name || entry.job_id}: ${entry.message}`;
  item.append(time, light, message);
  return item;
}

async function refreshAutomations() {
  try {
    const [jobs, logs] = await Promise.all([api("api/automations"), api("api/automation/logs")]);
    state.automations = jobs || [];
    const list = $("#automation-list");
    list.replaceChildren();
    state.automations.forEach(job => list.append(automationCard(job)));
    if (!state.automations.length) list.append(Object.assign(document.createElement("p"), { className: "empty-state", textContent: "还没有自动化任务" }));
    $("#automation-total").textContent = state.automations.length;
    $("#automation-healthy").textContent = state.automations.filter(job => job.status === "healthy").length;
    $("#automation-attention").textContent = state.automations.filter(job => ["error", "stale"].includes(job.status)).length;
    const logList = $("#automation-logs");
    logList.replaceChildren();
    (logs || []).forEach(entry => logList.append(automationLogItem(entry)));
    if (!logs?.length) logList.append(Object.assign(document.createElement("p"), { className: "empty-state", textContent: "暂无运行记录" }));
  } catch (error) { toast(`读取自动化失败：${error.message}`, "error"); }
}

async function runCommand(path, payload, success) {
  state.busy++;
  try {
    await api(path, { method: "POST", json: payload || {} });
    toast(success);
    await Promise.all([refreshStats(true), refreshScreen()]);
  } catch (error) {
    toast(`操作失败：${error.message}`, "error");
  } finally { state.busy--; }
}

function updateBrightness() {
  const input = $("#brightness");
  const value = Number(input.value);
  $("#brightness-value").value = value;
  input.style.setProperty("--fill", `${((value - 1) / 254) * 100}%`);
}

function syncCustomJson() {
  let value;
  try { value = JSON.parse($("#custom-json").value); } catch { value = {}; }
  value.text = $("#custom-text").value;
  value.color = $("#custom-color").value;
  value.background = $("#custom-background").value;
  value.center = value.center ?? true;
  const progress = Number($("#custom-progress").value);
  if (Number.isFinite(progress)) value.progress = progress;
  value.progressC = $("#custom-progress-color").value;
  value.progressBC = $("#custom-progress-background").value;
  value.pushIcon = Number($("#custom-push-icon").value);
  value.scrollSpeed = Math.max(10, Math.min(500, Number($("#custom-scroll-speed").value) || 100));
  value.rainbow = $("#custom-rainbow").checked;
  value.noScroll = $("#custom-no-scroll").checked;
  const icon = $("#custom-icon").value.trim();
  if (icon) value.icon = icon;
  else delete value.icon;
  $("#custom-json").value = JSON.stringify(value, null, 2);
}

$$('[data-tab]').forEach(button => button.addEventListener("click", () => {
  $$('[data-tab]').forEach(node => node.classList.toggle("active", node === button));
  $$(".tab-page").forEach(page => {
    const active = page.id === `tab-${button.dataset.tab}`;
    page.hidden = !active;
    page.classList.toggle("active", active);
  });
  if (button.dataset.tab === "apps" && !state.deviceApps.length) refreshDeviceApps(true);
  if (button.dataset.tab === "gif") refreshGifs();
  if (button.dataset.tab === "health") refreshHealth(true);
}));

$$('[data-host-src]').forEach(button => button.addEventListener("click", () => {
  $$('[data-host-src]').forEach(node => node.classList.toggle("active", node === button));
  const frame = $("#host-tool-frame");
  frame.src = button.dataset.hostSrc;
  $("#host-tool-title").textContent = button.firstChild.textContent.trim().toUpperCase();
}));

$("#host-tool-reload").addEventListener("click", () => {
  const frame = $("#host-tool-frame");
  frame.src = frame.src;
});

$("#notify-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#send-notify");
  const payload = {
    text: $("#notify-text").value.trim(),
    color: $("#notify-color").value,
    background: $("#notify-background").value,
    duration: Math.max(1, Number($("#notify-duration").value) || 10),
    repeat: Math.max(1, Number($("#notify-repeat").value) || 1),
    center: $("#notify-center").checked,
    stack: $("#notify-stack").checked,
    pushIcon: Number($("#notify-push-icon").value),
    scrollSpeed: Math.max(10, Math.min(500, Number($("#notify-scroll-speed").value) || 100)),
  };
  const icon = $("#notify-icon").value.trim();
  if (icon) payload.icon = icon;
  const progress = $("#notify-progress").value.trim();
  if (progress !== "") {
    payload.progress = Math.max(0, Math.min(100, Number(progress) || 0));
    payload.progressC = $("#notify-progress-color").value;
    payload.progressBC = $("#notify-progress-background").value;
  }
  if (!payload.text) return toast("请输入通知文字", "error");
  state.busy++;
  setBusy(button, true);
  try {
    const result = await api("api/notify", { method: "POST", json: payload });
    toast(`消息已送入实体屏${result.id ? ` · ${result.id}` : ""}`);
    await Promise.all([refreshHistory(), refreshStats(true), refreshScreen()]);
  } catch (error) { toast(`发送失败：${error.message}`, "error"); }
  finally { setBusy(button, false); state.busy--; }
});

$("#custom-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("#custom-name").value.trim().replace(/\s+/g, "_");
  if (!name) return toast("请输入应用名", "error");
  let payload;
  try { payload = JSON.parse($("#custom-json").value); }
  catch (error) { return toast(`JSON 无效：${error.message}`, "error"); }
  state.busy++;
  try {
    await api(`api/custom?name=${encodeURIComponent(name)}`, { method: "POST", json: payload });
    toast(`${name} 已保存并切换到实体屏`);
    await Promise.all([refreshCustomApps(), refreshLoop(), refreshStats(true), refreshScreen()]);
  } catch (error) { toast(`保存失败：${error.message}`, "error"); }
  finally { state.busy--; }
});

$("#format-json").addEventListener("click", () => {
  try {
    $("#custom-json").value = JSON.stringify(JSON.parse($("#custom-json").value), null, 2);
    toast("JSON 已格式化");
  } catch (error) { toast(`JSON 无效：${error.message}`, "error"); }
});

const automationPresets = {
  bilibili: { name: "Bilibili 粉丝", json_path: "data.follower", template: "B站粉丝 {value}", app_name: "bilibili_fans", interval: 600, color: "#00a1d6" },
  weather: { name: "天气温度", json_path: "current.temperature_2m", template: "温度 {value}°C", app_name: "weather", interval: 600, color: "#67d5d1" },
  douyin: { name: "抖音粉丝", json_path: "data.follower_count", template: "抖音粉丝 {value}", app_name: "douyin_fans", interval: 600, color: "#fe2c55" },
};

$$('[data-preset]').forEach(button => button.addEventListener("click", () => {
  const preset = automationPresets[button.dataset.preset];
  setAutomationForm({ ...preset, enabled: true, mode: "notification", duration: 10, background: "#050604" });
  $("#automation-url").focus();
  toast("模板已载入，请填写公网 HTTPS 接口并核对 JSON 路径");
}));

$("#automation-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#automation-save");
  const payload = automationFormValue();
  if (!payload.name || !payload.source_url) return toast("请填写任务名和公网 JSON 地址", "error");
  state.busy++;
  setBusy(button, true);
  try {
    const result = await api("api/automations", { method: "POST", json: payload, timeout: 15000 });
    setAutomationForm(result.automation);
    toast(`${result.automation.name} 已保存`);
    await refreshAutomations();
  } catch (error) { toast(`保存失败：${error.message}`, "error"); }
  finally {
    setBusy(button, false);
    if ($("#automation-id").value) $("#automation-save span").textContent = "更新自动化";
    state.busy--;
  }
});

$("#automation-reset").addEventListener("click", () => { setAutomationForm(); toast("已切换到新建任务"); });
$("#refresh-automations").addEventListener("click", refreshAutomations);

[
  "#custom-text", "#custom-color", "#custom-background", "#custom-progress",
  "#custom-progress-color", "#custom-progress-background", "#custom-icon",
  "#custom-push-icon", "#custom-scroll-speed", "#custom-rainbow", "#custom-no-scroll",
].map(selector => $(selector)).forEach(input => {
  input.addEventListener("input", syncCustomJson);
  input.addEventListener("change", syncCustomJson);
});
$("#refresh-history").addEventListener("click", refreshHistory);
$("#device-app-search").addEventListener("input", renderDeviceApps);
$("#clear-device-app-search").addEventListener("click", () => { $("#device-app-search").value = ""; renderDeviceApps(); $("#device-app-search").focus(); });
$("#refresh-device-apps").addEventListener("click", () => refreshDeviceApps(false));
$$("[data-app-filter]").forEach(button => button.addEventListener("click", () => {
  state.deviceAppFilter = button.dataset.appFilter;
  $$("[data-app-filter]").forEach(node => node.classList.toggle("active", node === button));
  renderDeviceApps();
}));
$("#close-app-settings").addEventListener("click", closeAppSettings);
$("#app-settings-backdrop").addEventListener("click", closeAppSettings);
document.addEventListener("keydown", event => { if (event.key === "Escape" && $("#app-settings-drawer").classList.contains("open")) closeAppSettings(); });
$("#drawer-show-app").addEventListener("click", async event => {
  if (!state.selectedDeviceApp) return;
  await switchApplication(state.selectedDeviceApp.name, event.currentTarget);
  await refreshDeviceApps(true);
});
$("#drawer-app-enabled").addEventListener("change", event => {
  if (state.selectedDeviceApp) toggleDeviceApp(state.selectedDeviceApp, event.currentTarget.checked, event.currentTarget);
});
$("#app-settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  const app = state.selectedDeviceApp;
  if (!app) return;
  const button = $("#save-app-settings");
  const payload = {};
  $$("[data-setting] input", event.currentTarget).forEach(input => {
    if (input.type === "password" && !input.value) return;
    if (input.type === "checkbox") payload[input.name] = input.checked;
    else if (input.dataset.originalType === "number") payload[input.name] = Number(input.value);
    else payload[input.name] = input.value;
  });
  setBusy(button, true);
  try {
    await api(`api/apps/settings?name=${encodeURIComponent(app.name)}`, { method: "POST", json: payload, timeout: 18000 });
    toast(`${app.label} 设置已保存并生效`);
    await openAppSettings(state.deviceApps.find(item => item.name === app.name) || app);
  } catch (error) { toast(`保存失败：${error.message}`, "error"); }
  finally { setBusy(button, false); }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) Promise.all([refreshStats(true), refreshScreen()]);
});

// --- GIF Player ---

async function refreshGifs() {
  try {
    state.gifs = await api("api/gifs") || [];
    renderGifs();
  } catch (error) { toast(`读取 GIF 列表失败：${error.message}`, "error"); }
}

function drawGifThumbnail(canvas, pixels) {
  const ctx = canvas.getContext("2d");
  const cellW = canvas.width / 32, cellH = canvas.height / 8;
  ctx.fillStyle = "#040504";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 32; x++) {
      const value = Number(pixels[y * 32 + x] || 0);
      if (value === 0 || value === 0x050604) continue;
      ctx.fillStyle = colorHex(value);
      ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
    }
  }
}

async function gifCard(gif) {
  const card = document.createElement("div");
  card.className = "gif-card";
  card.dataset.name = gif.name;
  const thumb = document.createElement("canvas");
  thumb.className = "gif-thumb";
  thumb.width = 192; thumb.height = 48;
  card.append(thumb);
  try {
    const preview = await api(`api/gif/preview?name=${encodeURIComponent(gif.name)}`, { timeout: 4000 });
    drawGifThumbnail(thumb, preview.pixels);
  } catch { /* leave blank */ }
  const info = document.createElement("div");
  info.className = "gif-info";
  info.append(
    Object.assign(document.createElement("strong"), { textContent: gif.name }),
    Object.assign(document.createElement("small"), { textContent: `${gif.frames} 帧 · ${gif.delay}ms · ${gif.loop === 0 ? "无限循环" : gif.loop + " 次"}` })
  );
  card.append(info);
  const actions = document.createElement("div");
  actions.className = "gif-actions";
  const play = document.createElement("button");
  play.type = "button"; play.textContent = "▶ 播放";
  play.addEventListener("click", async () => {
    try {
      await api("api/gif/play", { method: "POST", json: { name: gif.name } });
      toast(`正在播放 ${gif.name}`);
      await Promise.all([refreshStats(true), refreshScreen()]);
    } catch (error) { toast(`播放失败：${error.message}`, "error"); }
  });
  const remove = document.createElement("button");
  remove.type = "button"; remove.className = "danger"; remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    try {
      await api(`api/gif?name=${encodeURIComponent(gif.name)}`, { method: "DELETE" });
      toast(`已删除 ${gif.name}`);
      await refreshGifs();
    } catch (error) { toast(`删除失败：${error.message}`, "error"); }
  });
  actions.append(play, remove);
  card.append(actions);
  return card;
}

async function renderGifs() {
  const grid = $("#gif-list");
  if (!grid) return;
  grid.replaceChildren();
  if (!state.gifs?.length) {
    grid.append(Object.assign(document.createElement("p"), { className: "empty-state", textContent: "还没有保存的 GIF，上传一个试试" }));
    return;
  }
  for (const gif of state.gifs) grid.append(await gifCard(gif));
}

function handleGifFile(file) {
  if (!file.type.includes("gif") && !file.name.toLowerCase().endsWith(".gif")) return toast("请选择 GIF 格式文件", "error");
  if (file.size > 5 * 1024 * 1024) return toast("文件超过 5 MB", "error");
  const nameInput = $("#gif-name");
  if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.gif$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const zone = $("#gif-drop-zone");
  $(".gif-drop-content strong", zone).textContent = file.name;
  $(".gif-drop-content small", zone).textContent = `${(file.size / 1024).toFixed(1)} KB · 点击重新选择`;
  state.pendingGifFile = file;
}

const gifDropZone = $("#gif-drop-zone");
const gifFileInput = $("#gif-file");
if (gifDropZone && gifFileInput) {
  gifDropZone.addEventListener("click", () => gifFileInput.click());
  gifDropZone.addEventListener("dragover", e => { e.preventDefault(); gifDropZone.classList.add("dragover"); });
  gifDropZone.addEventListener("dragleave", () => gifDropZone.classList.remove("dragover"));
  gifDropZone.addEventListener("drop", e => {
    e.preventDefault();
    gifDropZone.classList.remove("dragover");
    const file = e.dataTransfer.files?.[0];
    if (file) handleGifFile(file);
  });
  gifFileInput.addEventListener("change", () => { if (gifFileInput.files?.[0]) handleGifFile(gifFileInput.files[0]); });
}

$("#gif-upload-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const file = state.pendingGifFile;
  const name = $("#gif-name").value.trim();
  if (!file) return toast("请先选择 GIF 文件", "error");
  if (!name) return toast("请输入名称", "error");
  const button = $("#gif-upload-btn");
  state.busy++;
  setBusy(button, true);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await api("api/gif", { method: "POST", json: { name, data: dataUrl.split(",")[1], loop: Number($("#gif-loop").value) || 0, resize: $("#gif-resize").value }, timeout: 30000 });
    toast(`已保存 ${result.name}（${result.frames} 帧）`);
    state.pendingGifFile = null;
    gifFileInput.value = "";
    $("#gif-name").value = "";
    $(".gif-drop-content strong", gifDropZone).textContent = "拖拽 GIF 到此处";
    $(".gif-drop-content small", gifDropZone).textContent = "或点击选择文件 · 最大 5 MB · 自动缩放为 32×8";
    await refreshGifs();
  } catch (error) { toast(`上传失败：${error.message}`, "error"); }
  finally { setBusy(button, false); state.busy--; }
});

$("#refresh-gifs")?.addEventListener("click", refreshGifs);
$("#play-all-gifs")?.addEventListener("click", async () => {
  try {
    const result = await api("api/gif/play-all", { method: "POST", json: {} });
    toast(`正在循环播放 ${result.count} 个 GIF`);
    await Promise.all([refreshStats(true), refreshScreen()]);
  } catch (error) { toast(`循环播放失败：${error.message}`, "error"); }
});
$("#stop-gifs")?.addEventListener("click", async () => {
  try {
    await api("api/gif/stop", { method: "POST", json: {} });
    toast("已停止 GIF 循环播放");
    await Promise.all([refreshStats(true), refreshScreen()]);
  } catch (error) { toast(`停止失败：${error.message}`, "error"); }
});
$("#refresh-health")?.addEventListener("click", () => refreshHealth(false));

drawPixels([]);
Promise.all([refreshStats(true), refreshScreen(), refreshLoop(), refreshHistory(), refreshCustomApps(), refreshAutomations(), refreshDeviceApps(true), refreshGifs(), refreshHealth(true)]);
state.previewTimer = setInterval(refreshScreen, 1200);
state.statsTimer = setInterval(() => refreshStats(true), 12000);
state.automationTimer = setInterval(() => { if (!document.hidden) refreshAutomations(); }, 5000);
state.healthTimer = setInterval(() => { if (!document.hidden && !$("#tab-health")?.hidden) refreshHealth(true); }, 15000);
