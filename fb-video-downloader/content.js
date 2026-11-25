// ISOLATED world: lưu danh sách video, trả lời popup và gắn nút tải nổi lên video trên trang.
(function () {
  const videos = {};
  let seq = 0;

  function merge(v) {
    const old = videos[v.id];
    if (!old) {
      v._seq = ++seq;
      videos[v.id] = v;
      return true;
    }
    let changed = false;
    for (const k of Object.keys(v)) {
      if (k === "dashVideo" || k === "dashAudio") {
        if (v[k] && (!old[k] || (v[k].bandwidth || 0) >= (old[k].bandwidth || 0))) {
          old[k] = v[k];
          changed = true;
        }
      } else if (v[k] && (k === "hd" || k === "sd" ? old[k] !== v[k] : !old[k])) {
        old[k] = v[k];
        changed = true;
      }
    }
    return changed;
  }

  let autoScrollTimer = null;
  let autoScrollState = { maxNew: 0, stopOnDup: false, autoDownload: false, freshCount: 0, dupStreak: 0, steps: 0, completedSet: null, enqueuedSet: null };
  let staleRounds = 0;
  let lastScrollH = 0;

  function maybeAutoEnqueue(id) {
    if (!autoScrollTimer || !autoScrollState.autoDownload || !autoScrollState.enqueuedSet) return;
    if (autoScrollState.maxNew > 0 && autoScrollState.enqueuedSet.size >= autoScrollState.maxNew) return;
    if (autoScrollState.enqueuedSet.has(id)) return;
    if (autoScrollState.completedSet && autoScrollState.completedSet.has(String(id))) return;
    const v = videos[id];
    if (!v || !(v.hd || v.sd || (v.dashVideo && v.dashAudio) || (v.images && v.images.length))) return;
    autoScrollState.enqueuedSet.add(id);
    try {
      const p = chrome.runtime.sendMessage({ type: "autoEnqueueVideo", video: v, url: location.href });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  let syncTimer = null;
  function add(list) {
    let changed = false;
    for (const v of list) {
      if (!v || !v.id) continue;
      if (!v.sourceUrl) v.sourceUrl = location.href;
      const isNewToTab = !videos[v.id];
      if (merge(v)) changed = true;
      if (isNewToTab && autoScrollTimer) {
        if (autoScrollState.completedSet && autoScrollState.completedSet.has(String(v.id))) {
          autoScrollState.dupStreak++;
        } else {
          autoScrollState.dupStreak = 0;
          autoScrollState.freshCount++;
        }
      }
      maybeAutoEnqueue(v.id);
    }
    if (changed) {
      try {
        const p = chrome.runtime.sendMessage({ type: "count", count: Object.keys(videos).length });
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        try {
          const p2 = chrome.runtime.sendMessage({
            type: "syncVideos",
            videos: Object.values(videos),
            url: location.href,
          });
          if (p2 && p2.catch) p2.catch(() => {});
        } catch (e) {}
      }, 650);
    }
  }

  const waiting = {};
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__fbvd) add(e.data.videos || []);
    if (e.data.__fbvdDone && waiting[e.data.__fbvdDone]) {
      waiting[e.data.__fbvdDone]();
      delete waiting[e.data.__fbvdDone];
    }
  });

  const host = location.hostname;
  const isTikTok = /(^|\.)tiktok\.com$/i.test(host);
  const isDouyin = /(^|\.)douyin\.com$/i.test(host);
  const isByteDance = isTikTok || isDouyin;
  const isIG = /(^|\.)instagram\.com$/i.test(host);
  const isThreads = /(^|\.)threads\.(net|com)$/i.test(host);
  const isX = /(^|\.)(x|twitter)\.com$/i.test(host);
  const isXHS = /(^|\.)xiaohongshu\.com$/i.test(host);
  const pagePlatform = isX
    ? "x"
    : isXHS
    ? "xiaohongshu"
    : isDouyin
    ? "douyin"
    : isTikTok
    ? "tiktok"
    : isThreads
    ? "threads"
    : isIG
    ? "instagram"
    : "facebook";

  function extractTikTokJson(root) {
    const out = [];
    const stack = [root];
    let guard = 0;
    const pickUrl = (u) => {
      if (typeof u === "string" && u.startsWith("http")) return u;
      const arr = u && (u.UrlList || u.url_list || u.urlList);
      return Array.isArray(arr) ? arr.find((x) => typeof x === "string" && x.startsWith("http")) || "" : "";
    };
    while (stack.length && guard++ < 50000) {
      const n = stack.pop();
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) stack.push(n[i]);
        continue;
      }
      const tv = n.video;
      const ip = n.imagePost;
      const dyImages = Array.isArray(n.images) && n.images.length && n.aweme_id ? n.images : null;
      if (
        (tv && typeof tv === "object" && (tv.playAddr || tv.downloadAddr || tv.bitrateInfo || tv.bit_rate || tv.play_addr)) ||
        (ip && Array.isArray(ip.images) && ip.images.length > 0) ||
        dyImages
      ) {
        let bestUrl = "";
        let bestBr = -1;
        let bestH = 0;
        const brList = (tv && (tv.bitrateInfo || tv.bit_rate)) || [];
        if (Array.isArray(brList)) {
          for (const bi of brList) {
            const pa = bi && (bi.PlayAddr || bi.play_addr);
            const u = pickUrl(pa);
            const br = (bi && (bi.Bitrate || bi.bitrate || bi.bit_rate)) || 0;
            const h = (pa && (pa.Height || pa.height)) || 0;
            if (u && br > bestBr) {
              bestBr = br;
              bestUrl = u;
              bestH = h;
            }
          }
        }
        const play = tv ? bestUrl || pickUrl(tv.playAddr || tv.play_addr) : "";
        const dl = tv ? pickUrl(tv.downloadAddr || tv.download_addr) : "";
        const images =
          ip && Array.isArray(ip.images)
            ? ip.images.map((im) => pickUrl(im && (im.imageURL || im.displayImage))).filter(Boolean)
            : dyImages
            ? dyImages.map((im) => pickUrl(im)).filter(Boolean)
            : [];
        const musicUrl = n.music ? pickUrl(n.music.playUrl || n.music.play_url) : "";
        const musicTitle = (n.music && typeof n.music.title === "string" && n.music.title) || "";
        const sample = play || dl || images[0] || musicUrl;
        if (sample) {
          out.push({
            id: /^\d+$/.test(String(n.id || n.aweme_id || "")) ? String(n.id || n.aweme_id) : "bd" + out.length,
            platform: isDouyin ? "douyin" : "tiktok",
            hd: play || dl,
            hdHeight: (tv && (tv.height || (tv.play_addr && tv.play_addr.height))) || bestH || 0,
            sd: dl && dl !== play ? dl : "",
            images: images.length ? images : undefined,
            musicUrl: musicUrl || undefined,
            musicTitle: musicTitle || undefined,
            title: (typeof n.desc === "string" && n.desc) || musicTitle || "",
            thumb: images[0] || (tv && pickUrl(tv.cover || tv.originCover || tv.dynamicCover)) || "",
            owner: (n.author && (n.author.nickname || n.author.uniqueId || n.author.unique_id)) || "",
            duration: tv && tv.duration ? (tv.duration > 1000 ? tv.duration : tv.duration * 1000) : 0,
          });
        }
      }
      for (const k in n) {
        if (n[k] && typeof n[k] === "object") stack.push(n[k]);
      }
    }
    add(out);
  }

  let ttDomScanned = false;
  function scanTikTokDom(force) {
    if (ttDomScanned && !force) return;
    ttDomScanned = true;
    document
      .querySelectorAll('script#__UNIVERSAL_DATA_FOR_REHYDRATION__,script#SIGI_STATE,script#RENDER_DATA')
      .forEach((s) => {
        try {
          const raw = s.id === "RENDER_DATA" ? decodeURIComponent(s.textContent) : s.textContent;
          extractTikTokJson(JSON.parse(raw));
        } catch (e) {}
      });
  }

  function rescan() {
    if (isByteDance) {
      scanTikTokDom(true);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const id = "r" + Date.now() + Math.random().toString(36).slice(2);
      waiting[id] = resolve;
      setTimeout(() => {
        if (waiting[id]) {
          delete waiting[id];
          resolve();
        }
      }, 10000);
      window.postMessage({ __fbvdCmd: "rescan", id }, "*");
    });
  }

  function getActiveId() {
    try {
      const el = pickVisibleVideo();
      if (el) {
        const res = findVideoForEl(el);
        if (res && res.id) {
          if (videos[res.id] && !el.paused) videos[res.id]._playedAt = Date.now();
          return res.id;
        }
      }
    } catch (e) {}
    return lastPlayedId || null;
  }

  function stopAutoScroll() {
    if (autoScrollTimer) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = null;
    }
    const pill = document.getElementById("fbvd-scroll-pill");
    if (pill) pill.remove();
  }

  function findScrollBox() {
    const v = pickVisibleVideo();
    let cur = v && v.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if ((st.overflowY === "auto" || st.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 60) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  async function startAutoScroll(opts) {
    if (autoScrollTimer) return;
    ensureBtn();
    staleRounds = 0;
    let lastCount = Object.keys(videos).length;
    lastScrollH = document.documentElement.scrollHeight;
    let intervalMs = 1300;
    let maxNew = (opts && Number(opts.maxNew)) || 0;
    let stopOnDup = !!(opts && opts.stopOnDup);
    let autoDownload = !!(opts && opts.autoDownload);
    let completedSet = new Set();
    try {
      const r = await chrome.storage.local.get(["settings", "sv_jobs", "sv_archived_ids"]);
      const st = (r && r.settings) || {};
      if (st.autoScrollIntervalMs) {
        intervalMs = Math.max(700, Math.min(4000, Number(st.autoScrollIntervalMs) || 1300));
      }
      if (!opts || opts.maxNew === undefined) maxNew = Math.max(0, Number(st.autoScrollLimit) || 0);
      if (!opts || opts.stopOnDup === undefined) stopOnDup = !!st.autoScrollStopOnDup;
      if (!opts || opts.autoDownload === undefined) autoDownload = !!st.autoScrollAutoDownload;
      for (const aid of (r && r.sv_archived_ids) || []) {
        if (aid) completedSet.add(String(aid));
      }
      for (const j of (r && r.sv_jobs) || []) {
        if (j && j.status === "completed" && j.videoId) completedSet.add(String(j.videoId));
      }
    } catch (e) {}

    autoScrollState = {
      maxNew,
      stopOnDup,
      autoDownload,
      freshCount: 0,
      dupStreak: 0,
      steps: 0,
      completedSet: stopOnDup || autoDownload ? completedSet : null,
      enqueuedSet: autoDownload ? new Set() : null,
    };

    let pill = document.getElementById("fbvd-scroll-pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "fbvd-scroll-pill";
      pill.innerHTML = `<span id="fbvd-scroll-txt">⟳ Đang tự cuộn gom video...</span><button type="button">Dừng</button>`;
      pill.querySelector("button").onclick = () => {
        stopAutoScroll();
        showToast("⏹ Đã dừng tự cuộn.");
      };
      document.documentElement.appendChild(pill);
    }

    autoScrollTimer = setInterval(() => {
      autoScrollState.steps++;
      const box = findScrollBox();
      if (box) {
        box.scrollBy({ top: Math.round(box.clientHeight * 0.85), behavior: "smooth" });
      } else if (isByteDance && document.documentElement.scrollHeight <= innerHeight + 120) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
      } else {
        window.scrollBy({ top: Math.round(innerHeight * 0.85), behavior: "smooth" });
      }
      const count = Object.keys(videos).length;
      const txt = document.getElementById("fbvd-scroll-txt");
      if (txt) {
        const prefix = autoScrollState.autoDownload ? `Gom & tải ${autoScrollState.enqueuedSet ? autoScrollState.enqueuedSet.size : 0}` : "Tự cuộn";
        const targetStr = autoScrollState.maxNew > 0 ? `${autoScrollState.freshCount}/${autoScrollState.maxNew} mới` : `${count} video`;
        txt.textContent = `⟳ ${prefix} (${targetStr})...`;
      }

      if (autoScrollState.maxNew > 0 && autoScrollState.freshCount >= autoScrollState.maxNew) {
        stopAutoScroll();
        showToast(`✅ Đã gom đủ ${autoScrollState.freshCount} video mới (tổng ${count}).`);
        return;
      }
      if (autoScrollState.stopOnDup && autoScrollState.steps >= 2 && autoScrollState.dupStreak >= 3) {
        stopAutoScroll();
        showToast(`⏹ Gặp chuỗi video đã tải trước đó, đã dừng cuộn.`);
        return;
      }

      const h = box ? box.scrollHeight : document.documentElement.scrollHeight;
      if (h === lastScrollH && count === lastCount) {
        if (++staleRounds >= 6) {
          stopAutoScroll();
          showToast(`✅ Đã cuộn hết (${count} video).`);
        }
      } else {
        lastScrollH = h;
        lastCount = count;
        staleRounds = 0;
      }
    }, intervalMs);
  }

  async function captureActiveTikTok(syncOnly) {
    if (!isByteDance) return;
    const el = pickVisibleVideo();
    if (!el) return;
    let cur = el;
    let box = null;
    let id = null;
    for (let i = 0; i < 14 && cur; i++) {
      if (!id && cur.id) {
        const m = cur.id.match(/(\d{15,22})/);
        if (m) id = m[1];
      }
      if (
        !box &&
        cur.getAttribute &&
        (cur.getAttribute("data-e2e") === "recommend-list-item-container" ||
          cur.getAttribute("data-e2e") === "detail-video" ||
          cur.getAttribute("role") === "article")
      ) {
        box = cur;
      }
      if (!id && cur.querySelectorAll) {
        for (const a of cur.querySelectorAll('a[href*="/video/"]')) {
          const m = (a.getAttribute("href") || "").match(/\/video\/(\d+)/);
          if (m) {
            id = m[1];
            break;
          }
        }
      }
      cur = cur.parentElement;
    }
    if (!id) id = extractId(location.href);
    const scope = box || el.parentElement?.parentElement?.parentElement || document;
    const titleEl = scope.querySelector('[data-e2e="video-desc"],[data-e2e="browse-video-desc"]');
    const ownerEl = scope.querySelector('[data-e2e="video-author-uniqueid"],[data-e2e="browse-username"],a[href^="/@"]');
    const imgEl = scope.querySelector('img[src*="tiktokcdn"],img[src*="ibytedtos"]');
    const title = (titleEl && titleEl.innerText ? titleEl.innerText : el.getAttribute("aria-label") || "").trim();
    const owner = (ownerEl && ownerEl.innerText ? ownerEl.innerText : "").replace(/^@/, "").trim();
    const thumb = el.poster || (imgEl && imgEl.src) || "";

    let hd = /^https?:\/\//.test(el.currentSrc || "") ? el.currentSrc : "";
    if (!hd && !syncOnly) {
      const st = await sendBg({ type: "getStreams" });
      const tt = ((st && st.streams) || []).find((s) => s.muxed && s.url);
      if (tt) hd = tt.url;
    }
    if (!hd) return id;
    const vid = id || (isDouyin ? "dy_" : "tt_") + hd.slice(-24).replace(/\W/g, "");
    if (!videos[vid] || !videos[vid].hd) {
      add([
        {
          id: vid,
          platform: pagePlatform,
          hd,
          title,
          owner,
          thumb,
          duration: el.duration && isFinite(el.duration) ? el.duration * 1000 : 0,
        },
      ]);
    }
    return vid;
  }

  if (isByteDance) setTimeout(() => scanTikTokDom(false), 300);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getVideos") {
      if (isByteDance) {
        scanTikTokDom(false);
        const fastId = captureActiveTikTokSync();
        sendResponse({
          videos: Object.values(videos),
          url: location.href,
          activeId: fastId || getActiveId(),
          autoScrolling: !!autoScrollTimer,
        });
        return;
      }
      sendResponse({ videos: Object.values(videos), url: location.href, activeId: getActiveId(), autoScrolling: !!autoScrollTimer });
    } else if (msg.type === "rescan") {
      rescan()
        .then(() => (isByteDance ? captureActiveTikTok(false) : null))
        .then((ttId) =>
          sendResponse({
            videos: Object.values(videos),
            url: location.href,
            activeId: ttId || getActiveId(),
            autoScrolling: !!autoScrollTimer,
          })
        );
      return true;
    } else if (msg.type === "clearVideos") {
      for (const k of Object.keys(videos)) delete videos[k];
      try {
        const p = chrome.runtime.sendMessage({ type: "count", count: 0 });
        if (p && p.catch) p.catch(() => {});
        const p2 = chrome.runtime.sendMessage({ type: "syncVideos", videos: [], url: location.href });
        if (p2 && p2.catch) p2.catch(() => {});
      } catch (e) {}
      sendResponse({ videos: [], url: location.href, activeId: null, autoScrolling: !!autoScrollTimer });
    } else if (msg.type === "toggleAutoScroll") {
      if (autoScrollTimer) {
        stopAutoScroll();
        sendResponse({ autoScrolling: false });
      } else {
        startAutoScroll(msg.options).then(() => sendResponse({ autoScrolling: !!autoScrollTimer }));
        return true;
      }
    } else if (msg.type === "downloadFocused") {
      const v = pickVisibleVideo();
      if (!v) showToast("Không tìm thấy video nào đang hiển thị.");
      else {
        showToast("⬇ Đang xử lý tải video...");
        downloadVideoEl(v, ensureBtn());
      }
      sendResponse({ ok: true });
    }
  });

  // --- Nút tải nổi trực tiếp trên video ---
  const ID_RE = /\/(?:videos?|reel|reels|status)\/(?:[^/]+\/)?(\d+)|\/(?:reel|reels|p|tv|post|explore)\/([A-Za-z0-9_-]{5,})|[?&](?:v|modal_id)=(\d+)/;
  const safeName = (s) =>
    (s || "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

  function extractId(url) {
    const m = (url || "").match(ID_RE);
    return m ? m[1] || m[2] || m[3] : null;
  }

  function lookupVideo(id) {
    if (!id) return null;
    if (videos[id]) return videos[id];
    return Object.values(videos).find((x) => x.code === id) || null;
  }

  function findVideoForEl(videoEl) {
    // 1) Tìm theo ID hoặc shortcode trong link quanh video, thuộc tính id hoặc URL trang
    let cur = videoEl;
    let article = null;
    let fallbackId = null;
    for (let i = 0; i < 14 && cur; i++) {
      if (!fallbackId && cur.id) {
        const m = cur.id.match(/(\d{15,22})/);
        if (m) {
          fallbackId = m[1];
          const found = lookupVideo(fallbackId);
          if (found) return { id: found.id, v: found };
        }
      }
      if (
        !article &&
        cur.getAttribute &&
        (cur.getAttribute("role") === "article" || cur.getAttribute("data-e2e") === "recommend-list-item-container")
      ) {
        article = cur;
      }
      if (cur.querySelectorAll) {
        const links = cur.querySelectorAll(
          'a[href*="/videos/"],a[href*="/video/"],a[href*="/reel/"],a[href*="/reels/"],a[href*="/p/"],a[href*="/post/"],a[href*="/status/"],a[href*="/explore/"],a[href*="?v="],a[href*="modal_id="]'
        );
        for (const a of links) {
          const id = extractId(a.getAttribute("href"));
          if (id) {
            if (!fallbackId) fallbackId = id;
            const found = lookupVideo(id);
            if (found) return { id: found.id, v: found };
          }
        }
      }
      cur = cur.parentElement;
    }
    const urlId = extractId(location.href);
    const urlFound = lookupVideo(urlId);
    if (urlFound) return { id: urlFound.id, v: urlFound };

    // 2) Khớp trực tiếp currentSrc / ảnh poster / tiêu đề / tác giả + thời lượng
    const list = Object.values(videos).filter((x) => x.hd || x.sd || (x.dashVideo && x.dashAudio) || (x.images && x.images.length));
    const curSrc = /^https?:\/\//.test(videoEl.currentSrc || "") ? videoEl.currentSrc : "";
    if (curSrc && list.length) {
      const hitSrc = list.find((v) => v.hd === curSrc || v.sd === curSrc || (v.dashVideo && v.dashVideo.url === curSrc));
      if (hitSrc) return { id: hitSrc.id, v: hitSrc };
    }

    const scopeBox = article || videoEl.parentElement?.parentElement?.parentElement;
    if (scopeBox && list.length) {
      const imgUrls = [videoEl.poster || ""].concat(
        Array.from(scopeBox.querySelectorAll ? scopeBox.querySelectorAll("img[src]") : []).map((im) => im.src || "")
      );
      const fileKey = (u) => {
        try {
          const p = new URL(u).pathname;
          return p.split("/").pop() || "";
        } catch (e) {
          return "";
        }
      };
      const domKeys = imgUrls.map(fileKey).filter((k) => k.length > 8);
      if (domKeys.length) {
        for (const v of list) {
          const tk = v.thumb ? fileKey(v.thumb) : "";
          if (tk && domKeys.includes(tk)) return { id: v.id, v };
        }
      }

      const text = (scopeBox.innerText || "").replace(/\s+/g, " ").trim();
      const elDurMs = videoEl.duration && isFinite(videoEl.duration) ? videoEl.duration * 1000 : 0;
      if (text) {
        for (const v of list) {
          const t = (v.title || "").replace(/\s+/g, " ").trim();
          if (t.length >= 6 && text.includes(t.slice(0, 26))) return { id: v.id, v };
        }
        if (elDurMs > 0) {
          for (const v of list) {
            if (v.owner && text.includes(v.owner) && v.duration && Math.abs(v.duration - elDurMs) < 2000) {
              return { id: v.id, v };
            }
          }
        }
      }
    }
    if (list.length === 1) return { id: list[0].id, v: list[0] };
    return { id: fallbackId || urlId, v: null };
  }

  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function downloadVideoEl(videoEl, btn) {
    const orig = btn.textContent;
    btn.textContent = "⏳ Đang tìm...";
    btn.disabled = true;
    try {
      let { id, v } = findVideoForEl(videoEl);
      if (!v) {
        await rescan();
        ({ id, v } = findVideoForEl(videoEl));
      }

      if (v) {
        const st = await chrome.storage.local.get("settings").catch(() => ({}));
        const s = (st && st.settings) || {};
        const preferSd = s.quality === "sd";
        const platform = v.platform || pagePlatform;
        const base = safeName(v.title) || `${platform}_${v.id}`;
        const pickUrl = preferSd ? v.sd || v.hd : v.hd || v.sd;
        const firstSub = (v.subtitles && v.subtitles[0] && v.subtitles[0].url) || "";
        if (pickUrl) {
          const tag = pickUrl === v.hd ? (v.hdHeight ? `${v.hdHeight}p` : "HD") : (v.sdHeight ? `${v.sdHeight}p` : "SD");
          await sendBg({
            type: "download",
            url: pickUrl,
            filename: `${base}_${tag}.mp4`,
            meta: { id: v.id, title: v.title, author: v.owner, platform, quality: tag, sourceUrl: v.sourceUrl || location.href, thumb: v.thumb, subtitleUrl: firstSub },
          });
          setBtnText(btn, "✓ Đang tải", tag);
          showToast(`⬇ Đang tải (${tag})...`);
          return;
        }
        if (v.dashVideo && v.dashAudio) {
          const q = v.dashVideo.height ? `${v.dashVideo.height}p` : "DASH";
          await sendBg({
            type: "openMerge",
            vUrl: v.dashVideo.url,
            vInitUrl: v.dashVideo.initUrl || "",
            vSegments: v.dashVideo.segments || null,
            aUrl: v.dashAudio.url,
            aInitUrl: v.dashAudio.initUrl || "",
            aSegments: v.dashAudio.segments || null,
            name: base,
            meta: { id: v.id, title: v.title, author: v.owner, platform, quality: q, sourceUrl: v.sourceUrl || location.href, thumb: v.thumb, subtitleUrl: firstSub },
          });
          setBtnText(btn, "✓ Đang ghép", q);
          showToast("🎬 Đang xử lý ghép DASH...");
          return;
        }
      }

      // Dự phòng 1: src trực tiếp trên thẻ <video> (thường gặp ở TikTok / Instagram / Douyin)
      const directSrc = videoEl.currentSrc || videoEl.src || "";
      if (/^https?:\/\//.test(directSrc)) {
        await sendBg({
          type: "download",
          url: directSrc,
          filename: `${pagePlatform}_${id || Date.now()}.mp4`,
          meta: { id: id || String(Date.now()), platform: pagePlatform, quality: "MP4", sourceUrl: location.href },
        });
        setBtnText(btn, "✓ Đang tải");
        showToast("⬇ Đang tải video...");
        return;
      }

      // Dự phòng: dùng luồng bắt từ mạng
      const st = await sendBg({ type: "getStreams" });
      const list = (st && st.streams) || [];
      const vids = list.filter((s) => s.type === "video");
      const auds = list.filter((s) => s.type === "audio");
      const sv = (id && vids.find((s) => s.videoId === id)) || vids[0];
      if (sv && sv.muxed) {
        await sendBg({
          type: "download",
          url: sv.url,
          filename: `${pagePlatform}_${sv.videoId || Date.now()}.mp4`,
          meta: { id: sv.videoId || String(Date.now()), platform: pagePlatform, quality: sv.quality || "MP4", sourceUrl: location.href },
        });
        setBtnText(btn, "✓ Đang tải", sv.quality);
        showToast("⬇ Đang tải video...");
        return;
      }
      const sa = (sv && sv.videoId && auds.find((s) => s.videoId === sv.videoId)) || auds[0];
      if (sv && sa) {
        await sendBg({
          type: "openMerge",
          vUrl: sv.url,
          aUrl: sa.url,
          name: `facebook_${sv.videoId || Date.now()}`,
          meta: { id: sv.videoId || String(Date.now()), platform: "facebook", quality: sv.quality || "DASH", sourceUrl: location.href },
        });
        setBtnText(btn, "✓ Đang ghép", sv.quality);
        showToast("🎬 Đang mở Merge Studio...");
        return;
      }

      setBtnText(btn, "Phát video trước");
      showToast("Hãy bấm phát video vài giây rồi thử lại.");
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        const badge = activeVideo ? getBadgeForVideo(activeVideo) : "";
        setBtnText(btn, "Tải", badge);
      }, 2200);
    }
  }

  function getBadgeForVideo(el) {
    try {
      const { v } = findVideoForEl(el);
      if (!v) return "";
      if (v.hdHeight) return v.hdHeight + "p";
      if (v.hd) return "HD";
      if (v.dashVideo && v.dashVideo.height) return v.dashVideo.height + "p";
      if (v.dashVideo) return "DASH";
      if (v.sd) return "SD";
    } catch (e) {}
    return "";
  }

  function setBtnText(btn, label, badge) {
    btn.innerHTML = "";
    const ic = document.createElement("span");
    ic.className = "sv-ov-ic";
    ic.textContent = "⬇";
    const tx = document.createElement("span");
    tx.textContent = label;
    btn.appendChild(ic);
    btn.appendChild(tx);
    if (badge) {
      const b = document.createElement("span");
      b.className = "sv-ov-q";
      b.textContent = badge;
      btn.appendChild(b);
    }
  }

  function mountRoot() {
    return document.fullscreenElement || document.documentElement;
  }

  function ensureBtn() {
    if (!document.getElementById("fbvd-style")) {
      const st = document.createElement("style");
      st.id = "fbvd-style";
      st.textContent = `
        #fbvd-float-btn {
          position: fixed; z-index: 2147483640; display: none;
          align-items: center; gap: 6px;
          background: rgba(11, 15, 23, 0.86); color: #F1F5F9;
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 999px; padding: 5px 11px;
          font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          cursor: pointer; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
          opacity: 0.88; transition: opacity .18s, transform .18s, border-color .18s;
          pointer-events: auto;
        }
        #fbvd-float-btn:hover { opacity: 1; transform: translateY(-1px); border-color: #3B82F6; }
        #fbvd-float-btn:disabled { opacity: 0.75; cursor: wait; }
        #fbvd-float-btn .sv-ov-ic { color: #3B82F6; font-weight: 700; }
        #fbvd-float-btn .sv-ov-q {
          background: rgba(59, 130, 246, 0.22); color: #93C5FD;
          border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 700;
        }
        #fbvd-toast {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483645;
          background: rgba(15, 23, 42, 0.94); color: #F1F5F9; padding: 9px 14px;
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 12px; font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          box-shadow: 0 8px 24px rgba(0,0,0,.45); opacity: 0; transition: opacity .2s;
          pointer-events: none;
        }
        #fbvd-scroll-pill {
          position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2147483645;
          display: flex; align-items: center; gap: 10px;
          background: rgba(15, 23, 42, 0.94); color: #F1F5F9;
          border: 1px solid rgba(59, 130, 246, 0.45);
          padding: 8px 14px; border-radius: 999px;
          font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          box-shadow: 0 8px 24px rgba(0,0,0,.45);
        }
        #fbvd-scroll-pill button {
          border: 0; border-radius: 999px; padding: 4px 10px; background: #EF4444; color: #fff;
          font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; cursor: pointer;
        }
      `;
      (document.head || document.documentElement).appendChild(st);
    }
    const root = mountRoot();
    let btn = document.getElementById("fbvd-float-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "fbvd-float-btn";
      btn.type = "button";
      setBtnText(btn, "Tải");
      btn.title = "StreamVault V2 — Tải video này (Alt+D)";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (activeVideo) downloadVideoEl(activeVideo, btn);
      });
      root.appendChild(btn);
    } else if (btn.parentElement !== root) {
      root.appendChild(btn);
    }
    return btn;
  }

  document.addEventListener("fullscreenchange", () => {
    const btn = document.getElementById("fbvd-float-btn");
    if (btn) mountRoot().appendChild(btn);
    const toast = document.getElementById("fbvd-toast");
    if (toast) mountRoot().appendChild(toast);
  });

  let activeVideo = null;
  let lastPlayingVideo = null;
  let lastPlayedId = null;
  let lastCheck = 0;
  let toastTimer = null;

  // Bắt sự kiện play ở capture phase để luôn biết chính xác video nào đang chạy
  document.addEventListener(
    "play",
    (e) => {
      const el = e.target;
      if (!el || el.tagName !== "VIDEO") return;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return;
      lastPlayingVideo = el;
      const found = findVideoForEl(el);
      if (found && found.id) {
        lastPlayedId = found.id;
        if (videos[found.id]) videos[found.id]._playedAt = Date.now();
      }
      if (isByteDance) {
        const fastId = captureActiveTikTokSync();
        if (fastId && videos[fastId]) {
          lastPlayedId = fastId;
          videos[fastId]._playedAt = Date.now();
        }
        setTimeout(() => {
          captureActiveTikTok(false).then((tid) => {
            if (tid && videos[tid]) {
              lastPlayedId = tid;
              videos[tid]._playedAt = Date.now();
            }
          });
        }, 450);
      }
    },
    true
  );

  function showToast(msg) {
    ensureBtn();
    const root = mountRoot();
    let t = document.getElementById("fbvd-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "fbvd-toast";
    }
    if (t.parentElement !== root) root.appendChild(t);
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = "0"), 2600);
  }

  function pickVisibleVideo() {
    let best = null;
    let bestScore = -1;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 120 || r.bottom < 0 || r.top > innerHeight) continue;
      const st = getComputedStyle(v);
      if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
      const vis = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      const isPlaying = !v.paused && !v.ended && v.readyState > 0;
      const score =
        vis +
        (isPlaying ? 100000 : 0) +
        (v === lastPlayingVideo ? 2000 : 0) +
        (v === activeVideo ? 500 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) return best;
    if (activeVideo && document.contains(activeVideo)) {
      const r = activeVideo.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) return activeVideo;
    }
    return null;
  }

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== "d") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
    const v = pickVisibleVideo();
    if (!v) {
      showToast("Không tìm thấy video nào đang hiển thị.");
      return;
    }
    e.preventDefault();
    const btn = ensureBtn();
    showToast("⬇ Đang xử lý tải video (Alt+D)...");
    downloadVideoEl(v, btn);
  });

  function placeForVideo(v, btn) {
    const r = v.getBoundingClientRect();
    if (r.width < 120 || r.height < 120 || r.bottom < 0 || r.top > innerHeight) {
      btn.style.display = "none";
      return;
    }
    if (!btn.disabled) setBtnText(btn, "Tải", getBadgeForVideo(v));
    btn.style.display = "inline-flex";
    btn.style.top = Math.max(8, r.top + 10) + "px";
    btn.style.left = Math.max(8, Math.min(innerWidth - btn.offsetWidth - 8, r.right - btn.offsetWidth - 10)) + "px";
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      const now = Date.now();
      if (now - lastCheck < 80) return;
      lastCheck = now;
      const btn = ensureBtn();
      if (e.target === btn || btn.contains(e.target)) return;

      let hit = null;
      for (const v of document.querySelectorAll("video")) {
        const r = v.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 120 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          hit = v;
          break;
        }
      }
      if (hit) {
        activeVideo = hit;
        placeForVideo(hit, btn);
      } else if (!btn.disabled) {
        btn.style.display = "none";
      }
    },
    { passive: true }
  );

  function captureActiveTikTokSync() {
    if (!isByteDance) return null;
    const el = pickVisibleVideo();
    if (!el) return null;
    let cur = el;
    let box = null;
    let id = null;
    for (let i = 0; i < 14 && cur; i++) {
      if (!id && cur.id) {
        const m = cur.id.match(/(\d{15,22})/);
        if (m) id = m[1];
      }
      if (
        !box &&
        cur.getAttribute &&
        (cur.getAttribute("data-e2e") === "recommend-list-item-container" ||
          cur.getAttribute("data-e2e") === "detail-video" ||
          cur.getAttribute("role") === "article")
      ) {
        box = cur;
      }
      if (!id && cur.querySelectorAll) {
        for (const a of cur.querySelectorAll('a[href*="/video/"]')) {
          const m = (a.getAttribute("href") || "").match(/\/video\/(\d+)/);
          if (m) {
            id = m[1];
            break;
          }
        }
      }
      cur = cur.parentElement;
    }
    if (!id) id = extractId(location.href);
    const scope = box || el.parentElement?.parentElement?.parentElement || document;
    const titleEl = scope.querySelector('[data-e2e="video-desc"],[data-e2e="browse-video-desc"]');
    const ownerEl = scope.querySelector('[data-e2e="video-author-uniqueid"],[data-e2e="browse-username"],a[href^="/@"]');
    const imgEl = scope.querySelector('img[src*="tiktokcdn"],img[src*="ibytedtos"]');
    const hd = /^https?:\/\//.test(el.currentSrc || "") ? el.currentSrc : "";
    if (hd) {
      const vid = id || (isDouyin ? "dy_" : "tt_") + hd.slice(-24).replace(/\W/g, "");
      if (!videos[vid] || !videos[vid].hd) {
        add([
          {
            id: vid,
            platform: pagePlatform,
            hd,
            title: (titleEl && titleEl.innerText ? titleEl.innerText : el.getAttribute("aria-label") || "").trim(),
            owner: (ownerEl && ownerEl.innerText ? ownerEl.innerText : "").replace(/^@/, "").trim(),
            thumb: el.poster || (imgEl && imgEl.src) || "",
            duration: el.duration && isFinite(el.duration) ? el.duration * 1000 : 0,
          },
        ]);
      }
      return vid;
    }
    return id;
  }

  let ttScrollTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      const btn = document.getElementById("fbvd-float-btn");
      if (btn && activeVideo && btn.style.display !== "none") placeForVideo(activeVideo, btn);
      if (isByteDance) {
        clearTimeout(ttScrollTimer);
        ttScrollTimer = setTimeout(() => {
          chrome.storage.local
            .get("settings")
            .then((r) => {
              if (!r.settings || r.settings.autoScan !== false) captureActiveTikTok(false);
            })
            .catch(() => captureActiveTikTok(false));
        }, 600);
      }
    },
    { passive: true }
  );
})();
