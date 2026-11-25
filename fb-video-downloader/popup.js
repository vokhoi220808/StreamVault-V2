// StreamVault V2 — Redesigned Popup Controller
// Preserves 30-item incremental rendering, per-tab scroll restoration, and all V2 features.
const CORE = window.SV_CORE;
const $ = (id) => document.getElementById(id);

const $list = $("list");
const $streams = $("streams");
const $streamsHeader = $("streamsHeader");
const $clearStreams = $("clearStreams");
const $banner = $("stateBanner");
const $controls = $("controlsSection");
const $search = $("search");
const $quickQuality = $("quickQuality");
const $selectAll = $("selectAll");
const $skipDupToggle = $("skipDupToggle");
const $dlBatch = $("dlBatch");
const $autoScroll = $("autoScroll");
const $autoScrollTxt = $("autoScrollTxt");
const $grabOptsBtn = $("grabOptsBtn");
const $grabBar = $("grabBar");
const $grabLimit = $("grabLimit");
const $grabStopDup = $("grabStopDup");
const $grabAutoDownload = $("grabAutoDownload");
const $rescan = $("rescan");
const $clearVideos = $("clearVideos");
const $openSettings = $("openSettings");
const $openManager = $("openManager");
const $openLibraryBtn = $("openLibraryBtn");
const $footerManagerBtn = $("footerManagerBtn");
const $dlStatusBar = $("dlStatusBar");
const $dlStatusDot = $("dlStatusDot");
const $dlStatusText = $("dlStatusText");
const $footerBarWrap = $("footerBarWrap");
const $footerBar = $("footerBar");
const $platformBadge = $("platformBadge");
const $liveDot = $("liveDot");
const $videoCountPill = $("videoCountPill");
const $streamCountPill = $("streamCountPill");
const $filterPills = $("filterPills");

let settings = CORE.DEFAULT_SETTINGS;
let lastVideos = [];
let lastUrl = "";
let lastActiveId = null;
let lastFiltered = [];
let activeFilter = "all";
let renderLimit = 30;
let currentTabId = null;
let scrollRestored = false;
let completedIds = new Set();
const selected = new Set();

