// StreamVault V2 — Redesigned Workspace Controller (Video Library, Download Manager, Settings Center)
const CORE = window.SV_CORE;
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const initialTabId = qs.get("tabId") ? Number(qs.get("tabId")) : null;

let settings = CORE.DEFAULT_SETTINGS;
let libSources = [];
let liveActiveId = null;
let libSelected = new Set();
let libRenderLimit = 48;
let dmFilter = "all";
let dmJobs = [];
let dmArchivedIds = [];
let dmArchivedJobs = [];

function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".sv-view").forEach((sec) => (sec.hidden = sec.id !== "view-" + view));
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  if (view === "downloads") loadJobs();
  if (view === "settings") loadLogs();
}

$("mainNav").addEventListener("click", (e) => {
  const b = e.target.closest(".nav-item");
  if (b) switchView(b.dataset.view);
});

function pillEl(cls, text, title) {
  const sp = document.createElement("span");
  sp.className = "sv-pill" + (cls ? " " + cls : "");
  sp.textContent = text;
  if (title) sp.title = title;
  return sp;
}

function playPlaceholder() {
  const wrap = document.createElement("div");
  wrap.className = "sv-thumb-placeholder";
  wrap.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" opacity="0.55"/></svg>`;
  return wrap;
}

// ================= VIDEO LIBRARY =================
async function loadLibrarySources() {
  const byTab = new Map();
  const res = await chrome.runtime.sendMessage({ type: "getAllTabVideos" }).catch(() => ({ tabs: [] }));
  for (const t of (res && res.tabs) || []) {
    byTab.set(t.tabId, t);
  }
  if (initialTabId) {
    try {
      const live = await chrome.tabs.sendMessage(initialTabId, { type: "getVideos" });
      if (live) {
        liveActiveId = live.activeId || null;
        const cur = byTab.get(initialTabId) || { tabId: initialTabId, title: "Tab hiện tại" };
        cur.url = live.url || cur.url;
        cur.videos = live.videos || [];
        byTab.set(initialTabId, cur);
      }
    } catch (e) {}
  }
  libSources = Array.from(byTab.values());

  const prevTab = $("libTabFilter").value;
  $("libTabFilter").textContent = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = `Tất cả tab (${libSources.length})`;
  $("libTabFilter").appendChild(allOpt);
  for (const s of libSources) {
    const opt = document.createElement("option");
    opt.value = String(s.tabId);
    opt.textContent = `${s.title || s.url || "Tab " + s.tabId} (${(s.videos || []).length})`;
    $("libTabFilter").appendChild(opt);
  }
  if ([...$("libTabFilter").options].some((o) => o.value === prevTab)) $("libTabFilter").value = prevTab;
  else if (initialTabId && byTab.has(initialTabId)) $("libTabFilter").value = String(initialTabId);

  renderLibrary();
}

function getDedupedLibraryVideos() {
  const tabFilter = $("libTabFilter").value;
  const platFilter = $("libPlatFilter").value;
  const resFilter = $("libResFilter").value;
  const statusFilter = $("libStatusFilter").value;
  const q = ($("libSearch").value || "").trim().toLowerCase();
  const sort = $("libSort").value;
  const completedIds = CORE.getCompletedVideoIds(dmJobs, dmArchivedIds);

  const map = new Map();
  for (const src of libSources) {
    if (tabFilter !== "all" && String(src.tabId) !== tabFilter) continue;
    for (const raw of src.videos || []) {
      const nv = CORE.normalizeVideo(raw, src.url);
      if (!nv) continue;
      nv._sourceTitle = src.title || src.url || "";
      nv._sourceUrl = nv.sourceUrl || src.url || "";
      const existing = map.get(nv.id);
      if (!existing || (nv.hd && !existing.hd) || (nv.hasDashMux && !existing.hasDashMux) || (nv._playedAt || 0) > (existing._playedAt || 0)) {
        map.set(nv.id, nv);
      }
    }
  }

  let list = Array.from(map.values()).filter((v) => {
    if (platFilter !== "all" && v.platform !== platFilter) return false;
    if (statusFilter === "downloaded" && !completedIds.has(String(v.id))) return false;
    if (statusFilter === "unseen" && completedIds.has(String(v.id))) return false;
    if (resFilter === "direct" && !v.hasDirect) return false;
    if (resFilter === "dash" && !v.hasDashMux && !v.dashVideo) return false;
    if (resFilter === "slideshow" && !v.hasImages && !(v.carouselVideos && v.carouselVideos.length)) return false;
    if (resFilter === "hd") {
      const h = Math.max(v.hdHeight || 0, (v.dashVideo && v.dashVideo.height) || 0);
      if (!v.hd && h < 720) return false;
    }
    if (q && !((v.title || "") + " " + (v.owner || "") + " " + v.id + " " + v._sourceUrl).toLowerCase().includes(q)) return false;
    return true;
  });

  const isCur = (v) => !!(liveActiveId && (v.id === liveActiveId || (v.code && v.code === liveActiveId)));
  if (sort === "quality") {
    const score = (v) => Math.max(v.hdHeight || 0, (v.dashVideo && v.dashVideo.height) || 0, v.hd ? 720 : 360);
    list.sort((a, b) => isCur(b) - isCur(a) || score(b) - score(a));
  } else if (sort === "duration") {
    list.sort((a, b) => isCur(b) - isCur(a) || (b.duration || 0) - (a.duration || 0));
  } else if (sort === "title") {
    list.sort((a, b) => isCur(b) - isCur(a) || (a.title || "").localeCompare(b.title || ""));
  } else {
    list.sort((a, b) => isCur(b) - isCur(a) || (b._playedAt || 0) - (a._playedAt || 0) || (b._seq || 0) - (a._seq || 0));
  }
  return list;
}

