# Privacy Policy — StreamVault V2

**Effective Date:** November 25, 2026  
**Extension:** StreamVault V2 — Video Downloader (`v2.7.0`, Manifest V3)

---

## 1. Summary (Zero Collection, 100% Local Processing)

StreamVault V2 operates **100% locally inside your web browser**. The extension does **not** run any backend server, does **not** include analytics or telemetry scripts, does **not** inject ads or affiliate links, and does **not** collect, store remotely, share, or sell any personal or browsing data.

## 2. Information Processed Locally on Your Device

StreamVault V2 only inspects media metadata and CDN media stream URLs inside browser tabs belonging to explicitly supported platforms (`facebook.com`, `tiktok.com`, `instagram.com`, `threads.net`, `threads.com`, `douyin.com`, `x.com`, `twitter.com`, `xiaohongshu.com` and their media CDNs) when you visit those pages.

All extension state stays exclusively on your device:

| Storage Mechanism | Purpose | Leaves Your Device? |
|---|---|---|
| `chrome.storage.local` | User preferences (`settings`), recent download job queue (`sv_jobs`, capped at 150 items), and sanitized local diagnostic error logs (signed CDN query tokens are stripped via `sanitizeDiagnostics`). | **No** |
| Browser `IndexedDB` (`SV_DB`) | Local archive of completed download history beyond the recent 150-job window, enabling duplicate detection (`Skip downloaded`) and JSON/CSV export. | **No** |
| `chrome.storage.session` | Temporary in-memory cache of media stream URLs discovered in currently open tabs; cleared automatically when tabs or browser close. | **No** |
| Offscreen Document / Blob URL | Local browser muxing of split DASH video/audio streams (`mp4mux.js`) and packing slideshows into `.zip` archives (`sv-zip.js`). Processed in RAM and saved directly to your Chrome `Downloads` folder. | **No** |

## 3. Permissions Usage Explanation

- **`downloads`**: Save downloaded videos, muxed `.mp4` files, slideshow `.zip` archives, `.srt` subtitles, and `.txt` caption sidecars to your chosen subfolder, and open/show finished files on request.
- **`webRequest`**: Passively observe `.mp4`, `.m4a`, `.mpd`, and media segment requests from active supported social-media tabs so adaptive/DASH streams can be detected reliably.
- **`storage`**: Persist your local extension settings, download queue, and diagnostic preferences inside Chrome local/session storage.
- **`contextMenus`**: Provide right-click menu access to open Video Library or Download Manager.
- **`offscreen`**: Run MP4 fMP4 DASH muxing and pure-JS Store ZIP creation silently in a MV3 offscreen document without interrupting your browsing with extra tabs.
- **`declarativeNetRequestWithHostAccess`**: Apply static `rules.json` request header rules solely for supported media CDNs (`Referer` / `Origin` compliance during direct CDN media fetches) so downloads do not fail with HTTP 403.
- **Host Permissions (`facebook.com`, `fbcdn.net`, `tiktok.com`, `instagram.com`, `threads.net`, `douyin.com`, `x.com`, `twitter.com`, `xiaohongshu.com` & associated CDNs)**: Inject the media extractor only on those specific platforms and fetch their user-requested video/audio/subtitle files locally.

## 4. Third-Party Services & Data Sharing

StreamVault V2 loads zero external fonts, scripts, tracking pixels, or remote configuration files (`default-src` / local bundled `Inter` `.woff2` fonts only). When you click **Download**, your browser fetches the media directly from the platform CDN where the media is hosted—no proxy server is ever contacted.

## 5. User Control & Data Deletion

- You can clear all download history, IndexedDB archives, and logs anytime inside **Download Manager** (`Xóa kho lưu`) or reset settings in **Settings Center**.
- Uninstalling StreamVault V2 from `chrome://extensions` immediately removes all extension storage and IndexedDB data stored by the extension.

## 6. Contact

For questions or privacy requests regarding StreamVault V2, please open an issue in the project repository or contact the developer listed on the extension's Web Store support tab.

---

# Chính sách Quyền riêng tư (Tiếng Việt)

- **Không thu thập dữ liệu:** StreamVault V2 hoạt động 100% cục bộ trên trình duyệt của bạn, không có máy chủ trung gian, không chèn quảng cáo, không theo dõi (analytics/telemetry) và không bán hay chia sẻ dữ liệu người dùng.
- **Lưu trữ cục bộ:** Mọi cài đặt (`chrome.storage.local`), bộ nhớ đệm phiên tab (`chrome.storage.session`), kho lưu trữ lịch sử (`IndexedDB`), ghép DASH (`offscreen` + `mp4mux.js`) và đóng gói `.zip` chỉ nằm trên máy của bạn. Log chẩn đoán tự động cắt bỏ các tham số token ký CDN trước khi lưu.
- **Xóa dữ liệu:** Bạn có thể xóa kho lưu trữ trong giao diện **Download Manager**, hoặc gỡ cài đặt extension để xóa toàn bộ dữ liệu cục bộ.
