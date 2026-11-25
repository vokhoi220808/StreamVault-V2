// StreamVault V2 — MP4 Merge Studio Controller
const CORE = window.SV_CORE;
const DASH = window.SV_DASH;
const qs = new URLSearchParams(location.search);
const vUrl = qs.get("v");
const aUrl = qs.get("a");
const name = qs.get("name") || "facebook_video";
const jobId = qs.get("jobId");

const $ = (id) => document.getElementById(id);
let settings = CORE.DEFAULT_SETTINGS;
let lastBlob = null;
let lastFilename = name + ".mp4";

function setStatus(text, cls) {
  $("status").textContent = text;
  $("status").className = "studio-status" + (cls ? " " + cls : "");
}

function setStep(activeNum) {
  for (let i = 1; i <= 4; i++) {
    const el = $("st" + i);
    if (!el) continue;
    el.className = "step" + (i < activeNum ? " done" : i === activeNum ? " active" : "");
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return "—";
  }
}

async function reportJob(id, patch) {
  if (!id) return;
  try {
    await chrome.runtime.sendMessage({ type: "updateJob", jobId: id, patch });
  } catch (e) {}
}

function fetchWithProgress(spec, bar, label, onBytes) {
  return DASH.fetchStream(spec, {
    credentials: "omit",
    onProgress: (got, total, spd, segDone, segTotal) => {
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
      $(bar + "b").style.width = (total ? pct : 55) + "%";
      const segTxt = segTotal ? ` [${segDone}/${segTotal}]` : "";
      $(bar + "t").textContent = total
        ? `${pct}%${segTxt} · ${CORE.fmtBytes(got)} (${CORE.fmtBytes(spd)}/s)`
        : `${CORE.fmtBytes(got)} (${CORE.fmtBytes(spd)}/s)`;
      if (onBytes) onBytes(got, total, spd);
    },
  }).then((buf) => {
    $(bar + "b").style.width = "100%";
    return buf;
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id == null) {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        resolve(null);
        return;
      }
      const onChanged = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === "complete" || d.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(onChanged);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          resolve(d.state.current);
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

function dlUrl(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id == null) {
        resolve("interrupted");
        return;
      }
      const onChanged = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === "complete" || d.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve(d.state.current);
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

function renderStreamSpecs(vb, ab) {
  let vi = null;
  let ai = null;
  try {
    vi = FBVD_MP4.inspect(vb);
    $("vCodec").textContent = `${vi.codec} · ${vi.container}`;
    $("vDims").textContent = `${vi.width && vi.height ? `${vi.width}×${vi.height} · ` : ""}${vi.fragments} fragments · ${CORE.fmtBytes(vi.bytes)}`;
  } catch (e) {
    $("vCodec").textContent = e.code === "NOT_FRAGMENTED" ? "Không phân mảnh (non-fMP4)" : "Không đọc được header";
    $("vDims").textContent = CORE.fmtBytes(vb.length);
  }
  try {
    ai = FBVD_MP4.inspect(ab);
    $("aCodec").textContent = `${ai.codec} · ${ai.container}`;
    $("aDims").textContent = `${ai.timescale} Hz · ${ai.fragments} fragments · ${CORE.fmtBytes(ai.bytes)}`;
  } catch (e) {
    $("aCodec").textContent = e.code === "NOT_FRAGMENTED" ? "Không phân mảnh (non-fMP4)" : "Không đọc được header";
    $("aDims").textContent = CORE.fmtBytes(ab.length);
  }
  return { vi, ai };
}

function showFallback(vSrc, aSrc, base) {
  $("fallback").hidden = false;
  $("retry").onclick = () => location.reload();
  $("dlV").onclick = () => chrome.downloads.download({ url: vSrc, filename: base + "_video.mp4" });
  $("dlA").onclick = () => chrome.downloads.download({ url: aSrc, filename: base + "_audio.m4a" });
  const cmd = `ffmpeg -i "${base}_video.mp4" -i "${base}_audio.m4a" -c copy "${base}.mp4"`;
  $("ffmpegCmd").textContent = cmd;
  $("copyFfmpeg").onclick = () => {
    navigator.clipboard?.writeText(cmd).catch(() => {});
    $("copyFfmpeg").textContent = "✓ Đã chép";
    setTimeout(() => ($("copyFfmpeg").textContent = "📋 Chép lệnh FFmpeg"), 1500);
  };
}

async function runBatchFromJobs() {
  $("title").textContent = "Batch Merge & Download Runner";
  $("batchInfo").hidden = false;
  let stopped = false;
  $("stopBatch").onclick = () => {
    stopped = true;
    $("stopBatch").disabled = true;
    setStatus("Đang dừng sau tác vụ hiện tại...");
  };

  // Tương thích cả legacy batch_queue (session) và sv_jobs (persistent local)
  const legacy = (await chrome.storage.session.get("batch_queue")).batch_queue || [];
  if (legacy.length) {
    await chrome.storage.session.remove("batch_queue");
    await chrome.runtime.sendMessage({ type: "enqueueBatch", items: legacy });
  }

  let ok = 0;
  let fail = 0;
  let processed = 0;

  while (!stopped) {
    const res = await chrome.runtime.sendMessage({ type: "getJobs" }).catch(() => ({ jobs: [] }));
    const jobs = (res && res.jobs) || [];
    const dashJob = jobs.find((j) => j.kind === "dash" && j.status === "queued");
    if (!dashJob) {
      const activeDirect = jobs.some((j) => j.status === "queued" || j.status === "downloading");
      if (activeDirect) {
        $("batchCount").textContent = `Đang chờ tải trực tiếp trong Download Manager · Đã ghép: ${ok}`;
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      break;
    }

    processed++;
    $("name").textContent = dashJob.filename;
    $("vHost").textContent = hostOf(dashJob.vUrl);
    $("aHost").textContent = hostOf(dashJob.aUrl);
    $("batchCount").textContent = `Đang xử lý tác vụ DASH #${processed} (Xong: ${ok}, Lỗi: ${fail})`;
    await reportJob(dashJob.id, { status: "downloading", error: "" });

    try {
      setStatus(`Đang tải hình & tiếng (${dashJob.filename})...`);
      const vSpec = { url: dashJob.vUrl, initUrl: dashJob.vInitUrl || "", segments: dashJob.vSegments || null };
      const aSpec = { url: dashJob.aUrl, initUrl: dashJob.aInitUrl || "", segments: dashJob.aSegments || null };
      const [vb, ab] = await Promise.all([
        fetchWithProgress(vSpec, "v", "hình"),
        fetchWithProgress(aSpec, "a", "tiếng"),
      ]);
      renderStreamSpecs(vb, ab);
      setStatus("Đang ghép container MP4...");
      await reportJob(dashJob.id, { status: "muxing", bytesReceived: vb.length + ab.length, totalBytes: vb.length + ab.length });

      const merged = FBVD_MP4.mux(vb, ab, (stage, pct) => {
        $("muxBar").style.width = pct + "%";
        $("muxPct").textContent = pct + "%";
        setStatus(stage);
      });
      const state = await saveBlob(new Blob([merged], { type: "video/mp4" }), dashJob.filename);
      if (state === "interrupted") throw new Error("Lưu file bị gián đoạn");
      await reportJob(dashJob.id, { status: "completed", bytesReceived: merged.length, totalBytes: merged.length });
      ok++;
    } catch (e) {
      fail++;
      await reportJob(dashJob.id, { status: "failed", error: e.message || "Merge error" });
      CORE.logEvent("error", "merge-batch", e.message, { vUrl: dashJob.vUrl });
    }
  }

  $("batchCount").textContent = `Hoàn tất hàng đợi DASH · Thành công: ${ok}` + (fail ? ` · Lỗi: ${fail}` : "");
  setStatus(stopped ? "⏹ Đã dừng." : "✅ Đã hoàn tất xử lý hàng đợi!", ok >= fail ? "ok" : "err");
  if (chrome.downloads.showDefaultFolder) {
    $("doneActions").hidden = false;
    $("openFolder").onclick = () => chrome.downloads.showDefaultFolder();
    $("reDownload").hidden = true;
  }
}

async function runSingle() {
  const folder = CORE.formatFolder(settings, {
    platform: CORE.detectPlatform({ hd: vUrl }),
    author: qs.get("author") || "",
  });
  const outFile = `${folder}${name}.mp4`;
  lastFilename = outFile;
  $("name").textContent = outFile;
  $("vHost").textContent = hostOf(vUrl);
  $("aHost").textContent = hostOf(aUrl);

  if (!vUrl || !aUrl) {
    setStatus("Thiếu link luồng hình hoặc luồng tiếng.", "err");
    return;
  }

  let vSpec = { url: vUrl };
  let aSpec = { url: aUrl };
  if (jobId) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "getJobs" });
      const found = (res && res.jobs || []).find((x) => x.id === jobId);
      if (found) {
        if (found.vSegments || found.vInitUrl) vSpec = { url: found.vUrl || vUrl, initUrl: found.vInitUrl || "", segments: found.vSegments || null };
        if (found.aSegments || found.aInitUrl) aSpec = { url: found.aUrl || aUrl, initUrl: found.aInitUrl || "", segments: found.aSegments || null };
      }
    } catch (e) {}
  }

  try {
    setStatus("Đang tải song song luồng hình và tiếng...");
    let vGot = 0, vTot = 0, aGot = 0, aTot = 0;
    const syncJobBytes = () => {
      if (jobId) reportJob(jobId, { status: "downloading", bytesReceived: vGot + aGot, totalBytes: vTot + aTot });
    };
    const [vb, ab] = await Promise.all([
      fetchWithProgress(vSpec, "v", "hình", (g, t) => { vGot = g; vTot = t; syncJobBytes(); }),
      fetchWithProgress(aSpec, "a", "tiếng", (g, t) => { aGot = g; aTot = t; syncJobBytes(); }),
    ]);

    setStep(2);
    const { vi } = renderStreamSpecs(vb, ab);
    setStep(3);
    setStatus("Đang ghép container MP4...");
    await reportJob(jobId, { status: "muxing" });
    await new Promise((r) => setTimeout(r, 20));

    const merged = FBVD_MP4.mux(vb, ab, (stage, pct) => {
      $("muxBar").style.width = pct + "%";
      $("muxPct").textContent = pct + "%";
      setStatus(stage);
    });

    setStep(4);
    lastBlob = new Blob([merged], { type: "video/mp4" });
    $("outputInfo").hidden = false;
    $("outputInfo").textContent = `File đầu ra: ${outFile} · Dung lượng: ${CORE.fmtBytes(merged.length)}` +
      (vi && vi.durationSec ? ` · Thời lượng: ${CORE.fmtDuration(vi.durationSec * 1000)}` : "");

    setStatus(`Đang lưu file (${CORE.fmtBytes(merged.length)})...`);
    const state = await saveBlob(lastBlob, outFile);
    if (state === "interrupted") throw new Error("Lưu file bị gián đoạn");

    await reportJob(jobId, { status: "completed", bytesReceived: merged.length, totalBytes: merged.length, speedBps: 0, etaSec: 0 });
    setStep(5);

    $("doneActions").hidden = false;
    if (chrome.downloads.showDefaultFolder) $("openFolder").onclick = () => chrome.downloads.showDefaultFolder();
    $("reDownload").onclick = () => lastBlob && saveBlob(lastBlob, outFile);

    if (settings.autoClose !== false) {
      setStatus("✅ Hoàn tất! Video có tiếng đã được lưu. Tab sẽ tự đóng...", "ok");
      setTimeout(() => window.close(), 2600);
    } else {
      setStatus("✅ Hoàn tất! Video có tiếng đã được lưu.", "ok");
    }
  } catch (e) {
    console.error(e);
    const msg = e.code === "NOT_FRAGMENTED"
      ? "Định dạng MP4 không phải dạng phân mảnh (fMP4) nên trình ghép không hỗ trợ tự động."
      : e.message;
    setStatus("❌ Lỗi: " + msg, "err");
    await reportJob(jobId, { status: "failed", error: msg });
    CORE.logEvent("error", "merge-single", msg, { vUrl, aUrl });
    showFallback(vUrl, aUrl, name);
  }
}

(async function main() {
  settings = await CORE.loadSettings();
  CORE.applyAppearance(settings);
  if (qs.get("batch")) return runBatchFromJobs();
  return runSingle();
})();