function buildZipEntries(v) {
  const entries = [];
  (v.images || []).forEach((imgUrl, idx) => {
    entries.push({ url: imgUrl, name: `slide_${String(idx + 1).padStart(2, "0")}.jpg` });
  });
  (v.carouselVideos || []).forEach((cv) => {
    if (cv && cv.url) entries.push({ url: cv.url, name: `clip_${String(cv.index || entries.length + 1).padStart(2, "0")}.mp4` });
  });
  if (v.musicUrl) entries.push({ url: v.musicUrl, name: "music.mp3" });
  return entries;
}

function buildJobSpecs(v, forceMode) {
  const mode = forceMode || settings.quality || "hd";
  const firstSub = (v.subtitles && v.subtitles[0] && v.subtitles[0].url) || "";
  const meta = { id: v.id, title: v.title, author: v.owner, platform: v.platform, sourceUrl: v._sourceUrl, thumb: v.thumb || "", subtitleUrl: firstSub };
  if ((v.hasImages || (v.carouselVideos && v.carouselVideos.length > 1)) && !v.hd && !v.sd) {
    const entries = buildZipEntries(v);
    if (settings.zipSlideshow !== false && entries.length) {
      return [{ zipItems: entries, name: CORE.safeName(v.title) || `${v.platform}_${v.id}`, meta: Object.assign({}, meta, { quality: "ZIP", ext: "zip" }) }];
    }
    const out = (v.images || []).map((imgUrl, idx) => {
      const im = Object.assign({}, meta, { quality: `img${String(idx + 1).padStart(2, "0")}`, ext: "jpg" });
      return { url: imgUrl, filename: CORE.formatFilename(settings, im), meta: im };
    });
    (v.carouselVideos || []).forEach((cv) => {
      if (!cv || !cv.url) return;
      const cm = Object.assign({}, meta, { quality: `clip${String(cv.index || 1).padStart(2, "0")}`, ext: "mp4" });
      out.push({ url: cv.url, filename: CORE.formatFilename(settings, cm), meta: cm });
    });
    if (v.musicUrl) {
      const mm = Object.assign({}, meta, { quality: "music", ext: "mp3" });
      out.push({ url: v.musicUrl, filename: CORE.formatFilename(settings, mm), meta: mm });
    }
    return out;
  }
  const preferDirect = settings.defaultBehavior === "prefer_direct" || mode === "sd";
  if ((preferDirect || v.hd) && (v.hd || v.sd)) {
    const pick = mode === "sd" ? v.sd || v.hd : v.hd || v.sd;
    const label = pick === v.hd ? (v.hdHeight ? `${v.hdHeight}p` : "HD") : "SD";
    return [{ url: pick, filename: CORE.formatFilename(settings, Object.assign({}, meta, { quality: label })), meta: Object.assign({}, meta, { quality: label }) }];
  }
  if (v.hasDashMux) {
    const label = v.dashVideo.height ? `${v.dashVideo.height}p` : "DASH";
    return [{
      vUrl: v.dashVideo.url,
      vInitUrl: v.dashVideo.initUrl || "",
      vSegments: v.dashVideo.segments || null,
      aUrl: v.dashAudio.url,
      aInitUrl: v.dashAudio.initUrl || "",
      aSegments: v.dashAudio.segments || null,
      name: CORE.safeName(v.title) || `${v.platform}_${v.id}`,
      meta: Object.assign({}, meta, { quality: label }),
    }];
  }
  if (v.dashVideo) {
    return [{ url: v.dashVideo.url, filename: CORE.formatFilename(settings, Object.assign({}, meta, { quality: "video_only" })), meta }];
  }
  if (v.musicUrl) {
    const mm = Object.assign({}, meta, { quality: "music", ext: "mp3" });
    return [{ url: v.musicUrl, filename: CORE.formatFilename(settings, mm), meta: mm }];
  }
  return [];
}

function closePreviewModal() {
  const modal = $("previewModal");
  const body = $("pvBody");
  body.querySelectorAll("video,audio").forEach((m) => {
    try { m.pause(); m.src = ""; } catch (e) {}
  });
  body.innerHTML = "";
  $("pvFoot").innerHTML = "";
  modal.hidden = true;
}

