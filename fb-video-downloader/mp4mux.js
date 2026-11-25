// Ghép 2 file MP4 phân mảnh (DASH fMP4: 1 luồng hình + 1 luồng tiếng) thành 1 file MP4 có tiếng.
// Không cần ffmpeg, chạy thuần JS trong trình duyệt (và Node để test).
(function (root) {
  const u32 = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const w32 = (b, o, v) => {
    b[o] = (v >>> 24) & 255;
    b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255;
    b[o + 3] = v & 255;
  };
  const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);
  const w64 = (b, o, v) => {
    w32(b, o, Math.floor(v / 0x100000000));
    w32(b, o + 4, v % 0x100000000);
  };
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function boxes(b, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p);
      const type = fourcc(b, p + 4);
      let hdr = 8;
      if (size === 1) {
        size = u64(b, p + 8);
        hdr = 16;
      } else if (size === 0) size = end - p;
      if (size < hdr) break;
      if (p + size > end) size = end - p; // file bị cắt cụt
      out.push({ type, start: p, end: p + size, hdr });
      p += size;
    }
    return out;
  }
  const kids = (b, box) => boxes(b, box.start + box.hdr, box.end);
  const kid = (b, box, t) => box && kids(b, box).find((x) => x.type === t);

  function makeBox(type, parts) {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    w32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function parse(b) {
    const top = boxes(b, 0, b.length);
    const moov = top.find((x) => x.type === "moov");
    if (!moov) throw new Error("File không hợp lệ (thiếu moov)");
    const mc = kids(b, moov);
    const mvhd = mc.find((x) => x.type === "mvhd");
    const mvex = mc.find((x) => x.type === "mvex");
    if (!mvex) {
      const e = new Error("NOT_FRAGMENTED");
      e.code = "NOT_FRAGMENTED";
      throw e;
    }
    let trak = null;
    let handler = "";
    let timescale = 1;
    let codec = "";
    let width = 0;
    let height = 0;
    for (const tr of mc) {
      if (tr.type !== "trak") continue;
      const mdia = kid(b, tr, "mdia");
      const hdlr = kid(b, mdia, "hdlr");
      const mdhd = kid(b, mdia, "mdhd");
      if (!hdlr || !mdhd) continue;
      const h = fourcc(b, hdlr.start + hdlr.hdr + 8);
      if (h === "vide" || h === "soun" || !trak) {
        trak = tr;
        handler = h;
        const mv = b[mdhd.start + mdhd.hdr];
        timescale = u32(b, mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12)) || 1;
        const tkhd = kid(b, tr, "tkhd");
        if (tkhd) {
          const to = tkhd.start + tkhd.hdr;
          const off = b[to] === 1 ? 88 : 76;
          if (to + off + 8 <= tkhd.end) {
            width = u32(b, to + off) >> 16;
            height = u32(b, to + off + 4) >> 16;
          }
        }
        const stsd = kid(b, kid(b, kid(b, mdia, "minf"), "stbl"), "stsd");
        if (stsd && stsd.start + stsd.hdr + 16 <= stsd.end) {
          codec = fourcc(b, stsd.start + stsd.hdr + 12);
        }
        if (h === "vide" || h === "soun") break;
      }
    }
    if (!trak) throw new Error("File thiếu luồng hình/tiếng (trak)");
    const mvexKids = kids(b, mvex);
    const trex = mvexKids.find((x) => x.type === "trex");
    const mehd = mvexKids.find((x) => x.type === "mehd");
    let durationSec = 0;
    if (mvhd) {
      const mvhdOff = mvhd.start + mvhd.hdr;
      const mvVer = b[mvhdOff];
      const mvhdScale = u32(b, mvhdOff + (mvVer === 1 ? 20 : 12)) || 1;
      const mvhdDur = mvVer === 1 ? u64(b, mvhdOff + 24) : u32(b, mvhdOff + 16);
      if (mvhdDur && mvhdDur !== 0xffffffff) durationSec = mvhdDur / mvhdScale;
    }

    const frags = [];
    let haveTimes = true;
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== "moof") continue;
      const moof = top[i];
      let end = moof.end;
      for (let j = i + 1; j < top.length && top[j].type !== "moof"; j++) {
        if (top[j].type === "mdat") end = top[j].end;
      }
      let time = null;
      let rawTime = 0;
      let ticks = 0;
      let tfdtRel = null;
      let tfdtVer = 0;
      const tfdt = kid(b, kid(b, moof, "traf"), "tfdt");
      if (tfdt) {
        const o = tfdt.start + tfdt.hdr;
        tfdtVer = b[o];
        tfdtRel = o - moof.start;
        ticks = tfdtVer === 1 ? u64(b, o + 4) : u32(b, o + 4);
        rawTime = ticks / timescale;
        time = rawTime;
      } else haveTimes = false;
      frags.push({ start: moof.start, moofHdr: moof.hdr, moofEnd: moof.end, end, time, rawTime, ticks, tfdtRel, tfdtVer });
    }
    if (!frags.length) throw new Error("File không có dữ liệu (không có moof)");
    if (!haveTimes) frags.forEach((f, i) => (f.time = i / frags.length));

    const ftyp = top.find((x) => x.type === "ftyp");
    return { b, ftyp, mvhd, trak, trex, mehd, handler, codec, width, height, timescale, durationSec, frags, haveTimes };
  }

  function inspect(b) {
    const p = parse(b);
    return {
      container: "fMP4 (ISO BMFF)",
      handler: p.handler,
      codec: p.codec || "unknown",
      width: p.width,
      height: p.height,
      timescale: p.timescale,
      durationSec: p.durationSec,
      fragments: p.frags.length,
      bytes: b.length,
    };
  }

  function retrack(b, trakBox, id) {
    const t = b.slice(trakBox.start, trakBox.end);
    const tkhd = boxes(t, trakBox.hdr, t.length).find((x) => x.type === "tkhd");
    const o = tkhd.start + tkhd.hdr;
    w32(t, o + (t[o] === 1 ? 20 : 12), id);
    return t;
  }

  function makeTrex(src, id) {
    let t;
    if (src) t = src.b.slice(src.box.start, src.box.end);
    else {
      t = makeBox("trex", [new Uint8Array(20)]);
      w32(t, 16, 1); // default_sample_description_index
    }
    w32(t, (src ? src.box.hdr : 8) + 4, id);
    return t;
  }

  function ftypBox() {
    const brands = ["isom", "iso6", "avc1", "mp41"];
    const p = new Uint8Array(8 + brands.length * 4);
    "isom".split("").forEach((c, i) => (p[i] = c.charCodeAt(0)));
    w32(p, 4, 512);
    brands.forEach((br, k) => br.split("").forEach((c, i) => (p[8 + k * 4 + i] = c.charCodeAt(0))));
    return makeBox("ftyp", [p]);
  }

  /**
   * @param {Uint8Array} b1  file hình hoặc tiếng
   * @param {Uint8Array} b2  file còn lại
   * @param {Function} [onProgress] callback (stage, pct)
   * @returns {Uint8Array}   MP4 có cả hình và tiếng
   */
  function mux(b1, b2, onProgress) {
    if (onProgress) onProgress("Phân tích hộp ISO BMFF (moov/moof)...", 10);
    let V = parse(b1);
    let A = parse(b2);
    if (V.handler === "soun" && A.handler === "vide") [V, A] = [A, V];
    if (V.handler !== "vide" || A.handler !== "soun") {
      throw new Error(`Cần 1 luồng hình + 1 luồng tiếng (nhận được: ${V.handler} + ${A.handler})`);
    }
    if (V.haveTimes !== A.haveTimes) {
      V.frags.forEach((f, i) => (f.time = i / V.frags.length));
      A.frags.forEach((f, i) => (f.time = i / A.frags.length));
    }

    // Chuẩn hóa baseMediaDecodeTime (tfdt) về mốc 0 khi luồng live/DASH bắt đầu muộn hoặc lệch epoch
    let vBaseSec = 0;
    let aBaseSec = 0;
    if (V.haveTimes && A.haveTimes && V.frags.length && A.frags.length) {
      const v0 = V.frags[0].rawTime || 0;
      const a0 = A.frags[0].rawTime || 0;
      if (Math.abs(v0 - a0) <= 10) {
        const common = Math.min(v0, a0);
        vBaseSec = common > 0.05 ? common : 0;
        aBaseSec = vBaseSec;
      } else {
        vBaseSec = v0 > 0.05 ? v0 : 0;
        aBaseSec = a0 > 0.05 ? a0 : 0;
      }
      V.frags.forEach((f) => (f.time = Math.max(0, f.rawTime - vBaseSec)));
      A.frags.forEach((f) => (f.time = Math.max(0, f.rawTime - aBaseSec)));
    }

    if (onProgress) onProgress("Tạo header moov & sắp xếp fragment...", 30);
    // moov mới: mvhd (video) + trak video(id 1) + trak audio(id 2) + mvex
    const mvhd = V.b.slice(V.mvhd.start, V.mvhd.end);
    w32(mvhd, mvhd.length - 4, 3); // next_track_ID
    const parts = [mvhd, retrack(V.b, V.trak, 1), retrack(A.b, A.trak, 2)];
    const mvexParts = [];
    if (V.mehd) mvexParts.push(V.b.slice(V.mehd.start, V.mehd.end));
    mvexParts.push(makeTrex(V.trex && { b: V.b, box: V.trex }, 1));
    mvexParts.push(makeTrex(A.trex && { b: A.b, box: A.trex }, 2));
    parts.push(makeBox("mvex", mvexParts));
    const moov = makeBox("moov", parts);
    const ftyp = ftypBox();

    // Xen kẽ các fragment theo thời gian
    const vDeltaTicks = Math.round(vBaseSec * V.timescale);
    const aDeltaTicks = Math.round(aBaseSec * A.timescale);
    const all = V.frags
      .map((f) => ({ f, src: V, id: 1, deltaTicks: vDeltaTicks }))
      .concat(A.frags.map((f) => ({ f, src: A, id: 2, deltaTicks: aDeltaTicks })));
    all.sort((x, y) => x.f.time - y.f.time || x.id - y.id);

    let total = ftyp.length + moov.length;
    for (const it of all) total += it.f.end - it.f.start;
    const out = new Uint8Array(total);
    out.set(ftyp, 0);
    out.set(moov, ftyp.length);
    let pos = ftyp.length + moov.length;
    let seq = 1;

    const step = Math.max(1, Math.floor(all.length / 10));
    for (let idx = 0; idx < all.length; idx++) {
      const { f, src, id, deltaTicks } = all[idx];
      out.set(src.b.subarray(f.start, f.end), pos);
      if (deltaTicks > 0 && f.tfdtRel != null) {
        const adj = Math.max(0, f.ticks - deltaTicks);
        const tfOff = pos + f.tfdtRel + 4;
        if (f.tfdtVer === 1) w64(out, tfOff, adj);
        else w32(out, tfOff, adj);
      }
      const moof = { start: pos, hdr: f.moofHdr, end: pos + (f.moofEnd - f.start) };
      for (const c of kids(out, moof)) {
        if (c.type === "mfhd") w32(out, c.start + c.hdr + 4, seq++);
        if (c.type !== "traf") continue;
        const tfhd = kid(out, c, "tfhd");
        if (!tfhd) continue;
        const o = tfhd.start + tfhd.hdr;
        const flags = u32(out, o) & 0xffffff;
        w32(out, o + 4, id);
        if (flags & 0x1) {
          // base_data_offset tuyệt đối -> dịch theo vị trí mới
          w64(out, o + 8, u64(out, o + 8) - f.start + pos);
        }
      }
      pos += f.end - f.start;
      if (onProgress && idx % step === 0) {
        onProgress(`Đang ghép ${idx + 1}/${all.length} đoạn dữ liệu...`, 35 + Math.round((idx / all.length) * 60));
      }
    }
    if (onProgress) onProgress("Hoàn tất đóng gói MP4", 100);
    return out;
  }

  root.FBVD_MP4 = { mux, parse, inspect, boxes };
  if (typeof module !== "undefined" && module.exports) module.exports = root.FBVD_MP4;
})(typeof self !== "undefined" ? self : globalThis);