function currentVideoId(url) {
  const m =
    (url || "").match(/\/(?:videos?|reel|reels|status)\/(?:[^/]+\/)?(\d+)/) ||
    (url || "").match(/\/(?:reel|reels|p|tv|post|explore)\/([A-Za-z0-9_-]{5,})/) ||
    (url || "").match(/[?&](?:v|modal_id)=(\d+)/) ||
    (url || "").match(/video\.php\?.*v=(\d+)/);
  return m ? m[1] : null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function btn(label, cls, onClick, title) {
  const b = el("button", "sv-btn " + (cls || ""), label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function playPlaceholder() {
  const wrap = el("div", "sv-thumb-placeholder");
  wrap.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" opacity="0.65"/></svg>`;
  return wrap;
}

function setBanner(text, cls, hide) {
  $banner.textContent = text;
  $banner.className = "sv-banner" + (cls ? " " + cls : "");
  $banner.hidden = !!hide;
}

function updatePlatformHeader(url) {
  const u = url || "";
  if (/facebook\.com/i.test(u)) {
    const isGroup = /\/groups\//i.test(u);
    const isReel = /\/reel/i.test(u);
    $platformBadge.textContent = isGroup ? "Facebook Group" : isReel ? "Facebook Reels" : "Facebook";
    $liveDot.className = "sv-live-dot active";
  } else if (/tiktok\.com/i.test(u)) {
    $platformBadge.textContent = "TikTok";
    $liveDot.className = "sv-live-dot active";
  } else if (/instagram\.com/i.test(u)) {
    $platformBadge.textContent = /\/reel/i.test(u) ? "Instagram Reels" : "Instagram";
    $liveDot.className = "sv-live-dot active";
  } else if (/threads\.(net|com)/i.test(u)) {
    $platformBadge.textContent = "Threads";
    $liveDot.className = "sv-live-dot active";
  } else if (/douyin\.com/i.test(u)) {
    $platformBadge.textContent = "Douyin";
    $liveDot.className = "sv-live-dot active";
  } else if (/(^|\.|\/)(x\.com|twitter\.com)/i.test(u)) {
    $platformBadge.textContent = "X (Twitter)";
    $liveDot.className = "sv-live-dot active";
  } else if (/xiaohongshu\.com/i.test(u)) {
    $platformBadge.textContent = "Xiaohongshu";
    $liveDot.className = "sv-live-dot active";
  } else {
    $platformBadge.textContent = "Trang không hỗ trợ";
    $liveDot.className = "sv-live-dot err";
  }
}

function updateBatchBtn() {
  const count = lastFiltered.filter((v) => selected.has(v.id)).length;
  $selectAll.checked = lastFiltered.length > 0 && count === lastFiltered.length;
  $dlBatch.hidden = lastFiltered.length === 0;
  if (count > 0) {
    $dlBatch.textContent = `⬇ Tải (${count})`;
  } else if ($skipDupToggle.checked) {
    const newCnt = lastFiltered.filter((v) => !completedIds.has(String(v.id))).length;
    $dlBatch.textContent = newCnt < lastFiltered.length ? `⬇ Tải mới (${newCnt})` : `⬇ Tải tất cả (${lastFiltered.length})`;
  } else {
    $dlBatch.textContent = `⬇ Tải tất cả (${lastFiltered.length})`;
  }
}

function pickUrlForVideo(v, mode) {
  if (mode === "sd") return v.sd || v.hd ? { url: v.sd || v.hd, label: v.sd ? "SD" : "HD" } : null;
  if (mode === "hd") return v.hd || v.sd ? { url: v.hd || v.sd, label: v.hd ? "HD" : "SD" } : null;
  if (v.hd) return { url: v.hd, label: v.hdHeight ? `${v.hdHeight}p` : "HD" };
  if (v.dashVideo && v.dashAudio) {
    return {
      dash: true,
      vUrl: v.dashVideo.url,
      vInitUrl: v.dashVideo.initUrl || "",
      vSegments: v.dashVideo.segments || null,
      aUrl: v.dashAudio.url,
      aInitUrl: v.dashAudio.initUrl || "",
      aSegments: v.dashAudio.segments || null,
      label: v.dashVideo.height ? `${v.dashVideo.height}p` : "DASH",
    };
  }
  if (v.sd) return { url: v.sd, label: "SD" };
  return null;
}

function buildZipEntries(v) {
  const entries = [];
  (v.images || []).forEach((imgUrl, idx) => {
    entries.push({ url: imgUrl, name: `slide_${String(idx + 1).padStart(2, "0")}.jpg` });
  });
  (v.carouselVideos || []).forEach((cv) => {
    if (cv && cv.url) {
      entries.push({ url: cv.url, name: `clip_${String(cv.index || entries.length + 1).padStart(2, "0")}.mp4` });
    }
  });
  if (v.musicUrl) {
    entries.push({ url: v.musicUrl, name: `music.mp3` });
  }
  return entries;
}

async function downloadSlideshow(v) {
  const baseMeta = { id: v.id, title: v.title, author: v.owner, platform: v.platform, sourceUrl: v.sourceUrl || lastUrl, thumb: v.thumb || "" };
  const zipEntries = buildZipEntries(v);
  if (settings.zipSlideshow !== false && zipEntries.length) {
    await chrome.runtime.sendMessage({
      type: "zipSlideshow",
      entries: zipEntries,
      name: CORE.safeName(v.title) || `${v.platform}_${v.id}`,
      meta: baseMeta,
      tabId: currentTabId,
    });
    setBanner(`📦 Đang gom ${zipEntries.length} file thành .zip trong nền...`, "success", false);
    refreshJobSummary();
    return;
  }

  const items = [];
  (v.images || []).forEach((imgUrl, idx) => {
    const meta = Object.assign({}, baseMeta, { quality: `img${String(idx + 1).padStart(2, "0")}`, ext: "jpg" });
    items.push({ url: imgUrl, filename: CORE.formatFilename(settings, meta), meta, tabId: currentTabId });
  });
  (v.carouselVideos || []).forEach((cv) => {
    if (!cv || !cv.url) return;
    const meta = Object.assign({}, baseMeta, { quality: `clip${String(cv.index || 1).padStart(2, "0")}`, ext: "mp4" });
    items.push({ url: cv.url, filename: CORE.formatFilename(settings, meta), meta, tabId: currentTabId });
  });
  if (v.musicUrl) {
    const meta = Object.assign({}, baseMeta, { quality: "music", ext: "mp3" });
    items.push({ url: v.musicUrl, filename: CORE.formatFilename(settings, meta), meta, tabId: currentTabId });
  }
  if (!items.length) return;
  await chrome.runtime.sendMessage({ type: "enqueueBatch", items, tabId: currentTabId });
  setBanner(`✅ Đã đưa ${items.length} file vào Download Manager.`, "success", false);
  refreshJobSummary();
}

async function downloadMusic(v) {
  const url = v.musicUrl || (v.dashAudio && v.dashAudio.url);
  if (!url) return;
  const ext = v.musicUrl ? "mp3" : "m4a";
  const quality = v.musicUrl ? "music" : "audio";
  const meta = { id: v.id, title: v.musicTitle || v.title, author: v.owner, platform: v.platform, quality, ext, sourceUrl: v.sourceUrl || lastUrl, thumb: v.thumb || "" };
  const filename = CORE.formatFilename(settings, meta);
  await chrome.runtime.sendMessage({ type: "download", url, filename, meta, tabId: currentTabId });
  refreshJobSummary();
}

async function triggerDownload(v, overrideChoice) {
  if (overrideChoice === "slideshow") return downloadSlideshow(v);
  if (overrideChoice === "music") return downloadMusic(v);
  if (overrideChoice && typeof overrideChoice === "object" && overrideChoice.clipUrl) {
    const meta = { id: v.id, title: v.title, author: v.owner, platform: v.platform, quality: overrideChoice.label || "clip", sourceUrl: v.sourceUrl || lastUrl, thumb: v.thumb || "" };
    await chrome.runtime.sendMessage({ type: "download", url: overrideChoice.clipUrl, filename: CORE.formatFilename(settings, meta), meta, tabId: currentTabId });
    refreshJobSummary();
    return;
  }
  const qMode = overrideChoice || $quickQuality.value || settings.quality || "best";
  const choice = pickUrlForVideo(v, qMode);
  const firstSub = (v.subtitles && v.subtitles[0] && v.subtitles[0].url) || "";
  const meta = {
    id: v.id,
    title: v.title,
    author: v.owner,
    platform: v.platform,
    quality: (choice && choice.label) || v.bestLabel || "MP4",
    sourceUrl: v.sourceUrl || lastUrl,
    thumb: v.thumb || "",
    subtitleUrl: firstSub,
  };

  if (choice && choice.dash) {
    await chrome.runtime.sendMessage({
      type: "openMerge",
      vUrl: choice.vUrl,
      vInitUrl: choice.vInitUrl || "",
      vSegments: choice.vSegments || null,
      aUrl: choice.aUrl,
      aInitUrl: choice.aInitUrl || "",
      aSegments: choice.aSegments || null,
      name: CORE.safeName(v.title) || `${v.platform}_${v.id}`,
      meta,
      tabId: currentTabId,
    });
  } else if (choice && choice.url) {
    const filename = CORE.formatFilename(settings, meta);
    await chrome.runtime.sendMessage({ type: "download", url: choice.url, filename, meta, tabId: currentTabId });
  } else if (v.dashVideo && v.dashAudio) {
    await chrome.runtime.sendMessage({
      type: "openMerge",
      vUrl: v.dashVideo.url,
      vInitUrl: v.dashVideo.initUrl || "",
      vSegments: v.dashVideo.segments || null,
      aUrl: v.dashAudio.url,
      aInitUrl: v.dashAudio.initUrl || "",
      aSegments: v.dashAudio.segments || null,
      name: CORE.safeName(v.title) || `${v.platform}_${v.id}`,
      meta,
      tabId: currentTabId,
    });
  } else if (v.dashVideo) {
    const filename = CORE.formatFilename(settings, Object.assign({}, meta, { quality: "video_only" }));
    await chrome.runtime.sendMessage({ type: "download", url: v.dashVideo.url, filename, meta, tabId: currentTabId });
  } else if (v.hasImages || (v.carouselVideos && v.carouselVideos.length)) {
    return downloadSlideshow(v);
  }
  refreshJobSummary();
}

function renderVideos(videos, url, activeId) {
  lastVideos = videos;
  lastUrl = url || "";
  if (activeId !== undefined) lastActiveId = activeId;
  $list.innerHTML = "";

  const curId = lastActiveId || currentVideoId(lastUrl);
  const normalized = videos.map((v) => CORE.normalizeVideo(v, lastUrl)).filter(Boolean);
  const q = ($search.value || "").trim().toLowerCase();

  const filtered = normalized.filter((v) => {
    if (activeFilter === "direct" && !v.hasDirect) return false;
    if (activeFilter === "dash" && !v.hasDashMux && !v.dashVideo) return false;
    if (q && !((v.title || "") + " " + (v.owner || "") + " " + v.id).toLowerCase().includes(q)) return false;
    return true;
  });

  const isCur = (v) => !!(curId && (v.id === curId || (v.code && v.code === curId)));
  filtered.sort((a, b) => isCur(b) - isCur(a) || (b._playedAt || 0) - (a._playedAt || 0) || (b._seq || 0) - (a._seq || 0));
  lastFiltered = filtered;

  $videoCountPill.textContent = `${normalized.length} video`;
  $controls.hidden = normalized.length === 0;
  updateBatchBtn();

  if (!normalized.length) {
    setBanner("Chưa phát hiện video nào. Hãy bấm phát video vài giây hoặc nhấn ⟳ Quét lại.", "", false);
    return;
  }
  if (!filtered.length) {
    setBanner("Không có video nào khớp từ khóa/bộ lọc hiện tại.", "", false);
    return;
  }
  setBanner("", "", true);

  const shown = filtered.slice(0, renderLimit);
  const frag = document.createDocumentFragment();
  for (const v of shown) {
    const active = isCur(v);
    const pInfo = CORE.platformInfo(v.platform);
    const isDone = completedIds.has(String(v.id));

    const li = el("li", "sv-card" + (active ? " current" : ""));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "sv-check";
    cb.checked = selected.has(v.id);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(v.id);
      else selected.delete(v.id);
      updateBatchBtn();
    });
    li.appendChild(cb);

    const thumbWrap = el("div", "sv-thumb-wrap");
    if (v.thumb) {
      const img = el("img", "sv-thumb");
      img.loading = "lazy";
      img.decoding = "async";
      img.src = v.thumb;
      img.addEventListener("error", () => img.replaceWith(playPlaceholder()), { once: true });
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.appendChild(playPlaceholder());
    }
    thumbWrap.appendChild(el("span", "sv-plat-tag " + pInfo.tag, pInfo.short));
    if (isDone) thumbWrap.appendChild(el("span", "sv-done-corner", "✓"));
    const dur = CORE.fmtDuration(v.duration);
    if (dur) thumbWrap.appendChild(el("span", "sv-dur", dur));
    li.appendChild(thumbWrap);

    const body = el("div", "sv-card-body");
    const head = el("div", "sv-card-head");
    const title = el("div", "sv-card-title", v.title || `Video ${v.id}`);
    title.title = v.title || `Video ${v.id}`;
    head.appendChild(title);
    if (v.codecBadge && v.codecCompat === "warn") {
      const ct = el("span", "sv-codec-tag warn", v.codecBadge + " ⚠");
      ct.title = v.codecNote || "Codec thế hệ mới";
      head.appendChild(ct);
    }
    if (active) head.appendChild(el("span", "sv-now-tag", "▶ Đang chạy"));
    body.appendChild(head);

    const kindStr =
      v.transferType === "carousel"
        ? `${v.isStory ? "Story · " : ""}Album ${v.images.length} ảnh · ${v.carouselVideos.length} clip`
        : v.transferType === "slideshow"
        ? `${v.isStory ? "Story · " : "Slideshow "}${v.images.length} ảnh`
        : v.transferType === "dash"
        ? `${v.isStory ? "Story · " : ""}DASH Mux`
        : `${v.isStory ? "Story · " : ""}MP4`;
    const subParts = [v.owner, v.bestLabel, v.sizeLabel, kindStr, isDone ? "Đã tải" : ""].filter(Boolean);
    body.appendChild(el("div", "sv-card-sub", subParts.join(" · ")));

    const noLogo = v.platform === "tiktok" || v.platform === "douyin";
    const actions = el("div", "sv-card-actions");
    if (v.hd) actions.appendChild(btn(noLogo ? "⬇ Không logo" : "⬇ HD", "sv-btn-primary", () => triggerDownload(v, "hd")));
    if (v.sd) actions.appendChild(btn(noLogo ? "⬇ Dự phòng" : "⬇ SD", "", () => triggerDownload(v, "sd")));
    if (v.hasDashMux && (!v.hd || (v.dashVideo.height || 0) > (v.hdHeight || 0))) {
      const q = v.dashVideo.height ? `${v.dashVideo.height}p ` : "";
      actions.appendChild(btn(`⬇ ${q}Có tiếng`, v.hd ? "" : "sv-btn-purple", () => triggerDownload(v, "best")));
    }
    if (v.hasImages || (v.carouselVideos && v.carouselVideos.length > 1)) {
      const zipOn = settings.zipSlideshow !== false;
      const totalItems = (v.images ? v.images.length : 0) + (v.carouselVideos ? v.carouselVideos.length : 0);
      const albLabel = zipOn ? `📦 ${totalItems} mục (.zip)` : `🖼 ${v.images ? v.images.length : 0} ảnh`;
      actions.appendChild(btn(albLabel, "sv-btn-primary", () => triggerDownload(v, "slideshow")));
    }
    if (!v.hd && v.carouselVideos && v.carouselVideos.length) {
      v.carouselVideos.slice(0, 2).forEach((cv) => {
        const ql = cv.height ? ` ${cv.height}p` : "";
        actions.appendChild(btn(`⬇ Clip ${cv.index}${ql}`, "", () => triggerDownload(v, { clipUrl: cv.url, label: `clip${cv.index}` })));
      });
    }
    if (v.musicUrl || v.dashAudio) {
      const mBtn = btn("", "", () => triggerDownload(v, "music"), v.musicUrl ? "Tải nhạc MP3" : "Tải âm thanh (.m4a)");
      mBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="16" r="3" stroke="currentColor" stroke-width="2"/></svg>`;
      actions.appendChild(mBtn);
    }
    if (v.hasSubtitles) {
      const subBtn = btn("CC", "", (e) => {
        const b = e.currentTarget;
        const st0 = v.subtitles[0];
        chrome.runtime.sendMessage({
          type: "downloadSubtitle",
          url: st0.url,
          format: st0.format,
          meta: { id: v.id, title: v.title, author: v.owner, platform: v.platform, quality: st0.lang || "sub" },
        });
        b.textContent = "✓";
        setTimeout(() => (b.textContent = "CC"), 1200);
      }, `Tải phụ đề (${v.subtitles[0].lang || "SRT"})`);
      actions.appendChild(subBtn);
    }
    const copyUrl = v.hd || v.sd || (v.dashVideo && v.dashVideo.url);
    if (copyUrl) {
      const cpSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>`;
      const cpBtn = btn("", "", (e) => {
        navigator.clipboard?.writeText(copyUrl).catch(() => {});
        const b = e.currentTarget;
        b.textContent = "✓";
        setTimeout(() => (b.innerHTML = cpSvg), 1200);
      }, "Chép đường dẫn video");
      cpBtn.innerHTML = cpSvg;
      actions.appendChild(cpBtn);
    }
    body.appendChild(actions);
    li.appendChild(body);
    frag.appendChild(li);
  }

  if (filtered.length > shown.length) {
    const more = btn(`⬇ Xem thêm (còn ${filtered.length - shown.length} video)`, "sv-more-btn", () => {
      renderLimit += 40;
      renderVideos(lastVideos, lastUrl);
    });
    frag.appendChild(more);
  }
  $list.appendChild(frag);
}

async function renderStreams(tabId) {
  const k = "streams_" + tabId;
  const list = ((await chrome.storage.session.get(k))[k] || []).slice();
  list.sort((a, b) => (a.type !== b.type ? (a.type === "video" ? -1 : 1) : (b.qNum || 0) - (a.qNum || 0) || b.time - a.time));
  const vidStreams = list.filter((s) => s.type === "video" && !s.muxed).length;
  $streamCountPill.textContent = `${vidStreams} DASH`;

  $streams.innerHTML = "";
  const showFallback = settings.showNetworkFallback !== false && list.length > 0;
  $streamsHeader.hidden = !showFallback;
  if (!showFallback) return;

  const audios = list.filter((s) => s.type === "audio");
  const frag = document.createDocumentFragment();
  for (const s of list) {
    const li = el("li", "sv-card");
    const body = el("div", "sv-card-body");
    const label = s.type === "audio" ? "🔊 Luồng tiếng" : `🎬 Luồng hình ${s.quality || ""}`;
    body.appendChild(el("div", "sv-card-title", label));
    body.appendChild(el("div", "sv-card-sub", [s.videoId && "ID " + s.videoId, new Date(s.time).toLocaleTimeString()].filter(Boolean).join(" · ")));
    const actions = el("div", "sv-card-actions");
    const sPlat = s.platform || (s.muxed ? "tiktok" : "facebook");
    const sInfo = CORE.platformInfo(sPlat);
    const meta = { id: s.videoId || String(s.time), platform: sPlat, quality: s.quality || "MP4", sourceUrl: lastUrl };
    if (s.type === "video") {
      if (s.muxed) {
        actions.appendChild(btn(`⬇ Tải ${sInfo.name}`, "sv-btn-primary", () => chrome.runtime.sendMessage({ type: "download", url: s.url, filename: CORE.formatFilename(settings, meta), meta })));
      } else {
        const pair = s.videoId ? audios.find((a) => a.videoId === s.videoId) : audios.find((a) => !a.videoId) || audios[0];
        if (pair) {
          actions.appendChild(btn("⬇ Ghép + Tiếng", "sv-btn-purple", () => chrome.runtime.sendMessage({ type: "openMerge", vUrl: s.url, aUrl: pair.url, name: `facebook_${meta.id}`, meta })));
        }
        actions.appendChild(btn(pair ? "Chỉ hình" : "⬇ Tải", pair ? "" : "sv-btn-primary", () => chrome.runtime.sendMessage({ type: "download", url: s.url, filename: CORE.formatFilename(settings, Object.assign({}, meta, { quality: s.quality || "video" })), meta })));
      }
    } else {
      actions.appendChild(btn("⬇ Chỉ tiếng", "", () => chrome.runtime.sendMessage({ type: "download", url: s.url, filename: CORE.formatFilename(settings, Object.assign({}, meta, { quality: "audio", ext: "m4a" })), meta })));
    }
    body.appendChild(actions);
    li.appendChild(body);
    frag.appendChild(li);
  }
  $streams.appendChild(frag);
}

async function refreshJobSummary() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getJobs" });
    const jobs = (res && res.jobs) || [];
    const prevSize = completedIds.size;
    completedIds = CORE.getCompletedVideoIds(jobs, res && res.archivedIds);
    if (completedIds.size !== prevSize && lastVideos.length) renderVideos(lastVideos, lastUrl);

    const activeList = jobs.filter((j) => j.status === "downloading" || j.status === "muxing");
    const queued = jobs.filter((j) => j.status === "queued").length;
    const done = jobs.filter((j) => j.status === "completed").length;
    const failed = jobs.filter((j) => j.status === "failed").length;

    if (activeList.length || queued) {
      $dlStatusDot.className = "sv-foot-dot busy";
      $footerBarWrap.hidden = false;
      const totB = activeList.reduce((a, b) => a + (b.totalBytes || 0), 0);
      const gotB = activeList.reduce((a, b) => a + (b.bytesReceived || 0), 0);
      const pct = totB > 0 ? Math.min(100, Math.round((gotB / totB) * 100)) : 35;
      $footerBar.style.width = pct + "%";
      $dlStatusText.textContent = `Đang tải ${activeList.length} · Chờ ${queued} · Xong ${done}`;
    } else {
      $dlStatusDot.className = "sv-foot-dot";
      $footerBarWrap.hidden = true;
      $dlStatusText.textContent = done || failed ? `Hoàn tất: ${done}` + (failed ? ` · Lỗi: ${failed}` : "") : "Sẵn sàng · Alt+D tải nhanh";
    }
  } catch (e) {}
}

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setAutoScrollUI(on) {
  $autoScroll.classList.toggle("active", on);
  $autoScrollTxt.textContent = on ? "Dừng" : "Cuộn";
}