function openPreviewModal(v) {
  const pInfo = CORE.platformInfo(v.platform);
  $("pvTitle").textContent = v.title || `Video ${v.id}`;
  $("pvMeta").textContent = [pInfo.name, v.owner, v.bestLabel, v.codecBadge ? `Codec: ${v.codecBadge}` : ""].filter(Boolean).join(" · ");

  const body = $("pvBody");
  body.innerHTML = "";
  const playUrl = v.hd || v.sd || (v.carouselVideos && v.carouselVideos[0] && v.carouselVideos[0].url) || (v.dashVideo && v.dashVideo.url);
  if (playUrl) {
    const vid = document.createElement("video");
    vid.className = "sv-modal-video";
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.src = playUrl;
    if (v.thumb) vid.poster = v.thumb;
    body.appendChild(vid);
    if (!v.hd && !v.sd && v.hasDashMux) {
      const note = document.createElement("div");
      note.className = "sv-modal-note";
      note.textContent = "ℹ Video này dùng DASH tách luồng nên bản xem trước chỉ phát hình; bấm ⬇ Tải ngay để Extension tự ghép đủ hình + tiếng.";
      body.appendChild(note);
    }
  }
  if (v.images && v.images.length) {
    const gal = document.createElement("div");
    gal.className = "sv-modal-gallery";
    for (const u of v.images) {
      const im = document.createElement("img");
      im.src = u;
      im.loading = "lazy";
      gal.appendChild(im);
    }
    body.appendChild(gal);
  }
  if (v.musicUrl) {
    const au = document.createElement("audio");
    au.controls = true;
    au.style.width = "100%";
    au.src = v.musicUrl;
    body.appendChild(au);
  }
  if (v.codecCompat === "warn" && v.codecNote) {
    const warn = document.createElement("div");
    warn.className = "sv-modal-note";
    warn.textContent = `⚠ ${v.codecNote}`;
    body.appendChild(warn);
  }

  const foot = $("pvFoot");
  foot.innerHTML = "";
  const dlNow = document.createElement("button");
  dlNow.className = "sv-btn sv-btn-primary";
  dlNow.textContent = "⬇ Tải ngay";
  dlNow.onclick = async () => {
    const specs = buildJobSpecs(v);
    if (specs.length === 1 && specs[0].zipItems) {
      await chrome.runtime.sendMessage({ type: "zipSlideshow", entries: specs[0].zipItems, name: specs[0].name, meta: specs[0].meta, tabId: initialTabId });
    } else if (specs.length === 1 && specs[0].vUrl) {
      await chrome.runtime.sendMessage({ type: "openMerge", ...specs[0], tabId: initialTabId });
    } else if (specs.length === 1) {
      await chrome.runtime.sendMessage({ type: "download", url: specs[0].url, filename: specs[0].filename, meta: specs[0].meta, tabId: initialTabId });
    } else if (specs.length) {
      await chrome.runtime.sendMessage({ type: "enqueueBatch", items: specs, tabId: initialTabId });
    }
    closePreviewModal();
    loadJobs();
  };
  foot.appendChild(dlNow);

  const safeSrcUrl = CORE.safeHttpUrl(v._sourceUrl);
  if (safeSrcUrl) {
    const srcBtn = document.createElement("button");
    srcBtn.className = "sv-btn";
    srcBtn.textContent = "🔗 Mở bài gốc";
    srcBtn.onclick = () => chrome.tabs.create({ url: safeSrcUrl });
    foot.appendChild(srcBtn);
  }
  if (v.hasSubtitles) {
    const subBtn = document.createElement("button");
    subBtn.className = "sv-btn";
    subBtn.textContent = "CC Phụ đề (.srt)";
    subBtn.onclick = () => {
      const st0 = v.subtitles[0];
      chrome.runtime.sendMessage({ type: "downloadSubtitle", url: st0.url, format: st0.format, meta: { id: v.id, title: v.title, author: v.owner, platform: v.platform, quality: st0.lang || "sub" } });
    };
    foot.appendChild(subBtn);
  }
  $("previewModal").hidden = false;
}

$("pvClose").addEventListener("click", closePreviewModal);
$("previewModal").addEventListener("click", (e) => {
  if (e.target === $("previewModal")) closePreviewModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("previewModal").hidden) closePreviewModal();
});

