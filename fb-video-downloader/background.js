// StreamVault V2 — Background Service Worker:
// - Badge & passive webRequest stream capture (FB & TikTok)
// - Context menu & cross-tab Video Library cache
// - Persistent MV3 Download Manager Engine (concurrency, real speed/ETA, honest pause/resume, SW recovery)

importScripts("sv-core.js", "sv-db.js");
const CORE = self.SV_CORE;
const DB = self.SV_DB;

const JOBS_KEY = "sv_jobs";
const ARCHIVED_IDS_KEY = "sv_archived_ids";
const MAX_LOCAL_JOBS = 150;
const speedMemo = new Map();
let pollTimer = null;
let jobLock = Promise.resolve();

function compactDoneJob(j) {
  if (!j || (j.status !== "completed" && j.status !== "cancelled")) return;
  if (j.vSegments) j.vSegments = null;
  if (j.aSegments) j.aSegments = null;
  if (j.zipItems) j.zipItems = null;
  if (j.blobUrl) j.blobUrl = "";
  if (j.sidecarDone && j.sidecarText) j.sidecarText = "";
}

function withJobs(fn) {
  const run = jobLock.then(async () => {
    const r = await chrome.storage.local.get([JOBS_KEY, ARCHIVED_IDS_KEY]);
    const jobs = Array.isArray(r[JOBS_KEY]) ? r[JOBS_KEY] : [];
    const archivedIds = Array.isArray(r[ARCHIVED_IDS_KEY]) ? r[ARCHIVED_IDS_KEY] : [];
    const res = await fn(jobs);

    for (const j of jobs) compactDoneJob(j);

    let kept = jobs;
    if (jobs.length > MAX_LOCAL_JOBS) {
      kept = jobs.slice(0, MAX_LOCAL_JOBS);
      const overflow = jobs.slice(MAX_LOCAL_JOBS);
      const idSet = new Set(archivedIds);
      const toArchive = [];
      for (const oj of overflow) {
        if (!oj) continue;
        if (oj.status === "completed" || oj.status === "cancelled") {
          toArchive.push(oj);
          if (oj.status === "completed" && oj.videoId) idSet.add(String(oj.videoId));
        } else {
          // Keep active/queued/failed jobs even past 150
          kept.push(oj);
        }
      }
      if (toArchive.length && DB) DB.archiveJobs(toArchive);
      const nextIds = Array.from(idSet).slice(-5000);
      await chrome.storage.local.set({ [JOBS_KEY]: kept, [ARCHIVED_IDS_KEY]: nextIds });
    } else {
      await chrome.storage.local.set({ [JOBS_KEY]: kept });
    }
    return res;
  });
  jobLock = run.catch(() => {});
  return run;
}

function makeJob(spec, settings, tabId) {
  const s = CORE.migrateSettings(settings);
  const id = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const meta = spec.meta || {};
  const isZip = Array.isArray(spec.zipItems) && spec.zipItems.length > 0;
  const isDash = !isZip && !!(spec.vUrl && spec.aUrl);
  const kind = isZip ? "zip" : isDash ? "dash" : "direct";
  const quality = meta.quality || (isZip ? "ZIP" : isDash ? "DASH" : "MP4");
  const filename =
    spec.filename ||
    CORE.formatFilename(s, {
      id: meta.id || id,
      title: meta.title || spec.name || "",
      author: meta.author || "",
      platform: meta.platform || "facebook",
      quality,
      ext: isZip ? "zip" : meta.ext || "mp4",
    });

  return {
    id,
    videoId: meta.id ? String(meta.id) : "",
    tabId: spec.tabId || tabId || null,
    chromeDownloadId: null,
    kind,
    status: spec.initialStatus || "queued",
    url: spec.url || "",
    vUrl: spec.vUrl || "",
    vInitUrl: spec.vInitUrl || "",
    vSegments: Array.isArray(spec.vSegments) ? spec.vSegments : null,
    aUrl: spec.aUrl || "",
    aInitUrl: spec.aInitUrl || "",
    aSegments: Array.isArray(spec.aSegments) ? spec.aSegments : null,
    zipItems: isZip ? spec.zipItems : null,
    forceStudio: !!spec.forceStudio,
    blobUrl: "",
    filename,
    title: meta.title || spec.name || filename,
    author: meta.author || "",
    platform: meta.platform || CORE.detectPlatform({ hd: spec.url || spec.vUrl }, meta.sourceUrl),
    quality,
    sourceUrl: meta.sourceUrl || "",
    thumb: meta.thumb || "",
    sidecarText: s.saveSidecarTxt ? CORE.buildSidecarText(Object.assign({}, meta, { id: meta.id || id, quality })) : "",
    sidecarDone: false,
    subtitleUrl: s.saveSubtitles ? meta.subtitleUrl || "" : "",
    subtitleDone: false,
    bytesReceived: 0,
    totalBytes: 0,
    speedBps: 0,
    etaSec: null,
    canResume: false,
    retries: 0,
    maxRetries: s.retryLimit,
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
  };
}

function maybeSaveSidecar(job) {
  if (!job || !job.sidecarText || job.sidecarDone || !job.filename) return;
  job.sidecarDone = true;
  const txtName = job.filename.replace(/\.[^/.]+$/, "") + ".txt";
  const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(job.sidecarText);
  job.sidecarText = "";
  chrome.downloads.download({ url: dataUrl, filename: txtName, saveAs: false }, () => {
    void chrome.runtime.lastError;
  });
}