function openWorkspace(hash) {
  const q = currentTabId ? `?tabId=${currentTabId}` : "";
  chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") + q + (hash || "") });
}

let scrollSaveTimer = null;
window.addEventListener(
  "scroll",
  () => {
    if (!currentTabId) return;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      chrome.storage.session.set({ ["popup_scroll_" + currentTabId]: Math.round(window.scrollY) });
    }, 100);
  },
  { passive: true }
);

async function refresh(type) {
  const tab = await getTab();
  updatePlatformHeader(tab && tab.url);
  if (!tab || !/^https?:\/\/([^/]+\.)?(facebook\.com|tiktok\.com|instagram\.com|threads\.(net|com)|douyin\.com|x\.com|twitter\.com|xiaohongshu\.com)\//.test(tab.url || "")) {
    setBanner("Hãy mở Facebook, TikTok, Instagram, Threads, Douyin, X hoặc Xiaohongshu.", "error", false);
    $controls.hidden = true;
    return 0;
  }
  currentTabId = tab.id;
  const scrollKey = "popup_scroll_" + tab.id;
  try {
    const [loadedSettings, res, saved] = await Promise.all([
      CORE.loadSettings(),
      chrome.tabs.sendMessage(tab.id, { type }),
      scrollRestored ? Promise.resolve({}) : chrome.storage.session.get(scrollKey),
    ]);
    settings = loadedSettings;
    CORE.applyAppearance(settings);
    if ($quickQuality.dataset.init !== "1") {
      $quickQuality.value = settings.quality === "sd" ? "sd" : "best";
      $skipDupToggle.checked = settings.skipDuplicates !== false;
      $grabLimit.value = String(settings.autoScrollLimit || 0);
      $grabStopDup.checked = !!settings.autoScrollStopOnDup;
      $grabAutoDownload.checked = !!settings.autoScrollAutoDownload;
      $quickQuality.dataset.init = "1";
    }
    await renderStreams(tab.id);

    const y = saved[scrollKey] || 0;
    if (!scrollRestored && y > 0) {
      const need = Math.ceil(y / 95) + 10;
      if (need > renderLimit) renderLimit = need;
    }
    setAutoScrollUI(!!res.autoScrolling);
    renderVideos(res.videos || [], res.url, res.activeId);
    if (!scrollRestored) {
      scrollRestored = true;
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    }
  } catch (e) {
    setBanner("Không kết nối được trang. Hãy bấm F5 tải lại tab đang mở.", "error", false);
    $liveDot.className = "sv-live-dot err";
  }
  return $list.children.length;
}