function renderLibrary() {
  const completedIds = CORE.getCompletedVideoIds(dmJobs, dmArchivedIds);
  const list = getDedupedLibraryVideos();
  $("navLibCount").textContent = String(list.length);
  $("libStats").textContent = `${list.length} video`;
  const selCount = list.filter((v) => libSelected.has(v.id)).length;
  $("libSelectAll").checked = list.length > 0 && selCount === list.length;
  if (selCount > 0) {
    $("libDownloadSelected").textContent = `⬇ Tải đã chọn (${selCount})`;
  } else if ($("libSkipDup").checked) {
    const newCnt = list.filter((v) => !completedIds.has(String(v.id))).length;
    $("libDownloadSelected").textContent = newCnt < list.length ? `⬇ Tải mới (${newCnt}/${list.length})` : `⬇ Tải tất cả (${list.length})`;
  } else {
    $("libDownloadSelected").textContent = `⬇ Tải tất cả (${list.length})`;
  }

  const grid = $("libGrid");
  const moreWrap = $("libMoreWrap");
  grid.innerHTML = "";
  moreWrap.innerHTML = "";
  $("libEmpty").hidden = list.length > 0;
  if (!list.length) return;

  const shown = list.slice(0, libRenderLimit);
  const frag = document.createDocumentFragment();
  for (const v of shown) {
    const active = !!(liveActiveId && (v.id === liveActiveId || (v.code && v.code === liveActiveId)));
    const pInfo = CORE.platformInfo(v.platform);
    const isDone = completedIds.has(String(v.id));

    const card = document.createElement("article");
    card.className = "lib-card" + (active ? " current" : "");

    // Top 16:9 cover
    const cover = document.createElement("div");
    cover.className = "lib-cover";
    if (v.thumb) {
      const img = document.createElement("img");
      img.className = "lib-thumb";
      img.loading = "lazy";
      img.src = v.thumb;
      img.addEventListener("error", () => img.replaceWith(playPlaceholder()), { once: true });
      cover.appendChild(img);
    } else {
      cover.appendChild(playPlaceholder());
    }

    const tl = document.createElement("div");
    tl.className = "lib-cover-tl";
    tl.appendChild(pillEl(pInfo.pill, pInfo.name));
    if (active) tl.appendChild(pillEl("accent", "▶ Đang chạy"));
    cover.appendChild(tl);

    if (isDone) {
      const tr = document.createElement("div");
      tr.className = "lib-cover-tr";
      tr.appendChild(pillEl("success", "✓ Đã tải"));
      cover.appendChild(tr);
    }

    const dur = CORE.fmtDuration(v.duration);
    if (dur) {
      const d = document.createElement("span");
      d.className = "lib-dur";
      d.textContent = dur;
      cover.appendChild(d);
    }
    const pvTag = document.createElement("span");
    pvTag.className = "lib-play-badge";
    pvTag.textContent = "▶ Xem trước";
    cover.appendChild(pvTag);
    cover.onclick = () => openPreviewModal(v);
    card.appendChild(cover);

    // Body
    const body = document.createElement("div");
    body.className = "lib-body";

    const titleRow = document.createElement("div");
    titleRow.className = "lib-title-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "sv-check";
    cb.checked = libSelected.has(v.id);
    cb.onchange = () => {
      if (cb.checked) libSelected.add(v.id);
      else libSelected.delete(v.id);
      renderLibrary();
    };
    titleRow.appendChild(cb);

    const title = document.createElement("div");
    title.className = "lib-title";
    title.textContent = v.title || `Video ${v.id}`;
    titleRow.appendChild(title);
    body.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "lib-meta";
    meta.textContent = [v.owner, `ID: ${v.id}`, CORE.sanitizeUrl(v._sourceUrl)].filter(Boolean).join(" · ");
    body.appendChild(meta);

    const badges = document.createElement("div");
    badges.className = "lib-badges";
    const kindLabel =
      v.transferType === "carousel"
        ? `Album (${v.images.length} ảnh · ${v.carouselVideos.length} clip)`
        : v.transferType === "slideshow"
        ? `Slideshow (${v.images.length} ảnh)`
        : v.transferType === "dash"
        ? "DASH Mux"
        : "Direct MP4";
    badges.appendChild(pillEl(v.transferType === "direct" ? "success" : "purple", kindLabel));
    if (v.isStory) badges.appendChild(pillEl("pink", "Story"));
    badges.appendChild(pillEl("", `Best: ${v.bestLabel}`));
    if (v.sizeLabel) badges.appendChild(pillEl("", v.sizeLabel));
    if (v.codecBadge) {
      badges.appendChild(
        pillEl(v.codecCompat === "warn" ? "warn" : "", `${v.codecBadge}${v.codecCompat === "warn" ? " ⚠" : ""}`, v.codecNote || v.codecBadge)
      );
    }
    for (const r of v.resolutions.slice(0, 3)) badges.appendChild(pillEl("", r.label));
    body.appendChild(badges);

    const actions = document.createElement("div");
    actions.className = "lib-actions";
    const dlBtn = document.createElement("button");
    dlBtn.className = "sv-btn sv-btn-primary";
    dlBtn.textContent =
      (v.hasImages || (v.carouselVideos && v.carouselVideos.length > 1)) && !v.hd
        ? settings.zipSlideshow !== false
          ? `📦 Tải Album (.zip)`
          : `🖼 Tải ${v.images ? v.images.length : 0} ảnh`
        : "⬇ Tải xuống";
    dlBtn.onclick = async () => {
      const specs = buildJobSpecs(v);
      if (!specs.length) return;
      if (specs.length === 1 && specs[0].zipItems) {
        await chrome.runtime.sendMessage({ type: "zipSlideshow", entries: specs[0].zipItems, name: specs[0].name, meta: specs[0].meta, tabId: initialTabId });
      } else if (specs.length === 1 && specs[0].vUrl) {
        await chrome.runtime.sendMessage({ type: "openMerge", ...specs[0], tabId: initialTabId });
      } else if (specs.length === 1) {
        await chrome.runtime.sendMessage({ type: "download", url: specs[0].url, filename: specs[0].filename, meta: specs[0].meta, tabId: initialTabId });
      } else {
        await chrome.runtime.sendMessage({ type: "enqueueBatch", items: specs, tabId: initialTabId });
      }
      loadJobs();
    };
    actions.appendChild(dlBtn);

    const pvBtn = document.createElement("button");
    pvBtn.className = "sv-btn";
    pvBtn.textContent = "▶ Xem";
    pvBtn.title = "Xem trước trực tiếp";
    pvBtn.onclick = () => openPreviewModal(v);
    actions.appendChild(pvBtn);

    if (v.musicUrl) {
      const mBtn = document.createElement("button");
      mBtn.className = "sv-btn";
      mBtn.textContent = "🎵 MP3";
      mBtn.onclick = async () => {
        const mm = { id: v.id, title: v.musicTitle || v.title, author: v.owner, platform: v.platform, quality: "music", ext: "mp3", sourceUrl: v._sourceUrl };
        await chrome.runtime.sendMessage({ type: "download", url: v.musicUrl, filename: CORE.formatFilename(settings, mm), meta: mm, tabId: initialTabId });
        loadJobs();
      };
      actions.appendChild(mBtn);
    }

    if (v.hasSubtitles) {
      const sBtn = document.createElement("button");
      sBtn.className = "sv-btn";
      sBtn.textContent = "CC";
      sBtn.title = `Tải phụ đề (.srt · ${v.subtitles[0].lang || ""})`;
      sBtn.onclick = () => {
        const st0 = v.subtitles[0];
        chrome.runtime.sendMessage({ type: "downloadSubtitle", url: st0.url, format: st0.format, meta: { id: v.id, title: v.title, author: v.owner, platform: v.platform, quality: st0.lang || "sub" } });
        sBtn.textContent = "✓";
        setTimeout(() => (sBtn.textContent = "CC"), 1400);
      };
      actions.appendChild(sBtn);
    }

    const copyUrl = v.hd || v.sd || (v.dashVideo && v.dashVideo.url);
    if (copyUrl) {
      const cpBtn = document.createElement("button");
      cpBtn.className = "sv-btn";
      cpBtn.textContent = "📋";
      cpBtn.title = "Copy URL";
      cpBtn.onclick = () => {
        navigator.clipboard?.writeText(copyUrl).catch(() => {});
        cpBtn.textContent = "✓";
        setTimeout(() => (cpBtn.textContent = "📋"), 1400);
      };
      actions.appendChild(cpBtn);
    }

    const moreWrap = document.createElement("div");
    moreWrap.className = "more-wrap";
    const moreBtn = document.createElement("button");
    moreBtn.className = "sv-btn";
    moreBtn.textContent = "⋯";
    const menu = document.createElement("div");
    menu.className = "more-menu";
    menu.hidden = true;
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".more-menu").forEach((m) => { if (m !== menu) m.hidden = true; });
      menu.hidden = !menu.hidden;
    };
    if (v.hasDashMux) {
      const b = document.createElement("button");
      b.textContent = "🎛 Mở trong Merge Studio";
      b.onclick = () =>
        chrome.runtime.sendMessage({
          type: "openMerge",
          forceStudio: true,
          vUrl: v.dashVideo.url,
          vInitUrl: v.dashVideo.initUrl || "",
          vSegments: v.dashVideo.segments || null,
          aUrl: v.dashAudio.url,
          aInitUrl: v.dashAudio.initUrl || "",
          aSegments: v.dashAudio.segments || null,
          name: CORE.safeName(v.title) || v.id,
          meta: { id: v.id, title: v.title, author: v.owner, platform: v.platform },
        });
      menu.appendChild(b);
    }
    if (v.dashVideo) {
      const b = document.createElement("button");
      b.textContent = "🎬 Tải chỉ hình";
      b.onclick = () => chrome.runtime.sendMessage({ type: "download", url: v.dashVideo.url, filename: CORE.formatFilename(settings, { id: v.id, title: v.title, author: v.owner, platform: v.platform, quality: "video_only" }) });
      menu.appendChild(b);
    }
    if (v.dashAudio) {
      const b = document.createElement("button");
      b.textContent = "🔊 Tải chỉ tiếng (.m4a)";
      b.onclick = () => chrome.runtime.sendMessage({ type: "download", url: v.dashAudio.url, filename: CORE.formatFilename(settings, { id: v.id, title: v.title, author: v.owner, platform: v.platform, quality: "audio", ext: "m4a" }) });
      menu.appendChild(b);
    }
    const safeCardSrc = CORE.safeHttpUrl(v._sourceUrl);
    if (safeCardSrc) {
      const b = document.createElement("button");
      b.textContent = "🔗 Mở trang gốc";
      b.onclick = () => chrome.tabs.create({ url: safeCardSrc });
      menu.appendChild(b);
    }
    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(menu);
    actions.appendChild(moreWrap);
    body.appendChild(actions);

    card.appendChild(body);
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  if (list.length > shown.length) {
    const moreBtn = document.createElement("button");
    moreBtn.className = "sv-btn";
    moreBtn.textContent = `⬇ Xem thêm (còn ${list.length - shown.length} video)`;
    moreBtn.onclick = () => {
      libRenderLimit += 48;
      renderLibrary();
    };
    moreWrap.appendChild(moreBtn);
  }
}