async function saveSubtitleFile(url, outFilename) {
  if (!url || !outFilename) return false;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return false;
    const raw = await res.text();
    const srt = CORE.vttToSrt(raw);
    const srtName = outFilename.replace(/\.[^/.]+$/, "") + ".srt";
    const dataUrl = "data:application/x-subrip;charset=utf-8," + encodeURIComponent(srt);
    chrome.downloads.download({ url: dataUrl, filename: srtName, saveAs: false }, () => {
      void chrome.runtime.lastError;
    });
    return true;
  } catch (e) {
    CORE.logEvent("warn", "subtitle", `Subtitle fetch failed: ${(e && e.message) || e}`, { url });
    return false;
  }
}

function maybeSaveSubtitle(job) {
  if (!job || !job.subtitleUrl || job.subtitleDone || !job.filename) return;
  job.subtitleDone = true;
  const u = job.subtitleUrl;
  job.subtitleUrl = "";
  saveSubtitleFile(u, job.filename);
}

function revokeOffscreenBlob(job) {
  if (!job || !job.blobUrl) return;
  const blobUrl = job.blobUrl;
  job.blobUrl = "";
  chrome.runtime.sendMessage({ target: "offscreen", action: "revokeBlob", jobId: job.id, blobUrl }).catch(() => {});
}

let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (ctxs && ctxs.length) return true;
    }
    if (!offscreenCreating) {
      offscreenCreating = chrome.offscreen
        .createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification: "Mux fragmented MP4 DASH streams and package slideshow ZIP archives silently.",
        })
        .catch((err) => {
          if (!/Only a single offscreen/i.test((err && err.message) || "")) throw err;
        })
        .finally(() => {
          offscreenCreating = null;
        });
    }
    await offscreenCreating;
    return true;
  } catch (e) {
    CORE.logEvent("warn", "offscreen", `Offscreen unavailable: ${(e && e.message) || e}`);
    return false;
  }
}

async function dispatchOffscreen(job) {
  const ready = await ensureOffscreen();
  if (!ready) return false;
  const payload =
    job.kind === "zip"
      ? { target: "offscreen", action: "zipSlideshow", jobId: job.id, entries: job.zipItems }
      : {
          target: "offscreen",
          action: "muxDash",
          jobId: job.id,
          vSpec: { url: job.vUrl, initUrl: job.vInitUrl || "", segments: job.vSegments || null },
          aSpec: { url: job.aUrl, initUrl: job.aInitUrl || "", segments: job.aSegments || null },
        };
  try {
    await chrome.runtime.sendMessage(payload);
    return true;
  } catch (e) {
    return false;
  }
}

function notifyDone(job) {
  maybeSaveSidecar(job);
  maybeSaveSubtitle(job);
  revokeOffscreenBlob(job);
  if (DB && job && job.status === "completed") DB.archiveJobs([job]);
  CORE.loadSettings().then((s) => {
    if (!s.notifications) return;
    chrome.action.setBadgeText({ text: "✓" }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 2500);
  });
}

async function pumpQueue() {
  const settings = await CORE.loadSettings();
  let hasActiveDirect = false;
  let needDashRunner = false;
  const offscreenQueue = [];

  await withJobs(async (jobs) => {
    const activeCount = jobs.filter((j) => j.status === "downloading" || j.status === "muxing").length;
    let slots = Math.max(0, settings.maxConcurrent - activeCount);

    for (const j of jobs) {
      if (j.kind === "direct" && j.status === "downloading") hasActiveDirect = true;
      if (j.status !== "queued") continue;
      if (slots <= 0) break;

      if (j.kind === "direct") {
        slots--;
        j.status = "downloading";
        j.updatedAt = Date.now();
        j.error = "";
        hasActiveDirect = true;
        try {
          const dlId = await new Promise((resolve, reject) => {
            chrome.downloads.download({ url: j.url, filename: j.filename, saveAs: false }, (id) => {
              if (chrome.runtime.lastError || id == null) {
                reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Download failed"));
              } else resolve(id);
            });
          });
          j.chromeDownloadId = dlId;
        } catch (err) {
          j.status = "failed";
          j.error = err.message;
          CORE.logEvent("error", "download", `Direct start failed: ${err.message}`, { url: j.url });
        }
      } else if (j.kind === "zip" || (j.kind === "dash" && settings.silentDashMerge !== false && !j.forceStudio && !!chrome.offscreen)) {
        slots--;
        j.status = "downloading";
        j.updatedAt = Date.now();
        j.error = "";
        offscreenQueue.push(j);
      } else if (j.kind === "dash") {
        needDashRunner = true;
      }
    }
  });

  if (hasActiveDirect) startPoller();
  for (const job of offscreenQueue) {
    const ok = await dispatchOffscreen(job);
    if (!ok) {
      if (job.kind === "dash") {
        await withJobs((jobs) => {
          const cur = jobs.find((x) => x.id === job.id);
          if (cur && cur.status === "downloading") cur.status = "queued";
        });
        needDashRunner = true;
      } else {
        await withJobs((jobs) => {
          const cur = jobs.find((x) => x.id === job.id);
          if (cur) {
            cur.status = "failed";
            cur.error = "Offscreen ZIP worker không phản hồi";
          }
        });
      }
    }
  }
  if (needDashRunner) ensureBatchTab();
}

