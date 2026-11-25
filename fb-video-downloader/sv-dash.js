// StreamVault V2 — Shared DASH Segment Fetcher & Progress Helper
// Used by both offscreen.html (silent background muxing) and merge.html (Merge Studio UI).
(function (root) {
  function concatChunks(chunks, totalBytes) {
    let len = totalBytes;
    if (!Number.isFinite(len) || len <= 0) {
      len = chunks.reduce((s, c) => s + c.length, 0);
    }
    const out = new Uint8Array(len);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return offset === out.length ? out : out.subarray(0, offset);
  }

  async function fetchBuffer(url, opts) {
    const o = opts || {};
    const res = await fetch(url, { credentials: o.credentials || "omit", signal: o.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url.slice(0, 64)})`);
    const total = +res.headers.get("content-length") || 0;
    if (!res.body || !res.body.getReader) {
      const ab = await res.arrayBuffer();
      const u8 = new Uint8Array(ab);
      if (o.onProgress) o.onProgress(u8.length, u8.length, 0);
      return u8;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    const t0 = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (o.onProgress) {
        const sec = Math.max(0.15, (Date.now() - t0) / 1000);
        o.onProgress(got, total, got / sec);
      }
    }
    return concatChunks(chunks, got);
  }

  async function fetchStream(spec, opts) {
    const o = opts || {};
    if (typeof spec === "string") return fetchBuffer(spec, o);
    const url = spec && spec.url;
    const segs = spec && Array.isArray(spec.segments) && spec.segments.length ? spec.segments : null;
    if (!segs) {
      if (!url) throw new Error("Thiếu URL stream");
      return fetchBuffer(url, o);
    }

    const queueUrls = [];
    if (spec.initUrl && segs[0] !== spec.initUrl) queueUrls.push(spec.initUrl);
    for (const s of segs) {
      if (s && !queueUrls.includes(s)) queueUrls.push(s);
    }

    const buffers = new Array(queueUrls.length);
    let doneCount = 0;
    let totalBytes = 0;
    const t0 = Date.now();
    let cursor = 0;
    const concurrency = Math.min(3, queueUrls.length);

    async function worker() {
      while (cursor < queueUrls.length) {
        const idx = cursor++;
        if (o.signal && o.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const buf = await fetchBuffer(queueUrls[idx], { signal: o.signal, credentials: o.credentials });
        buffers[idx] = buf;
        doneCount++;
        totalBytes += buf.length;
        if (o.onProgress) {
          const estTotal = Math.round((totalBytes / doneCount) * queueUrls.length);
          const sec = Math.max(0.15, (Date.now() - t0) / 1000);
          o.onProgress(totalBytes, estTotal, totalBytes / sec, doneCount, queueUrls.length);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    return concatChunks(buffers, totalBytes);
  }

  root.SV_DASH = { fetchBuffer, fetchStream, concatChunks };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SV_DASH;
})(typeof self !== "undefined" ? self : globalThis);