document.addEventListener("click", () => document.querySelectorAll(".more-menu").forEach((m) => (m.hidden = true)));
["libSearch", "libTabFilter", "libPlatFilter", "libResFilter", "libStatusFilter", "libSort"].forEach((id) =>
  $(id).addEventListener("input", () => {
    libRenderLimit = 48;
    renderLibrary();
  })
);
$("libRefresh").addEventListener("click", loadLibrarySources);
$("libSelectAll").addEventListener("change", () => {
  const list = getDedupedLibraryVideos();
  if ($("libSelectAll").checked) list.forEach((v) => libSelected.add(v.id));
  else list.forEach((v) => libSelected.delete(v.id));
  renderLibrary();
});
$("libSkipDup").addEventListener("change", async () => {
  settings = await CORE.saveSettings({ skipDuplicates: $("libSkipDup").checked });
  $("s_skipDuplicates").checked = settings.skipDuplicates;
  renderLibrary();
});
$("libDownloadSelected").addEventListener("click", async () => {
  const list = getDedupedLibraryVideos();
  const completedIds = CORE.getCompletedVideoIds(dmJobs, dmArchivedIds);
  const picked = list.filter((v) => libSelected.has(v.id));
  const usePicked = picked.length > 0;
  let targets = usePicked ? picked : list;
  if (!usePicked && $("libSkipDup").checked) {
    targets = list.filter((v) => !completedIds.has(String(v.id)));
  }
  const items = targets.flatMap((v) => buildJobSpecs(v));
  if (!items.length) return;
  await chrome.runtime.sendMessage({ type: "enqueueBatch", items, tabId: initialTabId });
  switchView("downloads");
});

// ================= DOWNLOAD MANAGER =================
async function loadArchive() {
  const res = await chrome.runtime.sendMessage({ type: "getArchive" }).catch(() => ({ jobs: [], videoIds: [] }));
  dmArchivedJobs = (res && res.jobs) || [];
  $("cntArchive").textContent = String(dmArchivedJobs.length);
  if (dmFilter === "archive") renderDownloads();
}

async function loadJobs() {
  const [res, arch] = await Promise.all([
    chrome.runtime.sendMessage({ type: "getJobs" }).catch(() => ({ jobs: [], archivedIds: [] })),
    chrome.runtime.sendMessage({ type: "getArchive" }).catch(() => ({ jobs: [], videoIds: [] })),
  ]);
  dmJobs = (res && res.jobs) || [];
  dmArchivedIds = (res && res.archivedIds) || [];
  dmArchivedJobs = (arch && arch.jobs) || [];
  const archIds = new Set([...dmArchivedIds, ...((arch && arch.videoIds) || [])]);
  dmArchivedIds = Array.from(archIds);
  if ($("archiveCountBadge")) $("archiveCountBadge").textContent = String(dmArchivedIds.length);
  $("cntArchive").textContent = String(dmArchivedJobs.length);
  renderDownloads();
}

