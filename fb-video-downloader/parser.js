// Bộ phân tích dùng chung: tìm link video trong JSON / HTML của Facebook.
// Nạp ở cả MAIN world (inject.js) và ISOLATED world (content.js).
(function () {
  if (window.__FBVD_PARSER__) return;

  const KEYWORDS =
    /browser_native_(hd|sd)_url|playable_url|hd_src|sd_src|progressive_url|representations|manifest_xml|dash_manifest|<MPD|SegmentTemplate|SegmentList|playAddr|downloadAddr|bitrateInfo|play_addr|bit_rate|imagePost|video_versions|video_dash_manifest|carousel_media|reel_type|reels_media|story_bucket|claInfo|cla_info|subtitleInfos|captions_url|subtitles_src|video_info|imageList|__INITIAL_STATE__/;

  const pick = (...vals) => vals.find((v) => typeof v === "string" && v.length > 0) || "";
  const isNumId = (v) => /^\d+$/.test(String(v || ""));
  const normId = (v) => {
    const s = String(v || "").split("_")[0];
    return /^\d+$/.test(s) ? s : "";
  };
  const shortSide = (w, h) => (w && h ? Math.min(w, h) : h || w || 0);

  function getTitle(n) {
    return pick(
      n.title && n.title.text,
      typeof n.title === "string" ? n.title : "",
      n.savable_description && n.savable_description.text,
      n.message && n.message.text,
      n.caption && n.caption.text,
      typeof n.caption === "string" ? n.caption : "",
      n.legacy && n.legacy.full_text,
      typeof n.full_text === "string" ? n.full_text : "",
      typeof n.desc === "string" ? n.desc : "",
      typeof n.text === "string" ? n.text : "",
      typeof n.name === "string" ? n.name : ""
    );
  }

  function getThumb(n) {
    const igCand = n.image_versions2 && Array.isArray(n.image_versions2.candidates) && n.image_versions2.candidates[0];
    return pick(
      n.preferred_thumbnail && n.preferred_thumbnail.image && n.preferred_thumbnail.image.uri,
      n.thumbnailImage && n.thumbnailImage.uri,
      n.first_frame_thumbnail,
      n.thumbnail_url,
      n.image && n.image.uri,
      igCand && igCand.url
    );
  }

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return "x" + (h >>> 0).toString(36);
  }

  function merge(out, v) {
    const old = out[v.id];
    if (!old) {
      out[v.id] = v;
      return;
    }
    for (const k of Object.keys(v)) {
      if (k === "dashVideo" || k === "dashAudio") {
        if (v[k] && (!old[k] || (v[k].bandwidth || 0) > (old[k].bandwidth || 0))) old[k] = v[k];
      } else if (k === "subtitles" && Array.isArray(v.subtitles)) {
        const cur = Array.isArray(old.subtitles) ? old.subtitles.slice() : [];
        for (const st of v.subtitles) {
          if (st && st.url && !cur.some((x) => x.url === st.url)) cur.push(st);
        }
        if (cur.length) old.subtitles = cur;
      } else if (v[k] && !old[k]) {
        old[k] = v[k];
      }
    }
  }

  function extractSubtitles(n, tv) {
    const out = [];
    const push = (url, lang, format) => {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
      if (out.some((x) => x.url === url)) return;
      out.push({
        url,
        lang: String(lang || "und").slice(0, 16),
        format: String(format || (/\.srt\b/i.test(url) ? "srt" : "vtt")).toLowerCase(),
      });
    };
    if (n) {
      push(n.captions_url, "und", "srt");
      push(n.subtitles_src, "und", "srt");
      push(n.subtitle_url, "und", "vtt");
      if (Array.isArray(n.caption_locales)) {
        for (const c of n.caption_locales) {
          if (c) push(c.uri || c.url, c.locale || c.lang, c.format || "srt");
        }
      }
    }
    const src = tv || n;
    if (src) {
      const cla = (src.claInfo && src.claInfo.captionInfos) || (src.cla_info && src.cla_info.caption_infos) || src.subtitleInfos;
      if (Array.isArray(cla)) {
        for (const c of cla) {
          if (!c) continue;
          const u = c.url || c.Url || (Array.isArray(c.urlList) && c.urlList[0]);
          const fmt = c.captionFormat || c.CaptionFormat || c.format || "vtt";
          push(u, c.lang || c.languageCode || c.LanguageCodeName || c.LanguageCode, fmt);
        }
      }
    }
    return out;
  }

  function resolveMpdUrl(base, rel) {
    const u = String(rel || "").trim().replace(/&amp;/g, "&");
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (!base) return u;
    try {
      return new URL(u, base).href;
    } catch (e) {
      return u;
    }
  }

  function parseIsoDur(s) {
    const m = String(s || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/i);
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function expandMpdTpl(tpl, repId, num, time, bw) {
    return String(tpl || "")
      .replace(/\$RepresentationID\$/g, () => repId || "")
      .replace(/\$Bandwidth\$/g, () => String(bw || 0))
      .replace(/\$Time\$/g, () => String(time || 0))
      .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => {
        const str = String(num);
        return pad ? str.padStart(Number(pad), "0") : str;
      })
      .replace(/\$\$/g, () => "$");
  }

  // Ngữ cảnh từ object cha (Facebook Video, Instagram Media, hoặc Tweet trên X)
  function videoCtx(n, parent) {
    const isTweet =
      (n.__typename === "Tweet" || (n.rest_id && n.legacy && (n.legacy.full_text !== undefined || n.legacy.extended_entities))) &&
      isNumId(n.rest_id);
    if (isTweet) {
      const uRes = n.core && n.core.user_results && n.core.user_results.result;
      const uLeg = (uRes && (uRes.legacy || uRes.core)) || {};
      return {
        id: String(n.rest_id),
        platform: "x",
        title: (n.legacy && n.legacy.full_text) || "",
        thumb: "",
        owner: uLeg.screen_name || uLeg.name || "",
        duration: 0,
      };
    }

    const isFbStory = !!(n.story_bucket_owner || n.unified_stories || n.__typename === "StoryCard");
    if (isFbStory) {
      const bOwner = (n.story_bucket_owner && n.story_bucket_owner.name) || (n.owner && n.owner.name) || (parent && parent.owner) || "";
      const sid = [n.id, n.story_id].map(normId).find(Boolean) || (parent && parent.id);
      if (sid || bOwner) {
        return {
          id: sid || (bOwner ? "fbstory_" + simpleHash(bOwner) : undefined),
          platform: "facebook",
          isStory: true,
          title: (parent && parent.title) || (bOwner ? `[Story] ${bOwner}` : "[FB Story]"),
          thumb: getThumb(n) || (parent && parent.thumb) || "",
          owner: bOwner,
          duration: 0,
        };
      }
    }

    const looksVideo =
      n.__typename === "Video" ||
      n.videoDeliveryLegacyFields ||
      n.videoDeliveryResponseFragment ||
      n.playable_duration_in_ms ||
      n.preferred_thumbnail ||
      Array.isArray(n.video_versions) ||
      Array.isArray(n.carousel_media) ||
      !!n.video_dash_manifest;
    const id = [n.pk, n.id, n.videoId, n.video_id].map(normId).find(Boolean);
    if (!looksVideo || !id) return parent;
    const igPlat =
      Array.isArray(n.video_versions) || Array.isArray(n.carousel_media) || n.video_dash_manifest
        ? n.text_post_app_info || (typeof location !== "undefined" && /threads\.(net|com)/i.test(location.hostname))
          ? "threads"
          : "instagram"
        : "";
    return {
      id,
      code: n.code || (parent && parent.code) || undefined,
      isStory: !!(parent && parent.isStory),
      platform: igPlat || (parent && parent.platform) || undefined,
      title: getTitle(n) || (parent && parent.title) || "",
      thumb: getThumb(n) || (parent && parent.thumb) || "",
      owner: (n.owner && n.owner.name) || (n.user && (n.user.username || n.user.full_name)) || (parent && parent.owner) || "",
      duration: n.playable_duration_in_ms || (n.length_in_second || n.video_duration || 0) * 1000 || 0,
    };
  }

  // Phân tích DASH manifest (XML) -> BaseURL, SegmentList, SegmentTemplate, & Text/VTT subtitles
  function parseMpd(xml) {
    let bestV = null;
    let bestA = null;
    const subtitles = [];
    const attr = (s, name) => {
      const m = s.match(new RegExp("(?:^|\\s)" + name + '="([^"]*)"'));
      return m ? m[1] : "";
    };
    const mpdHead = (xml.match(/<MPD\b([^>]*)>/) || [])[1] || "";
    const mpdDurSec = parseIsoDur(attr(mpdHead, "mediaPresentationDuration"));
    const directBase = (tagBody) => {
      const m = tagBody.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/);
      return m ? m[1].trim().replace(/&amp;/g, "&") : "";
    };
    const mpdBase = directBase(xml.slice(0, xml.indexOf("<Period") !== -1 ? xml.indexOf("<Period") : 500));

    function extractSegmentSpec(block, setTplTag, repId, bw, base) {
      // 1) SegmentList
      const sl = block.match(/<SegmentList\b[\s\S]*?<\/SegmentList>/);
      if (sl) {
        const initM = sl[0].match(/<Initialization\b[^>]*sourceURL="([^"]*)"/);
        const initUrl = initM ? resolveMpdUrl(base, initM[1]) : "";
        const segs = [];
        const sRe = /<SegmentURL\b[^>]*media="([^"]*)"/g;
        let sm;
        while ((sm = sRe.exec(sl[0]))) segs.push(resolveMpdUrl(base, sm[1]));
        if (initUrl || segs.length) return { url: initUrl || segs[0], initUrl, segments: segs };
      }

      // 2) SegmentTemplate (trên Representation hoặc thừa kế từ AdaptationSet)
      const segTplRe = /<SegmentTemplate\b[^>]*\/>|<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/;
      const repTpl = (block.match(segTplRe) || [])[0] || "";
      const tplBlock = repTpl || setTplTag || "";
      if (!tplBlock) return null;

      const tplHead = tplBlock.slice(0, tplBlock.indexOf(">") + 1);
      const initTpl = attr(tplHead, "initialization");
      const mediaTpl = attr(tplHead, "media");
      if (!mediaTpl) return null;

      const timescale = +attr(tplHead, "timescale") || 1;
      const startNum = +attr(tplHead, "startNumber") || 1;
      const segDur = +attr(tplHead, "duration") || 0;
      const initUrl = initTpl ? resolveMpdUrl(base, expandMpdTpl(initTpl, repId, startNum, 0, bw)) : "";
      const segs = [];

      const tlM = tplBlock.match(/<SegmentTimeline\b[\s\S]*?<\/SegmentTimeline>/);
      if (tlM) {
        const sTags = tlM[0].match(/<S\b[^>]*\/?>/g) || [];
        let curT = 0;
        let curNum = startNum;
        for (const st of sTags) {
          const tAttr = attr(st, "t");
          if (tAttr !== "") curT = +tAttr;
          const dVal = +attr(st, "d") || 0;
          const rVal = Math.min(2000, Math.max(0, +attr(st, "r") || 0));
          for (let k = 0; k <= rVal && segs.length < 2000; k++) {
            segs.push(resolveMpdUrl(base, expandMpdTpl(mediaTpl, repId, curNum++, curT, bw)));
            curT += dVal;
          }
        }
      } else if (segDur > 0 && mpdDurSec > 0) {
        const count = Math.min(2000, Math.max(1, Math.ceil((mpdDurSec * timescale) / segDur)));
        for (let k = 0; k < count; k++) {
          segs.push(resolveMpdUrl(base, expandMpdTpl(mediaTpl, repId, startNum + k, k * segDur, bw)));
        }
      }

      if (initUrl || segs.length) return { url: initUrl || segs[0], initUrl, segments: segs };
      return null;
    }

    const sets = xml.split(/<AdaptationSet\b/).slice(1);
    for (const set of sets) {
      const setHead = set.slice(0, set.indexOf(">"));
      const setPrefix = set.slice(0, set.indexOf("<Representation") !== -1 ? set.indexOf("<Representation") : set.length);
      const setBase = resolveMpdUrl(mpdBase, directBase(setPrefix)) || mpdBase;
      const setTpl = (setPrefix.match(/<SegmentTemplate\b[^>]*\/>|<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/) || [])[0] || "";
      const reps = set.match(/<Representation\b[\s\S]*?<\/Representation>/g) || [];
      for (const rep of reps) {
        const head = rep.slice(0, rep.indexOf(">"));
        const mime = attr(head, "mimeType") || attr(setHead, "mimeType") || attr(setHead, "contentType");
        const repId = attr(head, "id");
        const bw = +attr(head, "bandwidth") || 0;
        const codecs = attr(head, "codecs") || attr(setHead, "codecs") || "";
        const rw = +attr(head, "width") || 0;
        const rh = +attr(head, "height") || +attr(head, "FBQualityLabel").replace(/\D/g, "") || 0;

        let url = "";
        let initUrl = "";
        let segments = null;
        const bu = rep.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/);
        const repBase = bu ? resolveMpdUrl(setBase, bu[1]) : setBase;
        const tplSpec = extractSegmentSpec(rep, setTpl, repId, bw, repBase);

        if (tplSpec && tplSpec.segments && tplSpec.segments.length) {
          url = tplSpec.url;
          initUrl = tplSpec.initUrl;
          segments = tplSpec.segments;
        } else if (bu) {
          url = repBase;
        } else {
          continue;
        }

        const r = {
          url,
          initUrl: initUrl || undefined,
          segments: segments || undefined,
          bandwidth: bw,
          height: shortSide(rw, rh),
          codecs: codecs || undefined,
        };
        if (/text|vtt|subtitle/i.test(mime) || /wvtt|stpp/i.test(codecs)) {
          const lang = attr(head, "lang") || attr(setHead, "lang") || "und";
          if (!subtitles.some((x) => x.url === url)) subtitles.push({ url, lang, format: "vtt" });
        } else if (/audio/.test(mime)) {
          if (!bestA || r.bandwidth > bestA.bandwidth) bestA = r;
        } else if (!bestV || r.bandwidth > bestV.bandwidth) bestV = r;
      }
    }
    return { bestV, bestA, subtitles };
  }

  function walk(root, out) {
    const stack = [[root, null]];
    const handledSlides = new WeakSet();
    let guard = 0;
    while (stack.length && guard++ < 800000) {
      const [n, parentCtx] = stack.pop();
      if (!n || typeof n !== "object" || handledSlides.has(n)) continue;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) stack.push([n[i], parentCtx]);
        continue;
      }
      const ctx = videoCtx(n, parentCtx);
      const ownId = [n.pk, n.id, n.videoId, n.video_id].map(normId).find(Boolean);
      const idFor = (url) => (ownId || (ctx && ctx.id) || simpleHash(url));
      const base = (id) => {
        const c = ctx && ctx.id === id ? ctx : {};
        return {
          id,
          code: n.code || c.code || undefined,
          isStory: c.isStory || (parentCtx && parentCtx.isStory) || undefined,
          platform: c.platform || undefined,
          title: getTitle(n) || c.title || "",
          thumb: getThumb(n) || c.thumb || "",
          owner: (n.owner && n.owner.name) || (n.user && (n.user.username || n.user.full_name)) || c.owner || "",
          duration: n.playable_duration_in_ms || (n.length_in_second || n.video_duration || 0) * 1000 || c.duration || 0,
        };
      };

      // 1) Kiểu cũ: browser_native_hd_url / playable_url ...
      let hd = pick(n.browser_native_hd_url, n.playable_url_quality_hd, n.hd_src, n.hd_src_no_ratelimit);
      let sd = pick(n.browser_native_sd_url, n.playable_url, n.sd_src, n.sd_src_no_ratelimit);

      // 2) Kiểu mới: progressive_urls: [{progressive_url, metadata:{quality:"HD"|"SD"}}]
      if (Array.isArray(n.progressive_urls)) {
        for (const p of n.progressive_urls) {
          if (!p || !p.progressive_url) continue;
          const q = ((p.metadata && p.metadata.quality) || "").toUpperCase();
          if (q === "HD" && !hd) hd = p.progressive_url;
          else if (!sd) sd = p.progressive_url;
        }
      }
      const directSubs = extractSubtitles(n, null);
      if (hd || sd || directSubs.length) {
        const baseObj = base(idFor(hd || sd || directSubs[0].url));
        if (parentCtx && parentCtx.isStory) baseObj.isStory = true;
        merge(out, Object.assign(baseObj, { hd, sd, subtitles: directSubs.length ? directSubs : undefined }));
      }

      // 1b) Facebook Photo Story attachment inside unified_stories / bucket
      if (parentCtx && parentCtx.isStory && n.__typename === "Photo" && n.image && n.image.uri) {
        const photoId = normId(n.id) || parentCtx.id || simpleHash(n.image.uri);
        merge(out, {
          id: photoId,
          platform: "facebook",
          isStory: true,
          images: [n.image.uri],
          title: parentCtx.title || "[Story] Facebook",
          thumb: n.image.uri,
          owner: parentCtx.owner || "",
        });
      }

      // 3) DASH dạng mảng representations
      if (Array.isArray(n.representations)) {
        let bestV = null;
        let bestA = null;
        for (const r of n.representations) {
          if (!r || !r.base_url) continue;
          const mime = r.mime_type || "";
          const rr = {
            url: r.base_url,
            height: shortSide(r.width || 0, r.height || 0),
            bandwidth: r.bandwidth || 0,
            codecs: r.codecs || undefined,
          };
          if (mime.startsWith("audio")) {
            if (!bestA || rr.bandwidth > bestA.bandwidth) bestA = rr;
          } else if (!bestV || rr.bandwidth > bestV.bandwidth) bestV = rr;
        }
        if (bestV || bestA) {
          merge(out, Object.assign(base(idFor((bestV || bestA).url)), { dashVideo: bestV, dashAudio: bestA }));
        }
      }

      // 4) TikTok & Douyin item (video / bit_rate / imagePost / images / music)
      const tv = n.video;
      const ip = n.imagePost;
      const dyImages = Array.isArray(n.images) && n.images.length && n.aweme_id ? n.images : null;
      if (
        (tv && typeof tv === "object" && (tv.playAddr || tv.downloadAddr || tv.bitrateInfo || tv.bit_rate || tv.play_addr)) ||
        (ip && Array.isArray(ip.images) && ip.images.length > 0) ||
        dyImages
      ) {
        const pickUrl = (u) => {
          if (typeof u === "string" && u.startsWith("http")) return u;
          const arr = u && (u.UrlList || u.url_list || u.urlList);
          return Array.isArray(arr) ? arr.find((x) => typeof x === "string" && x.startsWith("http")) || "" : "";
        };
        let bestUrl = "";
        let bestBr = -1;
        let bestH = 0;
        let bestCodec = "";
        let bestSize = 0;
        const variants = [];
        const brList = (tv && (tv.bitrateInfo || tv.bit_rate)) || [];
        if (Array.isArray(brList)) {
          for (const bi of brList) {
            const pa = bi && (bi.PlayAddr || bi.play_addr);
            const u = pickUrl(pa);
            const br = (bi && (bi.Bitrate || bi.bitrate || bi.bit_rate)) || 0;
            const sz = (pa && (pa.DataSize || pa.data_size)) || 0;
            const w = (pa && (pa.Width || pa.width)) || 0;
            const h = (pa && (pa.Height || pa.height)) || 0;
            const gear = (bi && (bi.GearName || bi.gear_name)) || "";
            const isHevc = bi && (bi.is_h265 === 1 || bi.CodecType === 1 || /hevc|h265|bytevc1|hev1/i.test(String(bi.CodecType || gear)));
            const codec = isHevc ? "hev1" : "avc1";
            const gm = !h && gear ? gear.match(/_(\d{3,4})_/) : null;
            const vh = shortSide(w, h) || (gm ? +gm[1] : 0);
            if (u) variants.push({ label: vh ? `${vh}p` : "MP4", url: u, height: vh, bitrate: br, size: sz || undefined, codec });
            if (u && br > bestBr) {
              bestBr = br;
              bestUrl = u;
              bestH = vh;
              bestCodec = codec;
              bestSize = sz;
            }
          }
        }
        if (!bestCodec && tv && (tv.codec_type === 1 || tv.is_bytevc1 === 1)) bestCodec = "hev1";
        if (!bestSize && tv) {
          const paMain = tv.playAddr || tv.play_addr;
          bestSize = (paMain && (paMain.DataSize || paMain.data_size)) || 0;
        }
        const play = tv ? bestUrl || pickUrl(tv.playAddr || tv.play_addr) : "";
        const dl = tv ? pickUrl(tv.downloadAddr || tv.download_addr) : "";
        const images =
          ip && Array.isArray(ip.images)
            ? ip.images.map((im) => pickUrl(im && (im.imageURL || im.displayImage))).filter(Boolean)
            : dyImages
            ? dyImages.map((im) => pickUrl(im)).filter(Boolean)
            : [];
        const musicUrl = n.music ? pickUrl(n.music.playUrl || n.music.play_url) : "";
        const musicTitle = (n.music && typeof n.music.title === "string" && n.music.title) || "";
        const rawW = (tv && (tv.width || (tv.play_addr && tv.play_addr.width))) || 0;
        const rawHRaw = (tv && (tv.height || (tv.play_addr && tv.play_addr.height))) || bestH || 0;
        const rawH = shortSide(rawW, rawHRaw);
        const sample = play || dl || images[0] || musicUrl;
        if (sample) {
          const rawId = n.id || n.aweme_id;
          const isDouyin =
            /douyin(vod)?\.|zjcdn\.|amemv\.|byteimg\./i.test(sample) ||
            (typeof location !== "undefined" && /douyin\.com/i.test(location.hostname));
          const ttSubs = extractSubtitles(n, tv);
          merge(out, {
            id: isNumId(rawId) ? String(rawId) : simpleHash(sample),
            platform: isDouyin ? "douyin" : "tiktok",
            hd: play || dl,
            hdHeight: rawH,
            hdSize: bestSize > 0 ? bestSize : undefined,
            bitrate: bestBr > 0 ? bestBr : undefined,
            sd: dl && dl !== play ? dl : "",
            codec: bestCodec || undefined,
            variants: variants.length > 1 ? variants : undefined,
            images: images.length ? images : undefined,
            musicUrl: musicUrl || undefined,
            musicTitle: musicTitle || undefined,
            subtitles: ttSubs.length ? ttSubs : undefined,
            title: pick(n.desc, typeof n.title === "string" ? n.title : "", musicTitle),
            thumb: images[0] || (tv && pickUrl(tv.cover || tv.originCover || tv.dynamicCover)) || "",
            owner: (n.author && (n.author.nickname || n.author.uniqueId || n.author.unique_id)) || "",
            duration: tv && tv.duration ? (tv.duration > 1000 ? tv.duration : tv.duration * 1000) : 0,
          });
        }
      }

      // 5a) Instagram Stories & Highlights (reel_type / expiring_at + items)
      const isIgStoryReel =
        Array.isArray(n.items) &&
        n.items.length > 0 &&
        (n.reel_type || n.expiring_at || String(n.id || "").startsWith("highlight:")) &&
        n.items.some((it) => it && (it.image_versions2 || it.video_versions));
      if (isIgStoryReel) {
        const images = [];
        const storyVideos = [];
        let firstCodec = "";
        n.items.forEach((slide, idx) => {
          if (!slide || typeof slide !== "object") return;
          if (!slide.image_versions2 && !slide.video_versions) return;
          handledSlides.add(slide);
          const sCand = slide.image_versions2 && Array.isArray(slide.image_versions2.candidates) && slide.image_versions2.candidates[0];
          if (sCand && sCand.url) images.push(sCand.url);
          if (Array.isArray(slide.video_versions) && slide.video_versions.length) {
            let best = null;
            for (const vv of slide.video_versions) {
              if (!vv || !vv.url) continue;
              if (!best || (vv.width || 0) * (vv.height || 0) > (best.width || 0) * (best.height || 0)) best = vv;
            }
            if (best) {
              const vc = slide.video_codec || "";
              if (!firstCodec && vc) firstCodec = vc;
              storyVideos.push({
                index: idx + 1,
                url: best.url,
                height: shortSide(best.width || 0, best.height || 0),
                thumb: (sCand && sCand.url) || "",
                codec: vc || undefined,
              });
            }
          }
        });
        if (images.length || storyVideos.length) {
          const cleanReelId = String(n.id || n.pk || "").replace(/^highlight:/, "hl_").replace(/\W+/g, "");
          const id = cleanReelId ? `story_${cleanReelId}` : simpleHash(images[0] || storyVideos[0].url);
          const owner = (n.user && (n.user.username || n.user.full_name)) || "";
          const sTitle = n.title ? `[Highlight] ${n.title}` : `[Story] ${owner || cleanReelId}`;
          const singleVidOnly = storyVideos.length === 1 && images.length <= 1;
          merge(out, {
            id,
            platform: "instagram",
            isStory: true,
            hd: singleVidOnly ? storyVideos[0].url : "",
            hdHeight: singleVidOnly ? storyVideos[0].height : 0,
            codec: firstCodec || undefined,
            images: images.length ? images : undefined,
            carouselVideos: storyVideos.length ? storyVideos : undefined,
            title: sTitle,
            thumb: images[0] || (storyVideos[0] && storyVideos[0].thumb) || "",
            owner,
            duration: storyVideos.length === 1 && n.items[0] && n.items[0].video_duration ? n.items[0].video_duration * 1000 : 0,
          });
        }
      }

      // 5) Instagram & Threads Carousel nhiều ảnh/video (carousel_media)
      if (Array.isArray(n.carousel_media) && n.carousel_media.length > 0) {
        const images = [];
        const carouselVideos = [];
        let firstCodec = "";
        n.carousel_media.forEach((slide, idx) => {
          if (!slide || typeof slide !== "object") return;
          handledSlides.add(slide);
          const sCand = slide.image_versions2 && Array.isArray(slide.image_versions2.candidates) && slide.image_versions2.candidates[0];
          if (sCand && sCand.url) images.push(sCand.url);
          if (Array.isArray(slide.video_versions) && slide.video_versions.length) {
            let best = null;
            for (const vv of slide.video_versions) {
              if (!vv || !vv.url) continue;
              if (!best || (vv.width || 0) * (vv.height || 0) > (best.width || 0) * (best.height || 0)) best = vv;
            }
            if (best) {
              const vc = slide.video_codec || "";
              if (!firstCodec && vc) firstCodec = vc;
              carouselVideos.push({
                index: idx + 1,
                url: best.url,
                height: shortSide(best.width || 0, best.height || 0),
                thumb: (sCand && sCand.url) || "",
                codec: vc || undefined,
              });
            }
          }
        });
        if (images.length || carouselVideos.length) {
          const rawPk = String(n.pk || n.id || "").split("_")[0];
          const id = isNumId(rawPk) ? rawPk : n.code || simpleHash(images[0] || carouselVideos[0].url);
          const isTh =
            !!n.text_post_app_info ||
            (typeof location !== "undefined" && /threads\.(net|com)/i.test(location.hostname));
          const musicInfo = n.clips_metadata && n.clips_metadata.music_info && n.clips_metadata.music_info.music_asset_info;
          const onlySingleClip = carouselVideos.length === 1 && images.length <= 1;
          merge(out, {
            id,
            code: n.code || undefined,
            platform: isTh ? "threads" : "instagram",
            hd: onlySingleClip ? carouselVideos[0].url : "",
            hdHeight: onlySingleClip ? carouselVideos[0].height : 0,
            codec: firstCodec || undefined,
            images: images.length ? images : undefined,
            carouselVideos: carouselVideos.length ? carouselVideos : undefined,
            musicUrl: (musicInfo && musicInfo.progressive_download_url) || undefined,
            musicTitle: (musicInfo && musicInfo.title) || undefined,
            title: getTitle(n),
            thumb: images[0] || (carouselVideos[0] && carouselVideos[0].thumb) || getThumb(n) || "",
            owner: (n.user && (n.user.username || n.user.full_name)) || "",
            duration: n.video_duration ? n.video_duration * 1000 : 0,
          });
        }
      }

      // 6) Instagram & Threads item đơn (video_versions)
      if (Array.isArray(n.video_versions) && n.video_versions.length > 0) {
        let best = null;
        const variants = [];
        for (const vv of n.video_versions) {
          if (!vv || !vv.url) continue;
          const area = (vv.width || 0) * (vv.height || 0);
          const q = shortSide(vv.width || 0, vv.height || 0);
          const lbl = q ? `${q}p` : "MP4";
          variants.push({ label: lbl, url: vv.url, height: q });
          if (!best || area > (best.width || 0) * (best.height || 0)) best = vv;
        }
        if (best) {
          const rawPk = String(n.pk || n.id || "").split("_")[0];
          const id = isNumId(rawPk) ? rawPk : n.code || simpleHash(best.url);
          const cand = n.image_versions2 && Array.isArray(n.image_versions2.candidates) && n.image_versions2.candidates[0];
          const isTh =
            !!n.text_post_app_info ||
            (typeof location !== "undefined" && /threads\.(net|com)/i.test(location.hostname));
          merge(out, {
            id,
            code: n.code || undefined,
            platform: isTh ? "threads" : "instagram",
            hd: best.url,
            hdHeight: shortSide(best.width || 0, best.height || 0),
            codec: n.video_codec || undefined,
            variants: variants.length > 1 ? variants : undefined,
            title: getTitle(n),
            thumb: (cand && cand.url) || "",
            owner: (n.user && (n.user.username || n.user.full_name)) || "",
            duration: n.video_duration ? n.video_duration * 1000 : 0,
          });
        }
      }

      // 7) X (Twitter) GraphQL media (video_info.variants)
      if (n.video_info && Array.isArray(n.video_info.variants)) {
        const mp4s = n.video_info.variants
          .filter((vr) => vr && /mp4/i.test(vr.content_type || "") && vr.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4s.length) {
          const orig = n.original_info || {};
          const parseRes = (u) => {
            const m = String(u || "").match(/\/(\d{2,4})x(\d{2,4})\//);
            return m ? shortSide(+m[1], +m[2]) : shortSide(orig.width || 0, orig.height || 0);
          };
          const variants = mp4s.map((vr) => {
            const h = parseRes(vr.url);
            return { label: h ? `${h}p` : "MP4", url: vr.url, height: h, bitrate: vr.bitrate || 0 };
          });
          const best = mp4s[0];
          const low = mp4s.length > 1 ? mp4s[mp4s.length - 1] : null;
          const codecMatch = best.url.match(/\/vid\/(avc1|hev1|hvc1|av01|vp09)\//i);
          const id = (parentCtx && parentCtx.platform === "x" && parentCtx.id) || (ctx && ctx.id) || n.id_str || simpleHash(best.url);
          const cObj = (ctx && ctx.id === id ? ctx : parentCtx && parentCtx.id === id ? parentCtx : {}) || {};
          merge(out, {
            id: String(id),
            platform: "x",
            hd: best.url,
            hdHeight: variants[0].height || 0,
            bitrate: best.bitrate || undefined,
            sd: low && low.url !== best.url ? low.url : "",
            sdHeight: variants.length > 1 ? variants[variants.length - 1].height || 0 : 0,
            codec: codecMatch ? codecMatch[1] : undefined,
            variants: variants.length > 1 ? variants : undefined,
            title: cObj.title || getTitle(n),
            thumb: n.media_url_https || getThumb(n) || "",
            owner: cObj.owner || "",
            duration: n.video_info.duration_millis || 0,
          });
        }
      }

      // 8) Xiaohongshu (XHS) note video stream & imageList
      const xhsStream = n.video && n.video.media && n.video.media.stream;
      const xhsImages = Array.isArray(n.imageList) && n.imageList.length && (n.noteId || n.id) && n.user ? n.imageList : null;
      if (xhsStream || xhsImages) {
        const candidates = [];
        if (xhsStream && typeof xhsStream === "object") {
          for (const [key, codecCode] of [["h264", "avc1"], ["h265", "hev1"], ["av1", "av01"]]) {
            for (const st of Array.isArray(xhsStream[key]) ? xhsStream[key] : []) {
              const u = (st && (st.masterUrl || (Array.isArray(st.backupUrls) && st.backupUrls[0]))) || "";
              if (!u) continue;
              const q = shortSide(st.width || 0, st.height || 0);
              const br = st.videoBitrate || st.avgBitrate || 0;
              candidates.push({ url: u, height: q, bitrate: br, size: st.size || 0, codec: codecCode, isH264: key === "h264" });
            }
          }
        }
        candidates.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
        const images = (xhsImages || [])
          .map((im) => pick(im && im.urlDefault, im && im.urlPre, im && Array.isArray(im.infoList) && im.infoList[0] && im.infoList[0].url))
          .filter((u) => /^https?:\/\//i.test(u));
        if (candidates.length || images.length) {
          const best = candidates[0] || null;
          const xId = String(n.noteId || n.id || simpleHash((best && best.url) || images[0]));
          const firstCover = n.cover && pick(n.cover.urlDefault, n.cover.urlPre, n.cover.url);
          const owner = (n.user && (n.user.nickname || n.user.nickName)) || "";
          merge(out, {
            id: xId,
            platform: "xiaohongshu",
            hd: best ? best.url : "",
            hdHeight: best ? best.height : 0,
            hdSize: best && best.size ? best.size : undefined,
            bitrate: best && best.bitrate ? best.bitrate : undefined,
            sd: candidates.length > 1 ? candidates[candidates.length - 1].url : "",
            codec: best ? best.codec : undefined,
            variants: candidates.length > 1 ? candidates.map((c) => ({ label: `${c.height || "MP4"}p (${c.codec === "hev1" ? "HEVC" : c.codec === "av01" ? "AV1" : "H264"})`, url: c.url, height: c.height })) : undefined,
            images: images.length ? images : undefined,
            title: pick(n.title, n.desc),
            thumb: firstCover || images[0] || "",
            owner,
            duration: n.video && n.video.capa && n.video.capa.duration ? n.video.capa.duration * 1000 : 0,
          });
        }
      }

      for (const k in n) {
        const c = n[k];
        if (c && typeof c === "object") stack.push([c, ctx]);
        // 4) DASH manifest dạng chuỗi XML
        else if (typeof c === "string" && c.length > 200 && c.indexOf("<MPD") !== -1) {
          const { bestV, bestA, subtitles } = parseMpd(c);
          if (bestV || bestA || (subtitles && subtitles.length)) {
            const firstUrl = (bestV && bestV.url) || (bestA && bestA.url) || (subtitles[0] && subtitles[0].url);
            merge(
              out,
              Object.assign(base(idFor(firstUrl)), {
                dashVideo: bestV,
                dashAudio: bestA,
                subtitles: subtitles && subtitles.length ? subtitles : undefined,
              })
            );
          }
        }
      }
    }
  }

  // Dự phòng: regex khi không parse được JSON
  function regexScan(text, out) {
    const unq = (s) => {
      try {
        return JSON.parse('"' + s + '"');
      } catch (e) {
        return "";
      }
    };
    const grab = (key) => {
      const m = text.match(new RegExp('"' + key + '":"((?:\\\\.|[^"\\\\])*)"'));
      return m ? unq(m[1]) : "";
    };
    const hd = grab("browser_native_hd_url") || grab("playable_url_quality_hd") || grab("hd_src");
    const sd = grab("browser_native_sd_url") || grab("playable_url") || grab("sd_src") || grab("progressive_url");
    if (hd || sd) {
      const idm = text.match(/"(?:videoId|video_id)":"?(\d+)/);
      merge(out, { id: idm ? idm[1] : simpleHash(hd || sd), hd, sd, title: "", thumb: "" });
    }
  }

  function parseText(text, out) {
    out = out || {};
    if (!text || typeof text !== "string" || !KEYWORDS.test(text)) return out;
    const body = text.replace(/^for\s*\(;;\);/, "").trim();
    try {
      walk(JSON.parse(body), out);
    } catch (e) {
      for (const line of body.split("\n")) {
        const l = line.trim();
        if (!l || !KEYWORDS.test(l)) continue;
        try {
          walk(JSON.parse(l), out);
        } catch (e2) {
          regexScan(l, out);
        }
      }
    }
    return out;
  }

  function parseObj(obj, out) {
    out = out || {};
    if (obj && typeof obj === "object") walk(obj, out);
    return out;
  }

  function parseHtml(html, out) {
    out = out || {};
    const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) parseText(m[1], out);
    const xhsM = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})(?:;|\s*<\/script>)/);
    if (xhsM) {
      try {
        const sanitized = xhsM[1].replace(/:\s*undefined\b/g, ":null");
        walk(JSON.parse(sanitized), out);
      } catch (e) {}
    }
    if (Object.keys(out).length === 0) regexScan(html, out);
    return out;
  }

  window.__FBVD_PARSER__ = { parseText, parseObj, parseHtml, merge };
})();