let openingBatchTab = false;
async function ensureBatchTab() {
  if (openingBatchTab) return;
  const target = chrome.runtime.getURL("merge.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(target) && t.url.includes("batch=1"));
  if (existing) {
    chrome.runtime.sendMessage({ type: "wakeBatch" }).catch(() => {});
    return;
  }
  openingBatchTab = true;
  try {
    await chrome.tabs.create({ url: target + "?batch=1", active: false });
  } finally {
    setTimeout(() => (openingBatchTab = false), 1200);
  }
}

function startPoller() {
  if (pollTimer) return;
  pollTimer = setInterval(pollActiveDownloads, 600);
}

async function pollActiveDownloads() {
  let stillActive = false;
  let anyEnded = false;
  await withJobs(async (jobs) => {
    const active = jobs.filter((j) => (j.status === "downloading" || j.status === "paused") && j.chromeDownloadId != null);
    if (!active.length) return;
    for (const j of active) {
      const items = await chrome.downloads.search({ id: j.chromeDownloadId }).catch(() => []);
      const d = items && items[0];
      if (!d) continue;

      j.bytesReceived = d.bytesReceived || 0;
      j.totalBytes = d.totalBytes > 0 ? d.totalBytes : j.totalBytes;
      j.canResume = !!d.canResume;
      j.updatedAt = Date.now();

      if (d.state === "complete") {
        j.status = "completed";
        j.speedBps = 0;
        j.etaSec = 0;
        j.completedAt = Date.now();
        speedMemo.delete(j.id);
        notifyDone(j);
        anyEnded = true;
      } else if (d.state === "interrupted") {
        j.speedBps = 0;
        j.etaSec = null;
        speedMemo.delete(j.id);
        if (d.error === "USER_CANCELED") {
          j.status = "cancelled";
          revokeOffscreenBlob(j);
        } else {
          j.status = "failed";
          j.error = d.error || "INTERRUPTED";
          revokeOffscreenBlob(j);
        }
        anyEnded = true;
      } else if (d.paused) {
        j.status = "paused";
        j.speedBps = 0;
        j.etaSec = null;
        speedMemo.delete(j.id);
      } else {
        j.status = "downloading";
        stillActive = true;
        const now = Date.now();
        const prev = speedMemo.get(j.id);
        if (prev && now > prev.ts) {
          const dt = (now - prev.ts) / 1000;
          const db = Math.max(0, j.bytesReceived - prev.bytes);
          const inst = db / dt;
          j.speedBps = prev.spd ? prev.spd * 0.55 + inst * 0.45 : inst;
          j.etaSec = j.totalBytes > 0 && j.speedBps > 50 ? (j.totalBytes - j.bytesReceived) / j.speedBps : null;
          speedMemo.set(j.id, { bytes: j.bytesReceived, ts: now, spd: j.speedBps });
        } else {
          speedMemo.set(j.id, { bytes: j.bytesReceived, ts: now, spd: 0 });
        }
      }
    }
  });

  if (!stillActive && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (anyEnded) pumpQueue();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || delta.id == null) return;
  if (delta.state || delta.paused || delta.canResume) {
    withJobs(async (jobs) => {
      const j = jobs.find((x) => x.chromeDownloadId === delta.id);
      if (!j) return;
      if (delta.paused) j.status = delta.paused.current ? "paused" : "downloading";
      if (delta.canResume) j.canResume = !!delta.canResume.current;
      if (delta.state && delta.state.current === "complete") {
        j.status = "completed";
        j.completedAt = Date.now();
        j.speedBps = 0;
        j.etaSec = 0;
        speedMemo.delete(j.id);
        notifyDone(j);
      } else if (delta.state && delta.state.current === "interrupted") {
        const err = (delta.error && delta.error.current) || "INTERRUPTED";
        j.speedBps = 0;
        j.etaSec = null;
        speedMemo.delete(j.id);
        if (err === "USER_CANCELED") {
          j.status = "cancelled";
          revokeOffscreenBlob(j);
        } else if (j.retries < j.maxRetries) {
          j.retries++;
          j.status = "queued";
          j.chromeDownloadId = null;
          revokeOffscreenBlob(j);
          j.error = `Thử lại lần ${j.retries} (${err})`;
          CORE.logEvent("warn", "download", `Auto-retry ${j.retries}/${j.maxRetries}: ${err}`, { url: j.url });
        } else {
          j.status = "failed";
          j.error = err;
          revokeOffscreenBlob(j);
          CORE.logEvent("error", "download", `Download interrupted: ${err}`, { url: j.url });
        }
      }
      j.updatedAt = Date.now();
    }).then(() => pumpQueue());
  }
});