function setDmFilter(status) {
  dmFilter = status;
  $("dmTabs").querySelectorAll(".sv-chip").forEach((c) => c.classList.toggle("active", c.dataset.status === status));
  $("dmArchiveBar").hidden = status !== "archive";
  if (status === "archive") loadArchive();
  else renderDownloads();
}

function renderDownloads() {
  const active = dmJobs.filter((j) => j.status === "downloading" || j.status === "muxing" || j.status === "paused");
  const queued = dmJobs.filter((j) => j.status === "queued");
  const done = dmJobs.filter((j) => j.status === "completed");
  const failed = dmJobs.filter((j) => j.status === "failed" || j.status === "cancelled");

  $("cntAll").textContent = dmJobs.length;
  $("cntActive").textContent = active.length;
  $("cntQueued").textContent = queued.length;
  $("cntDone").textContent = done.length;
  $("cntFailed").textContent = failed.length;
  $("cntArchive").textContent = dmArchivedJobs.length;
  $("navDlCount").textContent = active.length + queued.length;
  $("dmArchiveBar").hidden = dmFilter !== "archive";

  const container = $("dmList");
  container.innerHTML = "";

  if (dmFilter === "archive") {
    const aq = ($("dmArchiveSearch").value || "").trim().toLowerCase();
    const list = dmArchivedJobs.filter((j) => !aq || `${j.filename || ""} ${j.title || ""} ${j.author || ""} ${j.videoId || ""}`.toLowerCase().includes(aq));
    $("dmEmpty").hidden = list.length > 0;
    if (!list.length) return;
    const frag = document.createDocumentFragment();
    for (const j of list.slice(0, 200)) {
      const row = document.createElement("div");
      row.className = "dm-row";
      const pInfo = CORE.platformInfo(j.platform);
      const top = document.createElement("div");
      top.className = "dm-top";
      const tDiv = document.createElement("div");
      tDiv.className = "dm-title";
      tDiv.textContent = j.filename || j.title || "";
      const wAct = document.createElement("div");
      wAct.className = "ws-actions";
      wAct.appendChild(pillEl(pInfo.pill, `${pInfo.short} · ${j.quality || "MP4"}`));
      wAct.appendChild(pillEl("success", "Kho lưu"));
      top.appendChild(tDiv);
      top.appendChild(wAct);
      row.appendChild(top);
      const stats = document.createElement("div");
      stats.className = "dm-stats";
      stats.textContent = [j.author, j.videoId ? `ID: ${j.videoId}` : "", j.bytesReceived ? CORE.fmtBytes(j.bytesReceived) : "", j.completedAt ? new Date(j.completedAt).toLocaleString() : ""].filter(Boolean).join(" · ");
      row.appendChild(stats);
      const safeSrc = CORE.safeHttpUrl(j.sourceUrl);
      if (safeSrc) {
        const acts = document.createElement("div");
        acts.className = "dm-actions";
        const openBtn = document.createElement("button");
        openBtn.className = "sv-btn";
        openBtn.textContent = "🔗 Mở bài gốc";
        openBtn.onclick = () => chrome.tabs.create({ url: safeSrc });
        acts.appendChild(openBtn);
        row.appendChild(acts);
      }
      frag.appendChild(row);
    }
    container.appendChild(frag);
    return;
  }

  const shown = dmJobs.filter((j) => {
    if (dmFilter === "active") return j.status === "downloading" || j.status === "muxing" || j.status === "paused";
    if (dmFilter === "queued") return j.status === "queued";
    if (dmFilter === "completed") return j.status === "completed";
    if (dmFilter === "failed") return j.status === "failed" || j.status === "cancelled";
    return true;
  });

  $("dmEmpty").hidden = shown.length > 0;
  if (!shown.length) return;

  const frag = document.createDocumentFragment();
  for (const j of shown) {
    const row = document.createElement("div");
    row.className = "dm-row";

    const pct = j.totalBytes > 0 ? Math.min(100, Math.round((j.bytesReceived / j.totalBytes) * 100)) : j.status === "completed" ? 100 : 0;
    const statusLabel = {
      queued: "Đang chờ",
      downloading: "Đang tải",
      muxing: "Đang ghép MP4",
      paused: "Tạm dừng",
      completed: "Hoàn tất",
      failed: "Lỗi",
      cancelled: "Đã hủy",
    }[j.status] || j.status;

    const pillCls = j.status === "completed" ? "success" : j.status === "failed" ? "error" : j.status === "paused" ? "warn" : j.kind === "dash" ? "purple" : "accent";
    const pInfo = CORE.platformInfo(j.platform);

    const top = document.createElement("div");
    top.className = "dm-top";
    const tDiv = document.createElement("div");
    tDiv.className = "dm-title";
    tDiv.textContent = j.filename || "";
    const wAct = document.createElement("div");
    wAct.className = "ws-actions";
    wAct.appendChild(pillEl(pInfo.pill, `${pInfo.short} · ${j.quality || "MP4"}`));
    wAct.appendChild(pillEl(pillCls, statusLabel));
    top.appendChild(tDiv);
    top.appendChild(wAct);
    row.appendChild(top);

    const bar = document.createElement("div");
    bar.className = "dm-bar";
    const fill = document.createElement("div");
    fill.style.width = pct + "%";
    if (j.status === "completed") fill.className = "done";
    if (j.status === "failed") fill.className = "err";
    bar.appendChild(fill);
    row.appendChild(bar);

    const stats = document.createElement("div");
    stats.className = "dm-stats";
    const parts = [
      `${pct}%`,
      j.totalBytes > 0 ? `${CORE.fmtBytes(j.bytesReceived)} / ${CORE.fmtBytes(j.totalBytes)}` : j.bytesReceived > 0 ? CORE.fmtBytes(j.bytesReceived) : "",
      j.speedBps > 0 ? `${CORE.fmtBytes(j.speedBps)}/s` : "",
      j.etaSec ? `Còn ~${CORE.fmtEta(j.etaSec)}` : "",
      j.error ? `⚠ ${j.error}` : "",
    ].filter(Boolean);
    stats.textContent = parts.join(" · ");
    row.appendChild(stats);

    const acts = document.createElement("div");
    acts.className = "dm-actions";
    const actBtn = (label, action, dir, cls) => {
      const b = document.createElement("button");
      b.className = "sv-btn " + (cls || "");
      b.textContent = label;
      b.onclick = async () => {
        const res = await chrome.runtime.sendMessage({ type: "jobAction", action, jobId: j.id, dir });
        if (res && res.jobs) { dmJobs = res.jobs; renderDownloads(); }
      };
      return b;
    };

    if (j.kind === "direct" && j.status === "downloading") acts.appendChild(actBtn("⏸ Tạm dừng", "pause"));
    if (j.kind === "direct" && j.status === "paused" && j.canResume) acts.appendChild(actBtn("▶ Tiếp tục", "resume", null, "sv-btn-primary"));
    if (j.status === "queued") {
      acts.appendChild(actBtn("⏫ Ưu tiên đầu", "move", "top"));
      acts.appendChild(actBtn("↑", "move", "up"));
      acts.appendChild(actBtn("↓", "move", "down"));
    }
    if (j.status === "downloading" || j.status === "queued" || j.status === "paused") acts.appendChild(actBtn("✕ Hủy", "cancel", null, "sv-btn-danger"));
    if (j.status === "failed" || j.status === "cancelled") acts.appendChild(actBtn("↻ Thử lại", "retry", null, "sv-btn-primary"));
    if (j.status === "failed" && j.videoId) {
      const refBtn = document.createElement("button");
      refBtn.className = "sv-btn sv-btn-purple";
      refBtn.textContent = "↻ Lấy lại link mới";
      refBtn.onclick = async () => {
        refBtn.disabled = true;
        refBtn.textContent = "⏳ Đang quét tab gốc...";
        const res = await chrome.runtime.sendMessage({ type: "jobAction", action: "refreshUrl", jobId: j.id });
        if (res && res.jobs) {
          dmJobs = res.jobs;
          if (!res.ok && res.error) {
            const cur = dmJobs.find((x) => x.id === j.id);
            if (cur) cur.error = res.error;
          }
          renderDownloads();
        }
      };
      acts.appendChild(refBtn);
    }
    if (j.status === "completed" && j.chromeDownloadId != null) {
      acts.appendChild(actBtn("📂 Hiện file", "showFile"));
    }
    if (j.status === "failed" && j.kind === "dash" && j.vUrl && j.aUrl) {
      const stBtn = document.createElement("button");
      stBtn.className = "sv-btn";
      stBtn.textContent = "🎛 Merge Studio";
      stBtn.onclick = () =>
        chrome.runtime.sendMessage({
          type: "openMerge",
          forceStudio: true,
          vUrl: j.vUrl,
          vInitUrl: j.vInitUrl || "",
          vSegments: j.vSegments || null,
          aUrl: j.aUrl,
          aInitUrl: j.aInitUrl || "",
          aSegments: j.aSegments || null,
          name: CORE.safeName(j.title) || j.videoId || "video",
          meta: { id: j.videoId, title: j.title, author: j.author, platform: j.platform },
        });
      acts.appendChild(stBtn);
    }
    acts.appendChild(actBtn("🗑 Xóa", "remove"));
    row.appendChild(acts);

    frag.appendChild(row);
  }
  container.appendChild(frag);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("dmTabs").addEventListener("click", (e) => {
  const b = e.target.closest(".sv-chip");
  if (b) setDmFilter(b.dataset.status);
});
$("dmKpis").addEventListener("click", (e) => {
  const b = e.target.closest(".dm-kpi");
  if (b) setDmFilter(b.dataset.status);
});

$("dmConcurrency").addEventListener("change", async () => {
  settings = await CORE.saveSettings({ maxConcurrent: Number($("dmConcurrency").value) });
  $("s_maxConcurrent").value = String(settings.maxConcurrent);
});
$("dmOpenFolder").addEventListener("click", () => chrome.downloads.showDefaultFolder && chrome.downloads.showDefaultFolder());
$("dmArchiveSearch").addEventListener("input", renderDownloads);
$("dmArchiveClear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "jobAction", action: "clearArchive" });
  dmArchivedJobs = [];
  dmArchivedIds = [];
  if ($("archiveCountBadge")) $("archiveCountBadge").textContent = "0";
  renderDownloads();
  renderLibrary();
});

