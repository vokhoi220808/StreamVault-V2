// StreamVault V2 — Lightweight IndexedDB Long-Term Archive for Completed Jobs & Video IDs
// Keeps chrome.storage.local lightweight while remembering thousands of downloaded video IDs.
(function (root) {
  const DB_NAME = "streamvault_v2";
  const DB_VERSION = 1;
  const STORE = "history";

  function openDb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const st = db.createObjectStore(STORE, { keyPath: "id" });
            st.createIndex("videoId", "videoId", { unique: false });
            st.createIndex("completedAt", "completedAt", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function archiveJobs(jobs) {
    const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.id);
    if (!list.length) return 0;
    const db = await openDb();
    if (!db) return 0;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const st = tx.objectStore(STORE);
        for (const j of list) {
          // Store compact immutable summary (strip heavy transient segment/zip arrays)
          st.put({
            id: j.id,
            videoId: j.videoId ? String(j.videoId) : "",
            platform: j.platform || "facebook",
            status: j.status || "completed",
            kind: j.kind || "direct",
            filename: j.filename || "",
            title: j.title || "",
            author: j.author || "",
            quality: j.quality || "",
            sourceUrl: j.sourceUrl || "",
            bytesReceived: j.bytesReceived || 0,
            totalBytes: j.totalBytes || 0,
            createdAt: j.createdAt || Date.now(),
            completedAt: j.completedAt || j.updatedAt || Date.now(),
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve(list.length);
        };
        tx.onerror = () => {
          db.close();
          resolve(0);
        };
      } catch (e) {
        try { db.close(); } catch (_) {}
        resolve(0);
      }
    });
  }

  async function getArchivedSummary(limit = 5000) {
    const db = await openDb();
    if (!db) return { jobs: [], videoIds: [] };
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const st = tx.objectStore(STORE);
        const out = [];
        const ids = new Set();
        const req = st.openCursor(null, "prev");
        req.onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur || out.length >= limit) {
            db.close();
            resolve({ jobs: out, videoIds: Array.from(ids) });
            return;
          }
          const val = cur.value;
          if (val && val.status === "completed" && val.videoId) ids.add(String(val.videoId));
          out.push(val);
          cur.continue();
        };
        req.onerror = () => {
          db.close();
          resolve({ jobs: [], videoIds: [] });
        };
      } catch (e) {
        try { db.close(); } catch (_) {}
        resolve({ jobs: [], videoIds: [] });
      }
    });
  }

  async function clearArchive() {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); resolve(false); };
      } catch (e) {
        try { db.close(); } catch (_) {}
        resolve(false);
      }
    });
  }

  root.SV_DB = { archiveJobs, getArchivedSummary, clearArchive };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SV_DB;
})(typeof self !== "undefined" ? self : globalThis);
