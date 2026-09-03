(function () {
  "use strict";

  function installStyles() {
    if (document.getElementById("awtrix-next-host-styles")) return;
    var style = document.createElement("style");
    style.id = "awtrix-next-host-styles";
    style.textContent = [
      ".awtrix-next-nav>a{background:linear-gradient(90deg,rgba(255,176,0,.16),transparent)!important;border-left:3px solid #ffb000!important}",
      ".awtrix-next-nav .next-pixel-icon{display:inline-grid!important;grid-template-columns:repeat(3,4px);gap:2px;width:22px;margin:0 8px 0 2px;vertical-align:middle}",
      ".awtrix-next-nav .next-pixel-icon i{width:4px;height:4px;background:#ffb000;box-shadow:0 0 6px rgba(255,176,0,.8)}",
      ".awtrix-next-nav .next-badge{float:right;margin:13px 12px 0 0;padding:2px 6px;border:1px solid rgba(255,176,0,.5);color:#ffb000;font:700 9px/1 monospace;letter-spacing:.08em}",
      ".awtrix-next-host{height:calc(100vh - 70px);min-height:620px;margin:-15px;padding:0;background:#0d100d;overflow:hidden}",
      ".awtrix-next-hostbar{height:48px;display:flex;align-items:center;gap:12px;padding:0 18px;background:#121610;border-bottom:1px solid #2b3328;color:#dce5d7;font-family:monospace}",
      ".awtrix-next-hostbar b{color:#ffb000;letter-spacing:.12em}.awtrix-next-hostbar small{color:#869080}.awtrix-next-hostbar i{width:7px;height:7px;border-radius:50%;background:#4dde83;box-shadow:0 0 10px #4dde83}",
      ".awtrix-next-hostbar button{margin-left:auto;border:1px solid #3a4337;background:#1b2119;color:#cbd4c6;padding:6px 11px;cursor:pointer}",
      ".awtrix-next-frame{display:block;width:100%;height:calc(100% - 48px);border:0;background:#10120f}",
      "body.awtrix-next-open section.content{padding:0!important}",
      "@media(max-width:767px){.awtrix-next-host{height:calc(100vh - 70px);min-height:520px;margin:0}.awtrix-next-hostbar small{display:none}}"
    ].join("");
    document.head.appendChild(style);
  }

  function pixelIcon() {
    var dots = "";
    for (var i = 0; i < 9; i += 1) dots += "<i></i>";
    return '<span class="next-pixel-icon" aria-hidden="true">' + dots + "</span>";
  }

  function openNext(updateHistory) {
    var content = document.querySelector("section.content");
    if (!content) {
      window.location.href = "/awtrix-next/";
      return;
    }
    installStyles();
    document.body.classList.add("awtrix-next-open");
    var title = document.getElementById("title");
    if (title) title.textContent = "AWTRIX · NEXT";
    content.innerHTML = [
      '<div class="awtrix-next-host">',
      '<div class="awtrix-next-hostbar"><i></i><b>NEXT CONTROL CENTER</b><small>全部扩展功能已集成到 AWTRIX Host</small>',
      '<button type="button" id="awtrix-next-popout">独立窗口 ↗</button></div>',
      '<iframe class="awtrix-next-frame" title="AWTRIX2 NEXT 控制台" src="/awtrix-next/" allow="clipboard-read; clipboard-write" loading="eager"></iframe>',
      "</div>"
    ].join("");
    var popout = document.getElementById("awtrix-next-popout");
    if (popout) popout.onclick = function () { window.open("/awtrix-next/", "_blank", "noopener"); };
    document.querySelectorAll("#leftsidebar li").forEach(function (item) { item.classList.remove("active"); });
    var nav = document.querySelector(".awtrix-next-nav");
    if (nav) nav.classList.add("active");
    if (updateHistory && location.pathname !== "/pages/next.html") history.pushState({ awtrixNext: true }, "", "/pages/next.html");
  }

  function installNavigation() {
    var list = document.querySelector("#leftsidebar .menu ul.list");
    if (!list || document.querySelector(".awtrix-next-nav")) return;
    var item = document.createElement("li");
    item.className = "awtrix-next-nav";
    item.innerHTML = '<a href="/pages/next.html">' + pixelIcon() + '<span>AWTRIX Next</span><em class="next-badge">NEW</em></a>';
    var dashboard = list.querySelector("li:not(.header)");
    if (dashboard && dashboard.nextSibling) list.insertBefore(item, dashboard.nextSibling);
    else list.appendChild(item);
    item.querySelector("a").addEventListener("click", function (event) {
      event.preventDefault();
      openNext(true);
      var overlay = document.querySelector(".overlay");
      if (overlay) overlay.click();
    });
  }

  function removeLegacyNavigation() {
    var list = document.querySelector("#leftsidebar .menu ul.list");
    if (!list) return;
    var removedLabels = ["About", "Policies", "Support AWTRIX", "Links"];
    Array.prototype.slice.call(list.children).forEach(function (item) {
      if (!item || item.tagName !== "LI") return;
      var link = item.querySelector("a");
      if (!link) return;
      var label = (link.textContent || "").replace(/\s+/g, " ").trim();
      if (removedLabels.indexOf(label) !== -1) item.remove();
    });
  }

  function boot() {
    removeLegacyNavigation();
    installNavigation();
    if (location.pathname === "/pages/next.html") openNext(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  window.addEventListener("popstate", function () {
    if (location.pathname === "/pages/next.html") openNext(false);
    else location.reload();
  });
}());
