# StreamVault V2 (`v2.7.0`) — Hướng dẫn Public Chrome Web Store / Edge Add-ons / GitHub Release

> **Lưu ý minh bạch:** Mọi bước đóng gói, kiểm thử tự động Node QA + Chrome E2E, tạo ảnh Store 24-bit RGB và rà soát bảo mật Manifest V3 đã hoàn tất trên máy cục bộ. Việc **đăng nhập tài khoản nhà phát triển và nhấn nút Submit** cần bạn thực hiện trực tiếp bằng tài khoản Google / Microsoft / GitHub cá nhân của mình.

---

## 1. Bộ file sẵn sàng để Upload

| Thành phần | Đường dẫn | Thông số đã kiểm chứng |
|---|---|---|
| **Gói Extension ZIP** | `D:\Code\web\extension\StreamVault-V2-v2.7.0.zip` | 30 file sạch (MV3, `v2.7.0`, `minimum_chrome_version: 109`, không chứa file test/dev) |
| **Screenshot 1 (Video Library)** | `D:\Code\web\extension\store-assets\screenshot-1-library.png` | `1280×800`, 24-bit RGB PNG (không alpha) |
| **Screenshot 2 (Download Manager)** | `D:\Code\web\extension\store-assets\screenshot-2-downloads.png` | `1280×800`, 24-bit RGB PNG (không alpha) |
| **Screenshot 3 (Popup + Merge Studio)** | `D:\Code\web\extension\store-assets\screenshot-3-popup-merge.png` | `1280×800`, 24-bit RGB PNG (không alpha) |
| **Small Promo Tile** | `D:\Code\web\extension\store-assets\promo-small-440x280.png` | `440×280`, 24-bit RGB PNG (không alpha) |
| **Chính sách bảo mật** | `D:\Code\web\extension\PRIVACY_POLICY.md` | Cần host lấy URL HTTPS công khai (xem Bước 2) |

---

## 2. Chuẩn bị URL Chính sách Bảo mật (Bắt buộc với Chrome Web Store)

Chrome Web Store yêu cầu nhập một **URL HTTPS công khai** cho Chính sách bảo mật:
1. Tạo repository GitHub (public) hoặc GitHub Gist mới, dán nội dung file `D:\Code\web\extension\PRIVACY_POLICY.md`.
2. Nếu dùng GitHub Repo: link tới `https://github.com/<username>/<repo>/blob/main/PRIVACY_POLICY.md` (hoặc GitHub Pages `https://<username>.github.io/<repo>/privacy`).

---

## 3. Nội dung Copy-Paste cho Chrome Web Store Developer Dashboard

Truy cập: `https://chrome.google.com/webstore/devconsole` (phí đăng ký nhà phát triển Google một lần là \$5).

### A. Store Listing (Hiển thị cửa hàng)
- **Category:** `Productivity` hoặc `Tools`
- **Primary Language:** `Tiếng Việt` (hoặc `English`)

**Mô tả chi tiết (Detailed Description — Tiếng Việt):**
```text
StreamVault V2 giúp phát hiện và tải video, Story, Reel & Carousel Album trực tiếp ngay trên trình duyệt mà không cần gửi link qua bất kỳ website trung gian nào.

✦ TÍNH NĂNG NỔI BẬT:
• Hỗ trợ đa nền tảng: Facebook, TikTok, Instagram, Threads, Douyin, X (Twitter) và Xiaohongshu.
• Ghép DASH ngầm bằng Offscreen Document (MV3): Tự động ghép luồng hình + tiếng chuẩn fMP4 qua MP4Box cục bộ mà không mở thêm tab làm phiền; tự động mở Merge Studio (kèm lệnh FFmpeg gợi ý) nếu gặp stream đặc biệt.
• Đóng gói Slideshow thành 1 file .zip: Gom toàn bộ ảnh + nhạc nền từ TikTok / Instagram Carousel chỉ với 1 lần nhấn.
• Cảnh báo codec HEVC (hev1/hvc1) & AV1 (av01): Kiểm tra trước độ tương thích trình phát trước khi tải.
• Tải kèm phụ đề .SRT & Metadata .TXT: Tự động chuyển WebVTT sang SRT chuẩn UTF-8 và lưu chú thích/hashtag.
• Batch Profile Grabber: Tự cuộn thông minh theo giới hạn số lượng và tự dừng khi gặp video đã tải.
• Video Library & Download Manager: Xem trước video inline, lọc theo nền tảng/chất lượng, lưu trữ kho lịch sử lớn trong IndexedDB và xuất/nhập JSON/CSV.
• 100% Quyền riêng tư: Không quảng cáo, không tracking, không server ngoài — mọi thao tác diễn ra hoàn toàn trên máy của bạn.

⚠ Lưu ý: Vui lòng chỉ sử dụng extension để lưu trữ nội dung thuộc quyền sở hữu của bạn hoặc được phép tải xuống theo điều khoản của nền tảng.
```