$filterPills.addEventListener("click", (e) => {
  const b = e.target.closest(".sv-seg-btn");
  if (!b) return;
  activeFilter = b.dataset.filter || "all";
  $filterPills.querySelectorAll(".sv-seg-btn").forEach((c) => c.classList.toggle("active", c === b));
  renderVideos(lastVideos, lastUrl);
});

$search.addEventListener("input", () => renderVideos(lastVideos, lastUrl));
$selectAll.addEventListener("change", () => {
  if ($selectAll.checked) lastFiltered.forEach((v) => selected.add(v.id));
  else lastFiltered.forEach((v) => selected.delete(v.id));
  renderVideos(lastVideos, lastUrl);
});

$skipDupToggle.addEventListener("change", async () => {
  settings = await CORE.saveSettings({ skipDuplicates: $skipDupToggle.checked });
  updateBatchBtn();
});

$dlBatch.addEventListener("click", async () => {
  const picked = lastFiltered.filter((v) => selected.has(v.id));
  const usePicked = picked.length > 0;
  let targets = usePicked ? picked : lastFiltered;
  let skipped = 0;
  if (!usePicked && $skipDupToggle.checked) {
    targets = lastFiltered.filter((v) => {
      if (completedIds.has(String(v.id))) {
        skipped++;
        return false;
      }
      return true;
    });
  }
  if (!targets.length) {
    setBanner(skipped ? `Tất cả ${skipped} video này đã được tải trước đó.` : "Không có video nào để tải.", "", false);
    return;
  }
  const qMode = $quickQuality.value || settings.quality || "best";
  const items = [];
  for (const v of targets) {
    const firstSub = (v.subtitles && v.subtitles[0] && v.subtitles[0].url) || "";
    const baseMeta = { id: v.id, title: v.title, author: v.owner, platform: v.platform, sourceUrl: v.sourceUrl || lastUrl, thumb: v.thumb || "", subtitleUrl: firstSub };
    if ((v.hasImages || (v.carouselVideos && v.carouselVideos.length > 1)) && !v.hd && !v.sd) {
      const zipEntries = buildZipEntries(v);
      if (settings.zipSlideshow !== false && zipEntries.length) {
        items.push({ zipItems: zipEntries, name: CORE.safeName(v.title) || `${v.platform}_${v.id}`, meta: Object.assign({}, baseMeta, { quality: "ZIP", ext: "zip" }) });
      } else {
        (v.images || []).forEach((imgUrl, idx) => {
          const meta = Object.assign({}, baseMeta, { quality: `img${String(idx + 1).padStart(2, "0")}`, ext: "jpg" });
          items.push({ url: imgUrl, filename: CORE.formatFilename(settings, meta), meta });
        });
        (v.carouselVideos || []).forEach((cv) => {
          if (!cv || !cv.url) return;
          const meta = Object.assign({}, baseMeta, { quality: `clip${String(cv.index || 1).padStart(2, "0")}`, ext: "mp4" });
          items.push({ url: cv.url, filename: CORE.formatFilename(settings, meta), meta });
        });
        if (v.musicUrl) {
          const meta = Object.assign({}, baseMeta, { quality: "music", ext: "mp3" });
          items.push({ url: v.musicUrl, filename: CORE.formatFilename(settings, meta), meta });
        }
      }
      continue;
    }
    const choice = pickUrlForVideo(v, qMode);
    const meta = Object.assign({}, baseMeta, { quality: (choice && choice.label) || v.bestLabel });
    if (choice && choice.dash) {
      items.push({
        vUrl: choice.vUrl,
        vInitUrl: choice.vInitUrl || "",
        vSegments: choice.vSegments || null,
        aUrl: choice.aUrl,
        aInitUrl: choice.aInitUrl || "",
        aSegments: choice.aSegments || null,
        name: CORE.safeName(v.title) || `${v.platform}_${v.id}`,
        meta,
      });
    } else if (choice && choice.url) items.push({ url: choice.url, filename: CORE.formatFilename(settings, meta), meta });
  }
  if (!items.length) return;
  await chrome.runtime.sendMessage({ type: "enqueueBatch", items, tabId: currentTabId });
  setBanner(`✅ Đã đưa ${items.length} file vào Download Manager` + (skipped ? ` (bỏ qua ${skipped} video đã tải).` : "."), "success", false);
  refreshJobSummary();
});