// Phục hồi trạng thái job sau khi Service Worker tỉnh dậy
(async function recoverOnWakeup() {
  const settings = await CORE.loadSettings();
  await withJobs(async (jobs) => {
    for (const j of jobs) {
      if (j.kind === "direct" && j.chromeDownloadId != null && (j.status === "downloading" || j.status === "paused")) {
        const items = await chrome.downloads.search({ id: j.chromeDownloadId }).catch(() => []);
        const d = items && items[0];
        if (!d) {
          j.status = "failed";
          j.error = "Không tìm thấy tiến trình tải sau khi khởi động lại";
        } else if (d.state === "complete") {
          j.status = "completed";
          j.completedAt = j.completedAt || Date.now();
          j.bytesReceived = d.bytesReceived || j.bytesReceived;
          j.totalBytes = d.totalBytes > 0 ? d.totalBytes : j.totalBytes;
        } else if (d.state === "interrupted") {
          j.status = d.error === "USER_CANCELED" ? "cancelled" : "failed";
          j.error = d.error || "INTERRUPTED";
        } else if (d.paused) {
          j.status = "paused";
          j.canResume = !!d.canResume;
        }
      } else if ((j.kind === "dash" || j.kind === "zip") && (j.status === "downloading" || j.status === "muxing")) {
        const tabs = await chrome.tabs.query({}).catch(() => []);
        const hasMerge = j.kind === "dash" && tabs.some((t) => t.url && t.url.includes("merge.html"));
        let hasOffscreen = false;
        if (chrome.runtime.getContexts) {
          const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).catch(() => []);
          hasOffscreen = !!(ctxs && ctxs.length);
        }
        if (!hasMerge && !hasOffscreen) {
          j.status = "failed";
          j.error = j.kind === "zip" ? "Tác vụ nén ZIP bị gián đoạn trước khi hoàn tất" : "Tiến trình ghép đã dừng trước khi hoàn tất";
        }
      }
    }
  });
  void settings;
  pumpQueue();
})();

// Context Menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "fbvd_download_video",
      title: "⬇ Tải video đang xem (StreamVault V2)",
      contexts: ["page", "video", "link"],
      documentUrlPatterns: [
        "*://*.facebook.com/*",
        "*://*.tiktok.com/*",
        "*://*.instagram.com/*",
        "*://*.threads.net/*",
        "*://*.threads.com/*",
        "*://*.douyin.com/*",
        "*://*.x.com/*",
        "*://*.twitter.com/*",
        "*://*.xiaohongshu.com/*",
      ],
    });
  });
  CORE.loadSettings().then((s) => chrome.storage.local.set({ settings: s }));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "fbvd_download_video" && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "downloadFocused" }).catch(() => {});
  }
});

