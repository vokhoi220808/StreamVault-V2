// StreamVault V2 — Offscreen Document Worker
// Performs silent background DASH fMP4 muxing and slideshow/carousel ZIP packaging without opening visible tabs.
(function () {
  const CORE = self.SV_CORE;
  const ZIP = self.SV_ZIP;
  const MUX = self.FBVD_MP4;
  const DASH = self.SV_DASH;

  const activeJobs = new Map(); // jobId -> AbortController
  const blobUrls = new Map(); // jobId -> blobUrl

  function sendPatch(jobId, patch) {
    chrome.runtime.sendMessage({ type: "updateJob", jobId, patch }).catch(() => {});
  }

  async function runMuxDash(msg) {
    const { jobId, vSpec, aSpec } = msg;
    const ctrl = new AbortController();
    activeJobs.set(jobId, ctrl);

    let vGot = 0, vTot = 0, vSpd = 0;
    let aGot = 0, aTot = 0, aSpd = 0;
    let lastReport = 0;
    const reportDownload = (force) => {
      const now = Date.now();
      if (!force && now - lastReport < 400) return;
      lastReport = now;
      sendPatch(jobId, {
        status: "downloading",
        bytesReceived: vGot + aGot,
        totalBytes: vTot + aTot,
        speedBps: vSpd + aSpd,
      });
    };

    try {
      const [vb, ab] = await Promise.all([
        DASH.fetchStream(vSpec, {
          signal: ctrl.signal,
          onProgress: (g, t, spd) => { vGot = g; vTot = t; vSpd = spd; reportDownload(false); },
        }),
        DASH.fetchStream(aSpec, {
          signal: ctrl.signal,
          onProgress: (g, t, spd) => { aGot = g; aTot = t; aSpd = spd; reportDownload(false); },
        }),
      ]);
      reportDownload(true);

      let lastMuxReport = 0;
      sendPatch(jobId, { status: "muxing", bytesReceived: vb.length + ab.length, totalBytes: vb.length + ab.length, speedBps: 0 });
      const merged = MUX.mux(vb, ab, (stage, pct) => {
        const now = Date.now();
        if (now - lastMuxReport > 350 || pct === 100) {
          lastMuxReport = now;
          sendPatch(jobId, { status: "muxing", error: stage });
        }
      });

      const blob = new Blob([merged], { type: "video/mp4" });
      const blobUrl = URL.createObjectURL(blob);
      blobUrls.set(jobId, blobUrl);
      chrome.runtime.sendMessage({ type: "offscreenComplete", jobId, blobUrl, bytes: merged.length }).catch(() => {});
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      chrome.runtime.sendMessage({
        type: "offscreenFailed",
        jobId,
        aborted,
        error: aborted ? "USER_CANCELED" : (err && err.message) || "Offscreen mux failed",
      }).catch(() => {});
    } finally {
      activeJobs.delete(jobId);
    }
  }

  async function runZipSlideshow(msg) {
    const { jobId, entries } = msg;
    const ctrl = new AbortController();
    activeJobs.set(jobId, ctrl);
    try {
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) throw new Error("Danh sách slideshow trống");

      const outEntries = new Array(list.length);
      let done = 0;
      let totalBytes = 0;
      let cursor = 0;
      const concurrency = Math.min(3, list.length);

      async function worker() {
        while (cursor < list.length) {
          const i = cursor++;
          if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const item = list[i];
          const data = await DASH.fetchBuffer(item.url, { signal: ctrl.signal });
          outEntries[i] = { name: item.name || `item_${String(i + 1).padStart(2, "0")}.bin`, data };
          done++;
          totalBytes += data.length;
          sendPatch(jobId, {
            status: "downloading",
            bytesReceived: totalBytes,
            totalBytes: Math.round((totalBytes / done) * list.length),
          });
        }
      }

      await Promise.all(Array.from({ length: concurrency }, worker));
      sendPatch(jobId, { status: "muxing", error: "Đang đóng gói .zip..." });

      const zipBytes = ZIP.createZip(outEntries);
      const blob = new Blob([zipBytes], { type: "application/zip" });
      const blobUrl = URL.createObjectURL(blob);
      blobUrls.set(jobId, blobUrl);
      chrome.runtime.sendMessage({ type: "offscreenComplete", jobId, blobUrl, bytes: zipBytes.length }).catch(() => {});
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      chrome.runtime.sendMessage({
        type: "offscreenFailed",
        jobId,
        aborted,
        error: aborted ? "USER_CANCELED" : (err && err.message) || "ZIP packaging failed",
      }).catch(() => {});
    } finally {
      activeJobs.delete(jobId);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return;
    if (msg.action === "ping") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "muxDash" && msg.jobId) {
      runMuxDash(msg);
      sendResponse({ started: true });
      return;
    }
    if (msg.action === "zipSlideshow" && msg.jobId) {
      runZipSlideshow(msg);
      sendResponse({ started: true });
      return;
    }
    if (msg.action === "abortJob" && msg.jobId) {
      const ctrl = activeJobs.get(msg.jobId);
      if (ctrl) ctrl.abort();
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "revokeBlob") {
      const u = msg.blobUrl || blobUrls.get(msg.jobId);
      if (u) {
        try { URL.revokeObjectURL(u); } catch (e) {}
      }
      if (msg.jobId) blobUrls.delete(msg.jobId);
      sendResponse({ ok: true });
      return;
    }
  });
})();