$("dmExportJson").addEventListener("click", async () => {
  const arch = await chrome.runtime.sendMessage({ type: "getArchive" }).catch(() => ({ jobs: [] }));
  const all = CORE.mergeImportedJobs(dmJobs, (arch && arch.jobs) || []).jobs.map((j) => Object.assign({}, j, { blobUrl: "" }));
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `streamvault-history-${new Date().toISOString().slice(0, 10)}.json`, saveAs: true });
});
$("dmExportCsv").addEventListener("click", async () => {
  const arch = await chrome.runtime.sendMessage({ type: "getArchive" }).catch(() => ({ jobs: [] }));
  const all = CORE.mergeImportedJobs(dmJobs, (arch && arch.jobs) || []).jobs;
  const csv = CORE.jobsToCsv(all);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `streamvault-history-${new Date().toISOString().slice(0, 10)}.csv`, saveAs: true });
});
$("dmImportJson").addEventListener("click", () => $("dmImportFile").click());
$("dmImportFile").addEventListener("change", async () => {
  const f = $("dmImportFile").files && $("dmImportFile").files[0];
  $("dmImportFile").value = "";
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.jobs) ? parsed.jobs : [];
    const res = await chrome.runtime.sendMessage({ type: "jobAction", action: "import", jobs: arr });
    if (res && res.jobs) {
      dmJobs = res.jobs;
      renderDownloads();
      renderLibrary();
    }
  } catch (e) {}
});