// Unified Message Hub
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "count" && sender.tab) {
    const text = msg.count > 0 ? (msg.count > 99 ? "99+" : String(msg.count)) : "";
    chrome.action.setBadgeText({ tabId: sender.tab.id, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#3B82F6" }).catch(() => {});
    return;
  }

  if (msg.type === "syncVideos" && sender.tab) {
    const k = "videos_" + sender.tab.id;
    chrome.storage.session.set({
      [k]: { tabId: sender.tab.id, title: sender.tab.title || "", url: msg.url || sender.tab.url || "", videos: msg.videos || [], updatedAt: Date.now() },
    });
    return;
  }

  if (msg.type === "getAllTabVideos") {
    chrome.storage.session.get(null).then((all) => {
      const tabs = [];
      for (const k of Object.keys(all)) {
        if (k.startsWith("videos_") && all[k]) tabs.push(all[k]);
      }
      tabs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      sendResponse({ tabs });
    });
    return true;
  }

  if (msg.type === "download" && msg.url) {
    (async () => {
      const cleanUrl = CORE.safeHttpUrl(msg.url);
      if (!cleanUrl) {
        sendResponse({ ok: false, error: "Invalid URL scheme" });
        return;
      }
      const s = await CORE.loadSettings();
      const folder = CORE.formatFolder(s, msg.meta);
      const rawName = msg.filename ? (!msg.filename.includes("/") ? folder + msg.filename : msg.filename) : undefined;
      const job = makeJob({ url: cleanUrl, filename: rawName, meta: msg.meta, tabId: msg.tabId }, s, sender.tab && sender.tab.id);
      await withJobs((jobs) => jobs.unshift(job));
      await pumpQueue();
      sendResponse({ ok: true, jobId: job.id });
    })();
    return true;
  }

  if (msg.type === "openMerge" && msg.vUrl && msg.aUrl) {
    (async () => {
      const vClean = CORE.safeHttpUrl(msg.vUrl);
      const aClean = CORE.safeHttpUrl(msg.aUrl);
      if (!vClean || !aClean) {
        sendResponse({ ok: false, error: "Invalid DASH stream URL" });
        return;
      }
      const s = await CORE.loadSettings();
      const useSilent = s.silentDashMerge !== false && !msg.forceStudio && !!chrome.offscreen;
      const job = makeJob(
        {
          vUrl: vClean,
          vInitUrl: CORE.safeHttpUrl(msg.vInitUrl),
          vSegments: Array.isArray(msg.vSegments) ? msg.vSegments.map(CORE.safeHttpUrl).filter(Boolean) : null,
          aUrl: aClean,
          aInitUrl: CORE.safeHttpUrl(msg.aInitUrl),
          aSegments: Array.isArray(msg.aSegments) ? msg.aSegments.map(CORE.safeHttpUrl).filter(Boolean) : null,
          forceStudio: !!msg.forceStudio,
          name: msg.name,
          meta: msg.meta,
          tabId: msg.tabId,
          initialStatus: useSilent ? "queued" : "downloading",
        },
        s,
        sender.tab && sender.tab.id
      );
      await withJobs((jobs) => jobs.unshift(job));
      if (useSilent) {
        await pumpQueue();
      } else {
        const q = new URLSearchParams({
          v: vClean,
          a: aClean,
          name: msg.name || "facebook_video",
          author: (msg.meta && msg.meta.author) || "",
          jobId: job.id,
        });
        chrome.tabs.create({ url: chrome.runtime.getURL("merge.html") + "?" + q.toString() });
      }
      sendResponse({ ok: true, jobId: job.id, silent: useSilent });
    })();
    return true;
  }

  if (msg.type === "zipSlideshow" && Array.isArray(msg.entries) && msg.entries.length) {
    (async () => {
      const cleanEntries = msg.entries
        .filter((e) => e && CORE.safeHttpUrl(e.url))
        .map((e) => ({ url: CORE.safeHttpUrl(e.url), name: CORE.safeName(e.name || "file", 64) }));
      if (!cleanEntries.length) {
        sendResponse({ ok: false, error: "No valid HTTP media URLs" });
        return;
      }
      const s = await CORE.loadSettings();
      const job = makeJob(
        { zipItems: cleanEntries, name: msg.name, meta: Object.assign({}, msg.meta, { quality: "ZIP", ext: "zip" }), tabId: msg.tabId },
        s,
        sender.tab && sender.tab.id
      );
      await withJobs((jobs) => jobs.unshift(job));
      await pumpQueue();
      sendResponse({ ok: true, jobId: job.id });
    })();
    return true;
  }

  if (msg.type === "offscreenComplete" && msg.jobId && msg.blobUrl) {
    (async () => {
      let targetJob = null;
      await withJobs(async (jobs) => {
        const j = jobs.find((x) => x.id === msg.jobId);
        if (!j || j.status === "cancelled") {
          chrome.runtime.sendMessage({ target: "offscreen", action: "revokeBlob", jobId: msg.jobId, blobUrl: msg.blobUrl }).catch(() => {});
          return;
        }
        j.blobUrl = msg.blobUrl;
        j.bytesReceived = msg.bytes || j.bytesReceived;
        j.totalBytes = msg.bytes || j.totalBytes;
        j.speedBps = 0;
        j.error = "";
        j.status = "downloading";
        j.updatedAt = Date.now();
        targetJob = j;
      });
      if (targetJob) {
        chrome.downloads.download({ url: msg.blobUrl, filename: targetJob.filename, saveAs: false }, async (dlId) => {
          if (chrome.runtime.lastError || dlId == null) {
            const errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Không lưu được file Blob";
            await withJobs((jobs) => {
              const j = jobs.find((x) => x.id === msg.jobId);
              if (j) {
                j.status = "failed";
                j.error = errMsg;
                revokeOffscreenBlob(j);
              }
            });
            pumpQueue();
          } else {
            await withJobs(async (jobs) => {
              const j = jobs.find((x) => x.id === msg.jobId);
              if (!j) return;
              j.chromeDownloadId = dlId;
              const items = await chrome.downloads.search({ id: dlId }).catch(() => []);
              if (items[0] && items[0].state === "complete" && j.status !== "completed") {
                j.status = "completed";
                j.completedAt = Date.now();
                notifyDone(j);
              }
            });
            pumpQueue();
          }
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "offscreenFailed" && msg.jobId) {
    withJobs((jobs) => {
      const j = jobs.find((x) => x.id === msg.jobId);
      if (!j || j.status === "cancelled") return;
      j.status = msg.aborted ? "cancelled" : "failed";
      j.error = msg.aborted ? "" : msg.error || "Mux error";
      j.speedBps = 0;
      j.updatedAt = Date.now();
      revokeOffscreenBlob(j);
    }).then(() => {
      CORE.logEvent("error", "offscreen", msg.error || "Offscreen failed", { jobId: msg.jobId });
      pumpQueue();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "enqueueBatch" && Array.isArray(msg.items)) {
    (async () => {
      const s = await CORE.loadSettings();
      const tid = msg.tabId || (sender.tab && sender.tab.id) || null;
      const created = msg.items
        .map((it) => {
          if (!it || typeof it !== "object") return null;
          const clean = Object.assign({}, it);
          if (Array.isArray(it.zipItems)) {
            clean.zipItems = it.zipItems
              .map((z) => {
                const cu = CORE.safeHttpUrl(z && z.url);
                return cu ? Object.assign({}, z, { url: cu }) : null;
              })
              .filter(Boolean);
            if (!clean.zipItems.length) return null;
          } else if (it.kind === "mux" || it.vUrl || it.aUrl) {
            const cv = CORE.safeHttpUrl(it.vUrl);
            const ca = it.aUrl ? CORE.safeHttpUrl(it.aUrl) : "";
            if (!cv || (it.aUrl && !ca)) return null;
            clean.vUrl = cv;
            if (ca) clean.aUrl = ca;
          } else {
            const cu = CORE.safeHttpUrl(it.url);
            if (!cu) return null;
            clean.url = cu;
          }
          const folder = CORE.formatFolder(s, clean.meta);
          const rawName = clean.filename ? (!clean.filename.includes("/") ? folder + clean.filename : clean.filename) : undefined;
          return makeJob(Object.assign(clean, rawName ? { filename: rawName } : {}), s, tid);
        })
        .filter(Boolean);
      if (!created.length) {
        sendResponse({ ok: false, count: 0, error: "Invalid URL" });
        return;
      }
      await withJobs((jobs) => {
        for (let i = created.length - 1; i >= 0; i--) jobs.unshift(created[i]);
      });
      await pumpQueue();
      sendResponse({ ok: true, count: created.length });
    })();
    return true;
  }

  if (msg.type === "downloadSubtitle" && msg.url) {
    (async () => {
      const cleanUrl = CORE.safeHttpUrl(msg.url);
      if (!cleanUrl) {
        sendResponse({ ok: false });
        return;
      }
      const s = await CORE.loadSettings();
      const base = msg.filename || CORE.formatFilename(s, Object.assign({}, msg.meta, { quality: "sub", ext: "srt" }));
      const ok = await saveSubtitleFile(cleanUrl, base);
      sendResponse({ ok });
    })();
    return true;
  }

  if (msg.type === "autoEnqueueVideo" && msg.video) {
    (async () => {
      const s = await CORE.loadSettings();
      const nv = CORE.normalizeVideo(msg.video, msg.url);
      if (!nv) {
        sendResponse({ ok: false, queued: false });
        return;
      }
      const tid = msg.tabId || (sender.tab && sender.tab.id) || null;
      let queued = false;
      await withJobs(async (jobs) => {
        const rArch = await chrome.storage.local.get(ARCHIVED_IDS_KEY);
        const doneIds = CORE.getCompletedVideoIds(jobs, rArch[ARCHIVED_IDS_KEY]);
        const activeOrQueued = jobs.some((j) => j && String(j.videoId) === String(nv.id) && (j.status === "queued" || j.status === "downloading" || j.status === "muxing"));
        if (doneIds.has(String(nv.id)) || activeOrQueued) return;

        const firstSub = nv.subtitles && nv.subtitles[0] ? nv.subtitles[0].url : "";
        const baseMeta = { id: nv.id, title: nv.title, author: nv.owner, platform: nv.platform, sourceUrl: nv.sourceUrl || msg.url, thumb: nv.thumb || "", subtitleUrl: firstSub };
        let spec = null;
        if ((nv.hasImages || (nv.carouselVideos && nv.carouselVideos.length > 1)) && !nv.hd && !nv.sd) {
          const entries = [];
          (nv.images || []).forEach((u, i) => entries.push({ url: u, name: `slide_${String(i + 1).padStart(2, "0")}.jpg` }));
          (nv.carouselVideos || []).forEach((cv) => cv && cv.url && entries.push({ url: cv.url, name: `clip_${String(cv.index || entries.length + 1).padStart(2, "0")}.mp4` }));
          if (nv.musicUrl) entries.push({ url: nv.musicUrl, name: "music.mp3" });
          if (entries.length) {
            if (s.zipSlideshow !== false) spec = { zipItems: entries, name: CORE.safeName(nv.title) || `${nv.platform}_${nv.id}`, meta: Object.assign({}, baseMeta, { quality: "ZIP", ext: "zip" }) };
            else spec = { url: entries[0].url, meta: Object.assign({}, baseMeta, { quality: "img01", ext: "jpg" }) };
          }
        } else if (nv.hd || nv.sd) {
          const pick = s.quality === "sd" ? nv.sd || nv.hd : nv.hd || nv.sd;
          const q = pick === nv.hd ? (nv.hdHeight ? `${nv.hdHeight}p` : "HD") : "SD";
          spec = { url: pick, meta: Object.assign({}, baseMeta, { quality: q }) };
        } else if (nv.hasDashMux) {
          const q = nv.dashVideo.height ? `${nv.dashVideo.height}p` : "DASH";
          spec = {
            vUrl: nv.dashVideo.url,
            vInitUrl: nv.dashVideo.initUrl || "",
            vSegments: nv.dashVideo.segments || null,
            aUrl: nv.dashAudio.url,
            aInitUrl: nv.dashAudio.initUrl || "",
            aSegments: nv.dashAudio.segments || null,
            name: CORE.safeName(nv.title) || `${nv.platform}_${nv.id}`,
            meta: Object.assign({}, baseMeta, { quality: q }),
          };
        }
        if (spec) {
          jobs.unshift(makeJob(spec, s, tid));
          queued = true;
        }
      });
      if (queued) await pumpQueue();
      sendResponse({ ok: true, queued });
    })();
    return true;
  }

  if (msg.type === "getJobs") {
    chrome.storage.local.get([JOBS_KEY, ARCHIVED_IDS_KEY]).then((r) => sendResponse({ jobs: r[JOBS_KEY] || [], archivedIds: r[ARCHIVED_IDS_KEY] || [] }));
    return true;
  }

  if (msg.type === "getArchive") {
    (DB ? DB.getArchivedSummary(500) : Promise.resolve({ jobs: [], videoIds: [] })).then((res) => sendResponse(res));
    return true;
  }

  if (msg.type === "updateJob" && msg.jobId) {
    withJobs((jobs) => {
      const j = jobs.find((x) => x.id === msg.jobId);
      if (j && msg.patch) {
        Object.assign(j, msg.patch, { updatedAt: Date.now() });
        if (j.status === "completed" && !j.completedAt) j.completedAt = Date.now();
      }
    }).then(() => {
      if (msg.patch && ["completed", "failed", "cancelled"].includes(msg.patch.status)) pumpQueue();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "jobAction") {
    (async () => {
      const { action, jobId, dir } = msg;
      if (action === "refreshUrl") {
        const res = await refreshExpiredJob(jobId);
        sendResponse(res);
        return;
      }
      if (action === "showFile") {
        const r = await chrome.storage.local.get(JOBS_KEY);
        const target = (r[JOBS_KEY] || []).find((x) => x.id === jobId);
        if (target && target.chromeDownloadId != null && chrome.downloads.show) {
          chrome.downloads.show(target.chromeDownloadId);
        } else if (chrome.downloads.showDefaultFolder) {
          chrome.downloads.showDefaultFolder();
        }
        sendResponse({ ok: true });
        return;
      }
      if (action === "clearArchive") {
        if (DB) await DB.clearArchive();
        await chrome.storage.local.set({ [ARCHIVED_IDS_KEY]: [] });
        sendResponse({ ok: true });
        return;
      }
      if (action === "import" && Array.isArray(msg.jobs)) {
        let added = 0;
        await withJobs((jobs) => {
          const res = CORE.mergeImportedJobs(jobs, msg.jobs);
          added = res.added;
          jobs.length = 0;
          jobs.push(...res.jobs);
        });
        const r = await chrome.storage.local.get(JOBS_KEY);
        sendResponse({ ok: true, added, jobs: r[JOBS_KEY] || [] });
        return;
      }
      await withJobs(async (jobs) => {
        if (action === "clearCompleted") {
          const kept = jobs.filter((j) => j.status !== "completed" && j.status !== "cancelled");
          jobs.length = 0;
          jobs.push(...kept);
          return;
        }
        if (action === "clearFailed") {
          const kept = jobs.filter((j) => j.status !== "failed");
          jobs.length = 0;
          jobs.push(...kept);
          return;
        }
        if (action === "retryAllFailed") {
          for (const j of jobs) {
            if (j.status === "failed") {
              j.status = "queued";
              j.error = "";
              j.chromeDownloadId = null;
              j.updatedAt = Date.now();
            }
          }
          return;
        }
        const idx = jobs.findIndex((x) => x.id === jobId);
        if (idx === -1) return;
        const j = jobs[idx];

        if (action === "pause" && j.kind === "direct" && j.chromeDownloadId != null) {
          await chrome.downloads.pause(j.chromeDownloadId).catch(() => {});
          const items = await chrome.downloads.search({ id: j.chromeDownloadId }).catch(() => []);
          j.canResume = items[0] ? !!items[0].canResume : true;
          j.status = "paused";
        } else if (action === "resume" && j.kind === "direct" && j.chromeDownloadId != null) {
          const items = await chrome.downloads.search({ id: j.chromeDownloadId }).catch(() => []);
          const d = items[0];
          if (d && d.canResume) {
            await chrome.downloads.resume(j.chromeDownloadId).catch(() => {});
            j.status = "downloading";
            j.canResume = true;
          }
        } else if (action === "cancel") {
          if (j.kind === "direct" && j.chromeDownloadId != null) {
            await chrome.downloads.cancel(j.chromeDownloadId).catch(() => {});
          } else if (j.kind === "dash" || j.kind === "zip") {
            chrome.runtime.sendMessage({ target: "offscreen", action: "abortJob", jobId: j.id }).catch(() => {});
            revokeOffscreenBlob(j);
          }
          j.status = "cancelled";
          j.speedBps = 0;
          j.etaSec = null;
        } else if (action === "retry") {
          j.status = "queued";
          j.error = "";
          j.chromeDownloadId = null;
          revokeOffscreenBlob(j);
          j.bytesReceived = 0;
          j.speedBps = 0;
        } else if (action === "remove") {
          jobs.splice(idx, 1);
        } else if (action === "move" && j.status === "queued") {
          if (dir === "top") {
            jobs.splice(idx, 1);
            jobs.unshift(j);
          } else if (dir === "up" && idx > 0) {
            [jobs[idx - 1], jobs[idx]] = [jobs[idx], jobs[idx - 1]];
          } else if (dir === "down" && idx < jobs.length - 1) {
            [jobs[idx + 1], jobs[idx]] = [jobs[idx], jobs[idx + 1]];
          }
        }
        j.updatedAt = Date.now();
      });
      await pumpQueue();
      const r = await chrome.storage.local.get(JOBS_KEY);
      sendResponse({ ok: true, jobs: r[JOBS_KEY] || [] });
    })();
    return true;
  }

  if (msg.type === "getStreams" && sender.tab) {
    const k = "streams_" + sender.tab.id;
    chrome.storage.session.get(k).then((r) => sendResponse({ streams: r[k] || [] }));
    return true;
  }

  if (msg.type === "clearStreams" && msg.tabId) {
    chrome.storage.session.remove("streams_" + msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function refreshExpiredJob(jobId) {
  const r = await chrome.storage.local.get(JOBS_KEY);
  const jobs = Array.isArray(r[JOBS_KEY]) ? r[JOBS_KEY] : [];
  const j = jobs.find((x) => x.id === jobId);
  if (!j || !j.videoId) {
    return { ok: false, error: "Thiếu videoId để làm mới link.", jobs };
  }

  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const domainMap = {
    tiktok: /tiktok\.com/i,
    douyin: /douyin\.com/i,
    instagram: /instagram\.com/i,
    threads: /threads\.(net|com)/i,
    x: /(^|\.)(x|twitter)\.com/i,
    xiaohongshu: /xiaohongshu\.com/i,
    facebook: /facebook\.com/i,
  };
  const domainRe = domainMap[j.platform] || /facebook\.com/i;
  const candidates = [];
  if (j.tabId) {
    const exact = allTabs.find((t) => t.id === j.tabId && domainRe.test(t.url || ""));
    if (exact) candidates.push(exact);
  }
  for (const t of allTabs) {
    if (!domainRe.test(t.url || "")) continue;
    if (candidates.some((c) => c.id === t.id)) continue;
    if (j.sourceUrl && t.url === j.sourceUrl) candidates.unshift(t);
    else candidates.push(t);
  }

  let matched = null;
  let matchedTabId = null;
  for (const t of candidates) {
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: "rescan" });
      const found = (res && res.videos || []).find((v) => String(v.id) === String(j.videoId));
      if (found) {
        matched = found;
        matchedTabId = t.id;
        break;
      }
    } catch (e) {}
  }

  if (!matched) {
    return { ok: false, error: "Không tìm thấy video trên tab đang mở. Hãy mở lại trang gốc rồi thử lại.", jobs };
  }

  let updated = false;
  await withJobs((list) => {
    const cur = list.find((x) => x.id === jobId);
    if (!cur) return;
    if (cur.kind === "dash" && matched.dashVideo && matched.dashAudio) {
      cur.vUrl = matched.dashVideo.url;
      cur.vInitUrl = matched.dashVideo.initUrl || "";
      cur.vSegments = matched.dashVideo.segments || null;
      cur.aUrl = matched.dashAudio.url;
      cur.aInitUrl = matched.dashAudio.initUrl || "";
      cur.aSegments = matched.dashAudio.segments || null;
      updated = true;
    } else if (cur.quality === "music" && matched.musicUrl) {
      cur.url = matched.musicUrl;
      updated = true;
    } else if (cur.quality === "audio" && matched.dashAudio) {
      cur.url = matched.dashAudio.url;
      updated = true;
    } else if (matched.hd || matched.sd || (matched.dashVideo && matched.dashVideo.url)) {
      cur.url = cur.quality === "SD" ? matched.sd || matched.hd : matched.hd || matched.sd || matched.dashVideo.url;
      updated = true;
    }
    if (updated) {
      cur.tabId = matchedTabId || cur.tabId;
      cur.status = "queued";
      cur.error = "";
      cur.chromeDownloadId = null;
      cur.bytesReceived = 0;
      cur.speedBps = 0;
      cur.etaSec = null;
      cur.updatedAt = Date.now();
    }
  });

  if (updated) {
    CORE.logEvent("info", "refresh-url", `Refreshed link for video ${j.videoId}`, { jobId });
    await pumpQueue();
  }
  const latest = await chrome.storage.local.get(JOBS_KEY);
  return {
    ok: updated,
    error: updated ? "" : "Tìm thấy video nhưng không có link tải khả dụng.",
    jobs: latest[JOBS_KEY] || [],
  };
}

function decodeEfg(efg) {
  try {
    let s = decodeURIComponent(efg).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return JSON.parse(atob(s));
  } catch (e) {
    return null;
  }
}

// Facebook/TikTok network stream passive capture
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    let u;
    try {
      u = new URL(d.url);
    } catch (e) {
      return;
    }
    const isBD = /(tiktok(cdn|v)?|byteoversea|douyin(vod)?|zjcdn)\./i.test(u.hostname);
    const isDY = /(douyin(vod)?|zjcdn)\./i.test(u.hostname);
    const isIG = /cdninstagram\.com/i.test(u.hostname);
    const isX = /twimg\.com/i.test(u.hostname);
    const isXHS = /xhscdn\.com/i.test(u.hostname);
    if (!isBD && !isX && !isXHS && !/\.mp4$/.test(u.pathname) && !u.searchParams.has("bytestart")) return;
    if ((isBD || isX || isXHS) && d.type !== "media" && !/video_mp4|\/video\/|\.mp4/i.test(d.url)) return;
    const hasRange = u.searchParams.has("bytestart");
    u.searchParams.delete("bytestart");
    u.searchParams.delete("byteend");

    const efg = isBD || isX || isXHS ? null : decodeEfg(u.searchParams.get("efg") || "");
    const tag = (efg && efg.vencode_tag) || "";
    const isAudio = !isBD && !isX && !isXHS && /audio/i.test(tag);
    const qm = tag.match(/(\d{3,4})p/) || tag.match(/_(\d{3,4})(?:_|$)/) || (isX ? d.url.match(/\/(\d{2,4})x(\d{2,4})\//) : null);
    const qNum = qm ? (qm[2] ? Math.min(+qm[1], +qm[2]) : +qm[1]) : 0;
    const vid = efg && (efg.video_id || efg.xpv_asset_id) ? String(efg.video_id || efg.xpv_asset_id) : "";
    const stream = {
      key: u.pathname,
      url: u.toString(),
      type: isAudio ? "audio" : "video",
      muxed: isBD || isX || isXHS || (isIG && !hasRange),
      platform: isX ? "x" : isXHS ? "xiaohongshu" : isDY ? "douyin" : isBD ? "tiktok" : isIG ? "instagram" : "facebook",
      quality: qNum ? qNum + "p" : /hd/i.test(tag) ? "HD" : /sd/i.test(tag) ? "SD" : "",
      qNum,
      videoId: vid,
      time: Date.now(),
    };

    const k = "streams_" + d.tabId;
    chrome.storage.session.get(k).then((r) => {
      let list = (r[k] || []).filter((s) => s.key !== stream.key);
      list.unshift(stream);
      chrome.storage.session.set({ [k]: list.slice(0, 30) });
    });
  },
  {
    urls: [
      "*://*.fbcdn.net/*",
      "*://*.cdninstagram.com/*",
      "*://*.tiktok.com/video/*",
      "*://*.tiktokcdn.com/*",
      "*://*.tiktokcdn-us.com/*",
      "*://*.tiktokcdn-eu.com/*",
      "*://*.tiktokv.com/*",
      "*://*.byteoversea.com/*",
      "*://*.douyinvod.com/*",
      "*://*.zjcdn.com/*",
      "*://*.twimg.com/*",
      "*://*.xhscdn.com/*",
    ],
    types: ["xmlhttprequest", "media", "other"],
  }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(["streams_" + tabId, "videos_" + tabId, "popup_scroll_" + tabId]);
});
