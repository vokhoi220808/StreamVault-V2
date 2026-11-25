// MAIN world: mọi việc phân tích diễn ra ở đây.
// - Hook fetch/XHR để bắt phản hồi GraphQL (feed, group, reels...)
// - Quét JSON nhúng trong DOM
// - Nhận lệnh "rescan" từ content.js
// Kết quả được gửi sang content.js (ISOLATED world) bằng window.postMessage.
(function () {
  if (window.__FBVD_INJECTED__) return;
  window.__FBVD_INJECTED__ = true;

  const P = window.__FBVD_PARSER__;
  if (!P) return;
  const host = location.hostname;
  const isTT = /(^|\.)tiktok\.com$/i.test(host);
  const isDY = /(^|\.)douyin\.com$/i.test(host);
  const isIG = /(^|\.)instagram\.com$/i.test(host);
  const isTH = /(^|\.)threads\.(net|com)$/i.test(host);
  const isX = /(^|\.)(x|twitter)\.com$/i.test(host);
  const isXHS = /(^|\.)xiaohongshu\.com$/i.test(host);
  const WATCH = isTT
    ? /\/api\/(?:recommend|post|item|search|challenge|music|favorite|explore|related|following|user|repost)\/|\/tiktok\/v1\//
    : isDY
    ? /\/aweme\/v1\/web\//
    : isX
    ? /\/i\/api\/(?:graphql|1\.1|2)\//
    : isXHS
    ? /\/api\/sns\/web\//
    : isIG || isTH
    ? /graphql|\/api\/v1\/(?:feed|clips|media|text_feed|users|discover|stories|highlights)\//
    : /graphql|\/ajax\//;
  const origFetch = window.fetch;

  function post(found) {
    const list = Object.values(found || {});
    if (list.length) window.postMessage({ __fbvd: true, videos: list }, "*");
  }

  function handle(data) {
    setTimeout(() => {
      try {
        post(typeof data === "string" ? P.parseText(data) : P.parseObj(data));
      } catch (e) {}
    }, 0);
  }

  function scanDom() {
    try {
      const out = {};
      document.querySelectorAll('script[type="application/json"],script#SIGI_STATE').forEach((s) => {
        P.parseText(s.textContent, out);
      });
      if (isXHS) {
        if (window.__INITIAL_STATE__) P.parseObj(window.__INITIAL_STATE__, out);
        document.querySelectorAll("script").forEach((s) => {
          if (s.textContent && s.textContent.indexOf("__INITIAL_STATE__") !== -1) P.parseHtml(s.textContent, out);
        });
      }
      post(out);
    } catch (e) {}
  }

  async function rescan() {
    scanDom();
    try {
      const res = await origFetch.call(window, location.href, { credentials: "include" });
      post(P.parseHtml(await res.text()));
    } catch (e) {}
  }

  // Hook fetch
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || String(input || "");
      if (WATCH.test(url)) {
        p.then((res) => {
          const ct = (res.headers && res.headers.get("content-type")) || "";
          if (/json|text|javascript/i.test(ct) || !ct) {
            res.clone().text().then(handle).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  // Hook XMLHttpRequest (bỏ qua dữ liệu nhị phân blob/arraybuffer để không ảnh hưởng trình phát)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fbvdUrl = String(url || "");
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (WATCH.test(this.__fbvdUrl || "")) {
      this.addEventListener("load", function () {
        try {
          if (this.responseType === "" || this.responseType === "text") handle(this.responseText);
          else if (this.responseType === "json" && this.response) handle(this.response);
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // Lệnh từ content.js
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__fbvdCmd !== "rescan") return;
    const id = e.data.id;
    rescan().finally(() => window.postMessage({ __fbvdDone: id }, "*"));
  });

  // Trên TikTok & Douyin, chỉ hook JSON API (quét DOM xử lý nhẹ ở content.js)
  if (!isTT && !isDY) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scanDom);
    else scanDom();
    window.addEventListener("load", () => setTimeout(scanDom, 1500));
  }
})();