**English Description (nếu bật thêm ngôn ngữ EN):**
```text
StreamVault V2 detects and downloads HD videos, Stories, Reels, and Carousel Albums locally in your browser with zero third-party servers or tracking.

KEY FEATURES:
• Multi-Platform Capture: Facebook, TikTok, Instagram, Threads, Douyin, X (Twitter), and Xiaohongshu.
• Silent Offscreen DASH Muxing: Combines split DASH video + audio streams locally using pure-JS fMP4 muxing (with interactive Merge Studio fallback).
• Pure-JS Slideshow ZIP Packaging: Bundles multi-photo/clip carousels and background audio into a clean single .zip file.
• HEVC & AV1 Codec Compatibility Alerts: Preview stream codecs before downloading.
• Subtitle (.SRT) & Caption Sidecar (.TXT): Automatic WebVTT-to-SRT conversion and metadata archiving.
• Smart Batch Profile Grabber, Inline Video Preview Modal, Persistent Download Queue, IndexedDB Archive, and JSON/CSV backup.
• 100% Privacy First: Zero analytics, zero remote font/script requests, zero external upload.
```

---

### B. Privacy Practices Tab (Bắt buộc — Điền chuẩn để duyệt nhanh)

1. **Single Purpose Description (Mục đích duy nhất):**
   ```text
   Allows users to detect, preview, mux locally, and download user-requested videos, carousels, slideshows, and subtitles from supported social media pages in their browser.
   ```

2. **Permission Justifications (Giải trình từng quyền):**

- **`downloads`**:
  ```text
  Required to save user-initiated video, muxed MP4, slideshow ZIP, SRT subtitle, and TXT caption files into the user's Downloads folder and reveal completed files on demand.
  ```
- **`webRequest`**:
  ```text
  Passively inspects media stream request URLs (.mp4, .m4a, .mpd) on active supported social media tabs so adaptive video streams can be identified locally without contacting external APIs.
  ```
- **`storage`**:
  ```text
  Stores extension settings, download queue history (chrome.storage.local), and active tab stream metadata (chrome.storage.session) exclusively on the user's device.
  ```
- **`contextMenus`**:
  ```text
  Adds right-click shortcuts to open the extension's Video Library and Download Manager pages.
  ```
- **`offscreen`**:
  ```text
  Creates a temporary hidden MV3 offscreen document to perform CPU-bound local MP4 DASH muxing and Store ZIP assembly in the background without opening a visible tab.
  ```
- **`declarativeNetRequestWithHostAccess`**:
  ```text
  Applies static rules.json header rules strictly for supported social media CDN requests initiated by the extension so media fetches include valid Referer/Origin headers and do not return 403 errors.
  ```
- **`Host permissions` (`facebook.com`, `fbcdn.net`, `tiktok.com`, `instagram.com`, `threads.net`, `douyin.com`, `x.com`, `twitter.com`, `xiaohongshu.com` & CDNs)**:
  ```text
  Required solely to run the in-page media parser on those specific supported websites and fetch media segments directly from their content delivery networks inside the browser. No other websites are accessed.
  ```

3. **Are you using remote code?**
   - Chọn **No, I am not using remote code** (toàn bộ `Inter` fonts, `mp4mux.js`, `sv-zip.js`, `sv-dash.js`, `sv-db.js`, `parser.js` đều được đóng gói cục bộ 100% trong ZIP).

4. **Data Usage Disclosures (Khai báo dữ liệu):**
   - Không tích chọn bất kỳ mục thu thập dữ liệu nào (*Personally identifiable information*, *Web history*, *User activity*... đều để **trống**) và xác nhận 3 ô cam kết: dữ liệu chỉ xử lý cục bộ, không bán cho bên thứ ba, không dùng vào mục đích ngoài Single Purpose.

---

## 4. Quy trình Submit lên các kênh

1. **Chrome Web Store (`chrome.google.com/webstore/devconsole`):**
   - Bấm **+ New Item** -> tải lên `D:\Code\web\extension\StreamVault-V2-v2.7.0.zip`.
   - Điền **Store Listing** -> upload 3 ảnh `1280×800` + `promo-small-440x280.png` + `icons/icon128.png`.
   - Điền **Privacy** -> dán URL `PRIVACY_POLICY.md`, Single Purpose, Permission Justifications, chọn **No remote code**.
   - Bấm **Save draft** -> **Submit for Review** (thời gian duyệt CWS thường 1–3 ngày làm việc).

2. **Microsoft Edge Add-ons (`partner.microsoft.com/en-us/dashboard/microsoftedge/overview`):**
   - Đăng ký hoàn toàn **miễn phí** bằng tài khoản Microsoft.
   - Có thể tải trực tiếp cùng file `StreamVault-V2-v2.7.0.zip` và bộ ảnh `store-assets/`.

3. **GitHub Releases (Phát hành trực tiếp cho người dùng cài Developer Mode):**
   - Đính kèm `StreamVault-V2-v2.7.0.zip` làm Release Asset, kèm hướng dẫn giải nén -> bật **Developer mode** tại `chrome://extensions` -> **Load unpacked** (hoặc kéo thả).