$grabOptsBtn.addEventListener("click", () => {
  $grabBar.hidden = !$grabBar.hidden;
});
$grabLimit.addEventListener("change", async () => {
  settings = await CORE.saveSettings({ autoScrollLimit: Number($grabLimit.value) || 0 });
});
$grabStopDup.addEventListener("change", async () => {
  settings = await CORE.saveSettings({ autoScrollStopOnDup: $grabStopDup.checked });
});
$grabAutoDownload.addEventListener("change", async () => {
  settings = await CORE.saveSettings({ autoScrollAutoDownload: $grabAutoDownload.checked });
});

$autoScroll.addEventListener("click", async () => {
  const tab = await getTab();
  if (!tab) return;
  const res = await chrome.tabs
    .sendMessage(tab.id, {
      type: "toggleAutoScroll",
      options: { maxNew: Number($grabLimit.value) || 0, stopOnDup: !!$grabStopDup.checked, autoDownload: !!$grabAutoDownload.checked },
    })
    .catch(() => null);
  if (res) setAutoScrollUI(!!res.autoScrolling);
});

$rescan.addEventListener("click", async () => {
  setBanner("Đang quét lại trang...", "", false);
  $rescan.disabled = true;
  await refresh("rescan");
  $rescan.disabled = false;
});

$clearVideos.addEventListener("click", async () => {
  selected.clear();
  await refresh("clearVideos");
});

$clearStreams.addEventListener("click", async () => {
  const tab = await getTab();
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: "clearStreams", tabId: tab.id });
  renderStreams(tab.id);
});

$openSettings.addEventListener("click", () => openWorkspace("#settings"));
$openManager.addEventListener("click", () => openWorkspace("#downloads"));
$openLibraryBtn.addEventListener("click", (e) => { e.stopPropagation(); openWorkspace("#library"); });
$footerManagerBtn.addEventListener("click", (e) => { e.stopPropagation(); openWorkspace("#downloads"); });
$dlStatusBar.addEventListener("click", () => openWorkspace("#downloads"));

CORE.loadSettings().then((s) => {
  settings = s;
  CORE.applyAppearance(s);
});
refreshJobSummary();
refresh("getVideos").then((n) => {
  if (!n && settings.autoScan !== false) refresh("rescan");
});