$("dmRetryFailed").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "jobAction", action: "retryAllFailed" });
  if (res && res.jobs) { dmJobs = res.jobs; renderDownloads(); }
});
$("dmClearDone").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "jobAction", action: "clearCompleted" });
  if (res && res.jobs) { dmJobs = res.jobs; renderDownloads(); }
});
$("dmClearFailed").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "jobAction", action: "clearFailed" });
  if (res && res.jobs) { dmJobs = res.jobs; renderDownloads(); }
});

// ================= SETTINGS CENTER =================
const SETTING_KEYS = [
  "quality", "subfolder", "subfolderName", "autoClose", "filenameFormat", "saveSidecarTxt", "saveSubtitles",
  "maxConcurrent", "retryLimit", "silentDashMerge", "zipSlideshow", "skipDuplicates", "notifications", "defaultBehavior",
  "autoScan", "autoScrollIntervalMs", "autoScrollLimit", "autoScrollStopOnDup", "autoScrollAutoDownload", "showNetworkFallback", "diagnosticsEnabled",
  "theme", "density", "reducedMotion",
];

function bindSettingsForm(s) {
  for (const k of SETTING_KEYS) {
    const el = $("s_" + k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = String(s[k]);
  }
  $("dmConcurrency").value = String(s.maxConcurrent);
  $("libSkipDup").checked = s.skipDuplicates !== false;
}

$("folderPresets").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tpl]");
  if (!b) return;
  $("s_subfolder").checked = true;
  $("s_subfolderName").value = b.dataset.tpl;
  settings = await CORE.saveSettings({ subfolder: true, subfolderName: b.dataset.tpl });
  $("settingsSavedMsg").hidden = false;
  setTimeout(() => ($("settingsSavedMsg").hidden = true), 1500);
});

$("filenamePresets").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-fntpl]");
  if (!b) return;
  $("s_filenameFormat").value = b.dataset.fntpl;
  settings = await CORE.saveSettings({ filenameFormat: b.dataset.fntpl });
  $("settingsSavedMsg").hidden = false;
  setTimeout(() => ($("settingsSavedMsg").hidden = true), 1500);
});

for (const k of SETTING_KEYS) {
  const el = $("s_" + k);
  if (!el) continue;
  el.addEventListener("change", async () => {
    const val = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
    settings = await CORE.saveSettings({ [k]: val });
    CORE.applyAppearance(settings);
    $("dmConcurrency").value = String(settings.maxConcurrent);
    $("settingsSavedMsg").hidden = false;
    setTimeout(() => ($("settingsSavedMsg").hidden = true), 1500);
  });
}

async function loadLogs() {
  const r = await chrome.storage.local.get("sv_logs");
  const logs = Array.isArray(r.sv_logs) ? r.sv_logs : [];
  $("diagLogs").textContent = logs.length
    ? logs.map((l) => `[${new Date(l.ts).toLocaleString()}] [${l.level.toUpperCase()}] (${l.source}) ${l.message}${l.extra ? " " + JSON.stringify(l.extra) : ""}`).join("\n")
    : "Chưa có log chẩn đoán.";
}

$("clearLogs").addEventListener("click", async () => {
  await chrome.storage.local.set({ sv_logs: [] });
  loadLogs();
});
$("clearArchive").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "jobAction", action: "clearArchive" });
  dmArchivedIds = [];
  dmArchivedJobs = [];
  if ($("archiveCountBadge")) $("archiveCountBadge").textContent = "0";
  renderDownloads();
  renderLibrary();
});

$("exportDiag").addEventListener("click", async () => {
  const r = await chrome.storage.local.get(["settings", "sv_logs", "sv_jobs"]);
  const manifest = chrome.runtime.getManifest();
  const payload = CORE.sanitizeDiagnostics({
    exportedAt: new Date().toISOString(),
    version: manifest.version,
    settings: r.settings,
    jobSummary: { total: (r.sv_jobs || []).length },
    logs: r.sv_logs || [],
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: "streamvault-diagnostics.json", saveAs: true });
});

$("resetSettings").addEventListener("click", async () => {
  settings = CORE.migrateSettings(CORE.DEFAULT_SETTINGS);
  await chrome.storage.local.set({ settings });
  CORE.applyAppearance(settings);
  bindSettingsForm(settings);
  $("settingsSavedMsg").hidden = false;
  setTimeout(() => ($("settingsSavedMsg").hidden = true), 1500);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.sv_jobs || changes.sv_archived_ids)) {
    if (changes.sv_jobs) dmJobs = changes.sv_jobs.newValue || [];
    if (changes.sv_archived_ids) {
      dmArchivedIds = changes.sv_archived_ids.newValue || [];
      if ($("archiveCountBadge")) $("archiveCountBadge").textContent = String(dmArchivedIds.length);
    }
    renderDownloads();
    renderLibrary();
  }
});

// Init
(async function init() {
  settings = await CORE.loadSettings();
  CORE.applyAppearance(settings);
  bindSettingsForm(settings);
  await Promise.all([loadLibrarySources(), loadJobs()]);
  const h = (location.hash || "#library").replace("#", "");
  switchView(["library", "downloads", "settings"].includes(h) ? h : "library");
  document.body.dataset.svReady = "1";
  setInterval(() => {
    if (dmJobs.some((j) => j.status === "downloading" || j.status === "muxing")) loadJobs();
  }, 800);
})();
