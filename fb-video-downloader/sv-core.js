// StreamVault V2 — Shared Core: Settings migration, video normalization, filename formatting, sanitized diagnostics.
// Works in Service Worker (importScripts), Extension pages (<script>), and Node.js (tests).
(function (root) {
  const DEFAULT_SETTINGS = {
    version: 2,
    // GENERAL (giữ top-level quality / subfolder / autoClose để tương thích ngược V1)
    quality: "hd",
    subfolder: false,
    subfolderName: "FB_TikTok_Videos",
    autoClose: true,
    filenameFormat: "{title}_{id}_{quality}",
    saveSidecarTxt: false,
    saveSubtitles: false,
    // DOWNLOADS
    maxConcurrent: 3,
    retryLimit: 2,
    skipDuplicates: true,
    silentDashMerge: true,
    zipSlideshow: true,
    notifications: true,
    defaultBehavior: "auto",
    // DETECTION
    autoScan: true,
    autoScrollIntervalMs: 1300,
    autoScrollLimit: 0,
    autoScrollStopOnDup: false,
    autoScrollAutoDownload: false,
    showNetworkFallback: true,
    diagnosticsEnabled: true,
    // APPEARANCE
    theme: "dark",
    density: "comfortable",
    reducedMotion: false,
  };

  function migrateSettings(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = Object.assign({}, DEFAULT_SETTINGS, src, { version: 2 });
    if (out.quality !== "hd" && out.quality !== "sd") out.quality = "hd";
    out.subfolder = !!out.subfolder;
    out.subfolderName = safeFolder(out.subfolderName) || "FB_TikTok_Videos";
    out.filenameFormat = String(out.filenameFormat || "{title}_{id}_{quality}").trim().slice(0, 80) || "{title}_{id}_{quality}";
    out.autoClose = src.autoClose !== false;
    out.saveSidecarTxt = !!src.saveSidecarTxt;
    out.saveSubtitles = !!src.saveSubtitles;
    out.maxConcurrent = Math.max(1, Math.min(5, Number(out.maxConcurrent) || 3));
    out.retryLimit = Math.max(0, Math.min(5, Number.isFinite(+out.retryLimit) ? +out.retryLimit : 2));
    out.skipDuplicates = src.skipDuplicates !== false;
    out.silentDashMerge = src.silentDashMerge !== false;
    out.zipSlideshow = src.zipSlideshow !== false;
    out.autoScrollIntervalMs = Math.max(700, Math.min(4000, Number(out.autoScrollIntervalMs) || 1300));
    out.autoScrollLimit = Math.max(0, Math.min(200, Number(out.autoScrollLimit) || 0));
    out.autoScrollStopOnDup = !!src.autoScrollStopOnDup;
    out.autoScrollAutoDownload = !!src.autoScrollAutoDownload;
    if (!["dark", "light", "system"].includes(out.theme)) out.theme = "dark";
    if (!["comfortable", "compact"].includes(out.density)) out.density = "comfortable";
    out.reducedMotion = !!out.reducedMotion;
    return out;
  }

  function safeName(s, max = 80) {
    return String(s || "")
      .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^\.+|\.+$/g, "")
      .trim()
      .slice(0, max);
  }

  function safeFolder(s) {
    return String(s || "")
      .replace(/[\u0000-\u001f\\:*?"<>|]+/g, "")
      .replace(/\.\./g, "")
      .split("/")
      .map((seg) => seg.replace(/^\.+|\.+$/g, "").trim())
      .filter(Boolean)
      .join("/")
      .slice(0, 96);
  }

  const PLATFORMS = {
    facebook: { name: "Facebook", short: "FB", pill: "accent", tag: "" },
    tiktok: { name: "TikTok", short: "TT", pill: "purple", tag: "tt" },
    instagram: { name: "Instagram", short: "IG", pill: "pink", tag: "ig" },
    threads: { name: "Threads", short: "TH", pill: "threads", tag: "th" },
    douyin: { name: "Douyin", short: "DY", pill: "cyan", tag: "dy" },
    x: { name: "X", short: "X", pill: "threads", tag: "x" },
    xiaohongshu: { name: "Xiaohongshu", short: "XHS", pill: "red", tag: "xhs" },
  };

  function platformInfo(plat) {
    return PLATFORMS[plat] || PLATFORMS.facebook;
  }

  function formatFolder(settings, meta) {
    const s = migrateSettings(settings);
    if (!s.subfolder) return "";
    const m = meta || {};
    const platformName = platformInfo(m.platform).name;
    const authorName = safeName(m.author, 40) || "Unknown";
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const resolved = String(s.subfolderName || "FB_TikTok_Videos")
      .replace(/\{platform\}/gi, platformName)
      .replace(/\{author\}/gi, authorName)
      .replace(/\{date\}/gi, dateStr);
    const clean = safeFolder(resolved);
    return clean ? clean + "/" : "";
  }

  function formatFilename(settings, meta) {
    const s = migrateSettings(settings);
    const m = meta || {};
    const platform = PLATFORMS[m.platform] ? m.platform : "facebook";
    const id = String(m.id || Date.now()).replace(/\W+/g, "");
    const title = safeName(m.title, 65);
    const author = safeName(m.author, 32);
    const quality = safeName(m.quality || "MP4", 16) || "MP4";
    const ext = safeName(m.ext || "mp4", 8) || "mp4";

    const tpl = String(s.filenameFormat || "{title}_{id}_{quality}");
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let base = "";
    if (tpl === "{title}_{id}_{quality}") {
      base = title ? `${title}_${id.slice(-6)}_${quality}` : `${platform}_${id}_${quality}`;
    } else if (tpl === "{author}_{title}_{quality}") {
      base = [author || platform, title || id, quality].filter(Boolean).join("_");
    } else if (tpl === "{platform}_{id}_{quality}") {
      base = `${platform}_${id}_${quality}`;
    } else {
      base = tpl
        .replace(/\{title\}/gi, () => title || id)
        .replace(/\{author\}/gi, () => author || platform)
        .replace(/\{platform\}/gi, () => platform)
        .replace(/\{shortid\}/gi, () => id.slice(-6) || id)
        .replace(/\{id\}/gi, () => id)
        .replace(/\{quality\}/gi, () => quality)
        .replace(/\{date\}/gi, () => dateStr)
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    }
    base = safeName(base, 110) || `${platform}_${id}`;
    const dir = formatFolder(s, m);
    return `${dir}${base}.${ext}`;
  }

  function getCompletedVideoIds(jobs, extraIds) {
    const set = new Set();
    for (const id of extraIds || []) {
      if (id) set.add(String(id));
    }
    for (const j of jobs || []) {
      if (!j || j.status !== "completed") continue;
      if (j.videoId) set.add(String(j.videoId));
    }
    return set;
  }

  function detectPlatform(v, pageUrl) {
    if (v && v.platform && PLATFORMS[v.platform]) return v.platform;
    const u = (v && (v.sourceUrl || v.hd || v.sd)) || pageUrl || "";
    if (/(^|\.|\/)(x\.com|twitter\.com|twimg\.com)/i.test(u)) return "x";
    if (/(xiaohongshu|xhscdn)\./i.test(u)) return "xiaohongshu";
    if (/douyin(vod)?\.|zjcdn\./i.test(u)) return "douyin";
    if (/threads\.(net|com)/i.test(u)) return "threads";
    if (/instagram\.com|cdninstagram\.com/i.test(u)) return "instagram";
    if (/tiktok(cdn|v)?\.|byteoversea\./i.test(u)) return "tiktok";
    return "facebook";
  }

  function codecInfo(rawCodec) {
    const raw = String(rawCodec || "").toLowerCase();
    if (!raw) return null;
    if (/hev1|hvc1|hevc|h\.?265/.test(raw)) {
      return { raw, family: "HEVC", label: "HEVC", compat: "warn", note: "H.265 — một số trình duyệt/trình dựng cũ có thể thiếu codec" };
    }
    if (/av01|\bav1\b/.test(raw)) {
      return { raw, family: "AV1", label: "AV1", compat: "warn", note: "AV1 — cần thiết bị/trình phát hỗ trợ giải mã AV1" };
    }
    if (/avc1|h\.?264|h264/.test(raw)) {
      return { raw, family: "H.264", label: "H.264", compat: "ok", note: "" };
    }
    if (/vp09|vp9/.test(raw)) {
      return { raw, family: "VP9", label: "VP9", compat: "ok", note: "" };
    }
    return { raw, family: raw.split(".")[0].toUpperCase(), label: raw.split(".")[0].toUpperCase(), compat: "ok", note: "" };
  }

  function safeHttpUrl(u) {
    if (typeof u !== "string") return "";
    const trimmed = u.trim();
    if (!trimmed) return "";
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch (e) {
      return "";
    }
  }

  // Chuẩn hóa thông tin video – chỉ liệt kê độ phân giải/codec thực sự phát hiện được.
  function normalizeVideo(v, pageUrl) {
    if (!v || !v.id) return null;
    const platform = detectPlatform(v, pageUrl);
    const hd = safeHttpUrl(v.hd);
    const sd = safeHttpUrl(v.sd);
    const thumb = safeHttpUrl(v.thumb);
    const sourceUrl = safeHttpUrl(v.sourceUrl);
    const musicUrl = safeHttpUrl(v.musicUrl);
    const dashVideo = v.dashVideo && safeHttpUrl(v.dashVideo.url)
      ? Object.assign({}, v.dashVideo, { url: safeHttpUrl(v.dashVideo.url), initUrl: safeHttpUrl(v.dashVideo.initUrl) || undefined })
      : null;
    const dashAudio = v.dashAudio && safeHttpUrl(v.dashAudio.url)
      ? Object.assign({}, v.dashAudio, { url: safeHttpUrl(v.dashAudio.url), initUrl: safeHttpUrl(v.dashAudio.initUrl) || undefined })
      : null;

    const resolutions = [];
    const pushRes = (label, url, kind, height) => {
      const safe = safeHttpUrl(url);
      if (!safe || resolutions.some((r) => r.url === safe)) return;
      resolutions.push({ label, url: safe, kind, height: height || 0 });
    };

    if (Array.isArray(v.variants)) {
      for (const vr of v.variants) {
        if (vr && vr.url) pushRes(vr.label || "MP4", vr.url, "direct", vr.height || 0);
      }
    }
    if (hd) pushRes(v.hdLabel || (platform === "tiktok" ? "No-Watermark" : "HD"), hd, "direct", v.hdHeight || 0);
    if (sd) pushRes(v.sdLabel || (platform === "tiktok" ? "Fallback" : "SD"), sd, "direct", v.sdHeight || 0);

    const hasDashMux = !!(dashVideo && dashVideo.url && dashAudio && dashAudio.url);
    const dashLabel = dashVideo && dashVideo.height ? `${dashVideo.height}p DASH` : "DASH Video+Audio";
    if (hasDashMux) {
      resolutions.push({
        label: dashLabel,
        url: dashVideo.url,
        audioUrl: dashAudio.url,
        initUrl: dashVideo.initUrl || "",
        segments: dashVideo.segments || null,
        audioInitUrl: dashAudio.initUrl || "",
        audioSegments: dashAudio.segments || null,
        kind: "dash",
        height: dashVideo.height || 0,
      });
    } else if (dashVideo && dashVideo.url) {
      pushRes(dashVideo.height ? `${dashVideo.height}p (No Audio)` : "Video Only", dashVideo.url, "video_only", dashVideo.height || 0);
    }

    const images = Array.isArray(v.images) ? v.images.map(safeHttpUrl).filter(Boolean) : [];
    const hasImages = images.length > 0;
    const carouselVideos = Array.isArray(v.carouselVideos)
      ? v.carouselVideos.filter((c) => c && safeHttpUrl(c.url)).map((c) => Object.assign({}, c, { url: safeHttpUrl(c.url), thumb: safeHttpUrl(c.thumb) }))
      : [];
    const hasCarousel = hasImages && (carouselVideos.length > 0 || images.length > 1);
    const hasAudio = !!(musicUrl || (dashAudio && dashAudio.url));
    const subtitles = Array.isArray(v.subtitles)
      ? v.subtitles.filter((st) => st && safeHttpUrl(st.url)).map((st) => Object.assign({}, st, { url: safeHttpUrl(st.url) }))
      : [];
    const hasSubtitles = subtitles.length > 0;
    if (!resolutions.length && !hasAudio && !hasImages && !carouselVideos.length) return null;

    let bestLabel = "Detected";
    if (hasImages && carouselVideos.length > 0 && !v.hd && !v.sd) {
      bestLabel = `${v.images.length} ảnh · ${carouselVideos.length} clip`;
    } else if (hasImages && !v.hd && !v.sd) {
      bestLabel = `${v.images.length} ảnh`;
    } else if (hasDashMux && (!v.hd || (v.dashVideo.height || 0) >= 720)) {
      bestLabel = v.dashVideo.height ? `${v.dashVideo.height}p` : "DASH";
    } else if (v.hd) {
      bestLabel = v.hdHeight ? `${v.hdHeight}p` : platform === "tiktok" ? "Best" : "HD";
    } else if (v.sd) {
      bestLabel = v.sdHeight ? `${v.sdHeight}p` : "SD";
    } else if (v.dashVideo) {
      bestLabel = v.dashVideo.height ? `${v.dashVideo.height}p` : "Video Only";
    } else if (carouselVideos.length) {
      bestLabel = `${carouselVideos.length} clip`;
    } else if (hasAudio) {
      bestLabel = "Audio Only";
    }

    const rawCodec = (v.dashVideo && v.dashVideo.codecs) || v.codec || "";
    const parsedCodec = codecInfo(rawCodec);

    let sizeBytes = 0;
    let sizeLabel = "";
    const durSec = v.duration && Number.isFinite(v.duration) ? v.duration / 1000 : 0;
    if (v.hdSize && Number(v.hdSize) > 0) {
      sizeBytes = Math.round(Number(v.hdSize));
      sizeLabel = fmtBytes(sizeBytes);
    } else if (hasDashMux && durSec > 0 && ((v.dashVideo.bandwidth || 0) + (v.dashAudio.bandwidth || 0)) > 0) {
      const bw = (v.dashVideo.bandwidth || 0) + (v.dashAudio.bandwidth || 0);
      sizeBytes = Math.round((bw * durSec) / 8);
      if (sizeBytes > 0) sizeLabel = "~" + fmtBytes(sizeBytes);
    } else {
      const br = Number(v.bitrate) || (Array.isArray(v.variants) && v.variants[0] && Number(v.variants[0].bitrate)) || 0;
      if (br > 0 && durSec > 0) {
        sizeBytes = Math.round((br * durSec) / 8);
        if (sizeBytes > 0) sizeLabel = "~" + fmtBytes(sizeBytes);
      }
    }

    return Object.assign({}, v, {
      platform,
      hd,
      sd,
      thumb,
      sourceUrl,
      musicUrl,
      dashVideo,
      dashAudio,
      images: images.length ? images : undefined,
      resolutions,
      hasDirect: !!(hd || sd),
      hasDashMux,
      hasImages,
      carouselVideos,
      hasCarousel,
      hasAudio,
      subtitles,
      hasSubtitles,
      isStory: !!v.isStory,
      sizeBytes,
      sizeLabel,
      codecBadge: parsedCodec ? parsedCodec.label : "",
      codecCompat: parsedCodec ? parsedCodec.compat : "ok",
      codecNote: parsedCodec ? parsedCodec.note : "",
      transferType:
        hasImages && !hd && !sd
          ? carouselVideos.length
            ? "carousel"
            : "slideshow"
          : hd || sd
          ? "direct"
          : hasDashMux
          ? "dash"
          : "partial",
      bestLabel,
    });
  }

  function sanitizeUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return `${u.origin}${u.pathname}`;
    } catch (e) {
      return rawUrl ? "[invalid-url]" : "";
    }
  }

  function sanitizeDiagnostics(data) {
    const clean = JSON.parse(JSON.stringify(data || {}));
    const walkClean = (o) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) {
        o.forEach(walkClean);
        return;
      }
      for (const k of Object.keys(o)) {
        if (/url|src|href/i.test(k) && typeof o[k] === "string" && o[k].startsWith("http")) {
          o[k] = sanitizeUrl(o[k]);
        } else if (typeof o[k] === "object") {
          walkClean(o[k]);
        }
      }
    };
    walkClean(clean);
    return clean;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  function fmtDuration(ms) {
    if (!ms || !Number.isFinite(ms)) return "";
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function fmtEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return "";
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  function applyAppearance(settings) {
    if (typeof document === "undefined") return;
    const s = migrateSettings(settings);
    const el = document.documentElement;
    el.setAttribute("data-theme", s.theme);
    el.setAttribute("data-density", s.density);
    el.setAttribute("data-reduced-motion", s.reducedMotion ? "true" : "false");
  }

  async function loadSettings() {
    if (typeof chrome === "undefined" || !chrome.storage) return migrateSettings({});
    const r = await chrome.storage.local.get("settings");
    return migrateSettings(r.settings);
  }

  let settingsLock = Promise.resolve();

  function saveSettings(partial) {
    const run = settingsLock.then(async () => {
      const cur = await loadSettings();
      const next = migrateSettings(Object.assign({}, cur, partial));
      await chrome.storage.local.set({ settings: next });
      return next;
    });
    settingsLock = run.catch(() => {});
    return run;
  }

  async function logEvent(level, source, message, extra) {
    if (typeof chrome === "undefined" || !chrome.storage) return;
    try {
      const s = await loadSettings();
      if (!s.diagnosticsEnabled) return;
      const r = await chrome.storage.local.get("sv_logs");
      const logs = Array.isArray(r.sv_logs) ? r.sv_logs : [];
      logs.unshift({
        ts: Date.now(),
        level: level || "info",
        source: source || "core",
        message: String(message || ""),
        extra: extra ? sanitizeDiagnostics(extra) : undefined,
      });
      await chrome.storage.local.set({ sv_logs: logs.slice(0, 150) });
    } catch (e) {}
  }

  function buildSidecarText(meta) {
    const m = meta || {};
    const plat = platformInfo(m.platform).name;
    const lines = [
      `Platform: ${plat}`,
      m.id ? `Video ID: ${m.id}` : "",
      m.author ? `Author: ${m.author}` : "",
      m.quality ? `Quality: ${m.quality}` : "",
      m.sourceUrl ? `Source URL: ${m.sourceUrl}` : "",
      `Saved At: ${new Date().toISOString()}`,
      "",
      m.title ? `Caption / Title:\n${m.title}` : "",
    ].filter((x, i, a) => x !== "" || (i > 0 && a[i - 1] !== ""));
    return lines.join("\n");
  }

  function jobsToCsv(jobs) {
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const head = ["id", "videoId", "platform", "status", "kind", "quality", "author", "filename", "bytesReceived", "totalBytes", "sourceUrl", "createdAt", "completedAt", "error"];
    const rows = [head.join(",")];
    for (const j of jobs || []) {
      if (!j) continue;
      rows.push(
        [
          j.id,
          j.videoId || "",
          j.platform || "",
          j.status || "",
          j.kind || "",
          j.quality || "",
          j.author || "",
          j.filename || "",
          j.bytesReceived || 0,
          j.totalBytes || 0,
          j.sourceUrl || "",
          j.createdAt ? new Date(j.createdAt).toISOString() : "",
          j.completedAt ? new Date(j.completedAt).toISOString() : "",
          j.error || "",
        ]
          .map(esc)
          .join(",")
      );
    }
    return "\uFEFF" + rows.join("\r\n");
  }

  function mergeImportedJobs(existing, incoming) {
    const out = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Set(out.map((j) => j.id || `${j.videoId}:${j.filename}`));
    let added = 0;
    for (const raw of Array.isArray(incoming) ? incoming : []) {
      if (!raw || typeof raw !== "object") continue;
      const key = raw.id || `${raw.videoId || ""}:${raw.filename || ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: raw.id || `imp_${Date.now()}_${added}`,
        videoId: raw.videoId ? String(raw.videoId) : "",
        kind: raw.kind || "direct",
        status: raw.status || "completed",
        url: safeHttpUrl(raw.url),
        vUrl: safeHttpUrl(raw.vUrl),
        aUrl: safeHttpUrl(raw.aUrl),
        filename: raw.filename || raw.title || "imported_video.mp4",
        title: raw.title || raw.filename || "",
        author: raw.author || "",
        platform: raw.platform || "facebook",
        quality: raw.quality || "MP4",
        sourceUrl: safeHttpUrl(raw.sourceUrl),
        bytesReceived: Number(raw.bytesReceived) || 0,
        totalBytes: Number(raw.totalBytes) || 0,
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        completedAt: raw.completedAt ? Number(raw.completedAt) : raw.status === "completed" ? Date.now() : null,
        error: raw.error || "",
      });
      added++;
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { jobs: out.slice(0, 500), added };
  }

  function vttToSrt(raw) {
    const s = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
    if (!s) return "";
    // Already looks like SubRip
    if (!/^WEBVTT/i.test(s) && /^\d+\n\d{2}:\d{2}:\d{2},\d{3}/.test(s)) return s + "\n";
    const blocks = s.split(/\n{2,}/);
    const cues = [];
    const tsRe = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})(.*)$/;
    const pad2 = (n) => String(Number(n) || 0).padStart(2, "0");
    let seq = 1;
    for (const b of blocks) {
      const lines = b.split("\n").map((l) => l.trimEnd());
      if (!lines.length || /^(WEBVTT|NOTE\b|STYLE\b|REGION\b)/i.test(lines[0])) continue;
      const ti = lines.findIndex((l) => tsRe.test(l.trim()));
      if (ti === -1) continue;
      const m = lines[ti].trim().match(tsRe);
      if (!m) continue;
      const start = `${pad2(m[1])}:${m[2]}:${m[3]},${m[4]}`;
      const end = `${pad2(m[5])}:${m[6]}:${m[7]},${m[8]}`;
      const body = lines
        .slice(ti + 1)
        .map((l) => l.replace(/<[^>]+>/g, "").trim())
        .filter(Boolean)
        .join("\n");
      if (!body) continue;
      cues.push(`${seq++}\n${start} --> ${end}\n${body}`);
    }
    return cues.length ? cues.join("\n\n") + "\n" : s;
  }

  const api = {
    DEFAULT_SETTINGS,
    PLATFORMS,
    platformInfo,
    migrateSettings,
    safeName,
    safeFolder,
    formatFolder,
    formatFilename,
    getCompletedVideoIds,
    detectPlatform,
    codecInfo,
    normalizeVideo,
    safeHttpUrl,
    sanitizeUrl,
    sanitizeDiagnostics,
    buildSidecarText,
    vttToSrt,
    jobsToCsv,
    mergeImportedJobs,
    fmtBytes,
    fmtDuration,
    fmtEta,
    applyAppearance,
    loadSettings,
    saveSettings,
    logEvent,
  };

  root.SV_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
