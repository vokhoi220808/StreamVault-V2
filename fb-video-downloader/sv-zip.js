// StreamVault V2 — Pure JS Uncompressed ZIP Store Builder (Zero Dependencies, CSP Safe)
// Works in Browser Window, Offscreen Document, Service Worker, and Node.js.
(function (root) {
  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const encoder = new TextEncoder();

  function dosTimeDate(date) {
    const d = date instanceof Date ? date : new Date();
    const yr = Math.max(1980, d.getFullYear()) - 1980;
    const dosTime = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    const dosDate = ((yr & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { dosTime, dosDate };
  }

  /**
   * @param {Array<{name: string, data: Uint8Array, date?: Date}>} entries
   * @returns {Uint8Array}
   */
  function createZip(entries) {
    const prepared = [];
    const seenNames = new Set();
    let localTotal = 0;
    let cdTotal = 0;

    for (const raw of entries || []) {
      if (!raw || !raw.data) continue;
      let cleanName = String(raw.name || "file.bin").replace(/^\/+/, "").replace(/\.\.+/g, "_");
      if (seenNames.has(cleanName)) {
        const dot = cleanName.lastIndexOf(".");
        let n = 2;
        while (seenNames.has(dot > 0 ? `${cleanName.slice(0, dot)}_${n}${cleanName.slice(dot)}` : `${cleanName}_${n}`)) n++;
        cleanName = dot > 0 ? `${cleanName.slice(0, dot)}_${n}${cleanName.slice(dot)}` : `${cleanName}_${n}`;
      }
      seenNames.add(cleanName);

      const data = raw.data instanceof Uint8Array ? raw.data : new Uint8Array(raw.data);
      const nameBytes = encoder.encode(cleanName);
      const crc = crc32(data);
      const { dosTime, dosDate } = dosTimeDate(raw.date);
      const offset = localTotal;

      localTotal += 30 + nameBytes.length + data.length;
      cdTotal += 46 + nameBytes.length;
      prepared.push({ nameBytes, data, crc, dosTime, dosDate, offset });
    }

    const totalLen = localTotal + cdTotal + 22;
    const out = new Uint8Array(totalLen);
    const view = new DataView(out.buffer);
    let pos = 0;

    // 1) Local file headers + payloads
    for (const f of prepared) {
      view.setUint32(pos, 0x04034b50, true);
      view.setUint16(pos + 4, 20, true); // version needed
      view.setUint16(pos + 6, 0x0800, true); // UTF-8 filename flag
      view.setUint16(pos + 8, 0, true); // compression method: 0 (store)
      view.setUint16(pos + 10, f.dosTime, true);
      view.setUint16(pos + 12, f.dosDate, true);
      view.setUint32(pos + 14, f.crc, true);
      view.setUint32(pos + 18, f.data.length, true);
      view.setUint32(pos + 22, f.data.length, true);
      view.setUint16(pos + 26, f.nameBytes.length, true);
      view.setUint16(pos + 28, 0, true);
      out.set(f.nameBytes, pos + 30);
      out.set(f.data, pos + 30 + f.nameBytes.length);
      pos += 30 + f.nameBytes.length + f.data.length;
    }

    const cdStart = pos;
    // 2) Central directory headers
    for (const f of prepared) {
      view.setUint32(pos, 0x02014b50, true);
      view.setUint16(pos + 4, 20, true);
      view.setUint16(pos + 6, 20, true);
      view.setUint16(pos + 8, 0x0800, true);
      view.setUint16(pos + 10, 0, true);
      view.setUint16(pos + 12, f.dosTime, true);
      view.setUint16(pos + 14, f.dosDate, true);
      view.setUint32(pos + 16, f.crc, true);
      view.setUint32(pos + 20, f.data.length, true);
      view.setUint32(pos + 24, f.data.length, true);
      view.setUint16(pos + 28, f.nameBytes.length, true);
      view.setUint16(pos + 30, 0, true);
      view.setUint16(pos + 32, 0, true);
      view.setUint16(pos + 34, 0, true);
      view.setUint16(pos + 36, 0, true);
      view.setUint32(pos + 38, 0, true);
      view.setUint32(pos + 42, f.offset, true);
      out.set(f.nameBytes, pos + 46);
      pos += 46 + f.nameBytes.length;
    }

    // 3) End of Central Directory (EOCD)
    view.setUint32(pos, 0x06054b50, true);
    view.setUint16(pos + 4, 0, true);
    view.setUint16(pos + 6, 0, true);
    view.setUint16(pos + 8, prepared.length, true);
    view.setUint16(pos + 10, prepared.length, true);
    view.setUint32(pos + 12, cdTotal, true);
    view.setUint32(pos + 16, cdStart, true);
    view.setUint16(pos + 20, 0, true);

    return out;
  }

  root.SV_ZIP = { createZip, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SV_ZIP;
})(typeof self !== "undefined" ? self : globalThis);
