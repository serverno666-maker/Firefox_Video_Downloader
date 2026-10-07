"use strict";

// Shared by the Firefox background menu. No player code is evaluated: only
// media URLs exposed by DOM, inline text, Resource Timing and webRequest are used.
const VideoDiscovery = (() => {
  const MAX_SOURCE_AGE_MS = 10 * 60 * 1000;
  const VIDEO_EXTENSION = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv|avi|wmv|flv)$/i;

  async function injectIntoExistingTab(tabId) {
    // Content scripts are not injected into tabs that predate installation.
    try {
      if (browser.scripting?.executeScript) {
        await browser.scripting.executeScript({
          target: { tabId, allFrames: true }, files: ["content.js"]
        });
      } else {
        await browser.tabs.executeScript(tabId, { file: "content.js", allFrames: true });
      }
    } catch {
      // A restricted frame does not prevent scans in accessible frames.
    }
  }

  async function scanFrames(tabId, clickedFrameId = 0) {
    await injectIntoExistingTab(tabId);
    const frameIds = new Set([0, clickedFrameId]);
    try {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      for (const frame of frames || []) {
        if (Number.isInteger(frame.frameId)) frameIds.add(frame.frameId);
        if (frameIds.size >= 64) break;
      }
    } catch { /* The known frames remain usable. */ }
    const result = await Promise.all([...frameIds].map(async (frameId) => {
      try {
        const scan = await browser.tabs.sendMessage(tabId, { type: "scan-video-sources" }, { frameId });
        return scan ? { frameId, ...scan } : null;
      } catch { return null; }
    }));
    return result.filter(Boolean);
  }

  function safeName(raw, fallback = "Video") {
    return String(raw || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 100) || fallback;
  }

  function extensionFor(item) {
    if (item.kind === "dash" || item.kind === "hls") return "mp4";
    const mime = (item.mime || "").toLowerCase();
    if (mime.includes("webm")) return "webm";
    if (mime.includes("ogg")) return "ogv";
    if (mime.includes("quicktime")) return "mov";
    try {
      return new URL(item.url).pathname.match(VIDEO_EXTENSION)?.[1].toLowerCase() || "mp4";
    } catch { return "mp4"; }
  }

  function filenameFor(item, title) {
    if (item.filenameHint) {
      const hint = safeName(item.filenameHint);
      if (VIDEO_EXTENSION.test(hint)) return hint;
    }
    if (item.kind === "file") {
      try {
        const basename = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || "");
        if (basename.length <= 100 && VIDEO_EXTENSION.test(basename)) return safeName(basename);
      } catch { /* Use the page title below. */ }
    }
    return `${safeName(title)}.${extensionFor(item)}`;
  }

  async function masterReferences(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch(url, { credentials: "include", signal: controller.signal });
      if (!response.ok) return new Set();
      const text = (await response.text()).slice(0, 128 * 1024);
      if (!text.trimStart().startsWith("#EXTM3U")) return new Set();
      const lines = text.split(/\r?\n/).map((line) => line.trim());
      const references = new Set();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
          const next = lines.slice(i + 1).find((line) => line && !line.startsWith("#"));
          if (next) references.add(new URL(next, response.url || url).href);
        }
        if (lines[i].startsWith("#EXT-X-MEDIA:") || lines[i].startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
          const uri = /(?:^|,)URI="([^"]+)"/.exec(lines[i])?.[1];
          if (uri) references.add(new URL(uri, response.url || url).href);
        }
      }
      return references;
    } catch { return new Set(); }
    finally { clearTimeout(timer); }
  }

  async function collapseHlsVariants(items) {
    const hls = items.filter((item) => item.kind === "hls");
    if (hls.length < 2 || hls.length > 32) return items;
    const references = await Promise.all(hls.map((item) => masterReferences(item.url)));
    const variants = new Set();
    for (let i = 0; i < hls.length; i++) {
      for (const referenced of references[i]) {
        // A player iframe and its page can report the same rendition through
        // different frame IDs. The absolute media URL identifies the child.
        const child = hls.find((item) => item.url === referenced);
        if (child) variants.add(child.url);
      }
    }
    return items.filter((item) => !variants.has(item.url));
  }

  function sourceScore(item, frame, clickedFrameId) {
    const videos = frame?.videos || [];
    const matched = videos.find((video) => video.src === item.url);
    const playing = videos.some((video) => video.playing);
    let score = matched ? (matched.playing ? 120 : matched.visible ? 100 : 85) : 0;
    if (item.network) score += 60;
    else if (item.origin === "video" || item.origin === "source") score += 50;
    else if (item.origin === "resource") score += 35;
    else if (item.origin === "script") score += 25;
    else score += 20;
    if (playing && videos.length === 1) score += 25;
    if (item.frameId === clickedFrameId) score += 10;
    return score;
  }

  async function discoverVideoCandidates(tab, info = {}, networkSources = []) {
    if (!Number.isInteger(tab?.id)) return { candidates: [], drmDetected: false };
    const clickedFrameId = Number.isInteger(info.frameId) ? info.frameId : 0;
    const scans = await scanFrames(tab.id, clickedFrameId);
    const frameMap = new Map(scans.map((scan) => [scan.frameId, scan]));
    const byUrl = new Map();
    function add(item) {
      if (!/^https?:\/\//i.test(item.url || "")) return;
      const old = byUrl.get(item.url);
      if (!old || sourceScore(item, frameMap.get(item.frameId), clickedFrameId) >
        sourceScore(old, frameMap.get(old.frameId), clickedFrameId)) byUrl.set(item.url, item);
    }

    for (const scan of scans) {
      for (const item of scan.sources || []) add({ ...item, frameId: scan.frameId });
      for (const video of scan.videos || []) {
        if (/^https?:\/\//i.test(video.src || "")) {
          const kind = /\.m3u8?(?:[?#]|$)/i.test(video.src) ? "hls" :
            /\.mpd(?:[?#]|$)/i.test(video.src) ? "dash" : "file";
          add({ url: video.src, kind, origin: "video", frameId: scan.frameId });
        }
      }
    }

    const now = Date.now();
    for (const item of networkSources) {
      if (Number.isFinite(item.seenAt) && now - item.seenAt >= 0 &&
        now - item.seenAt <= MAX_SOURCE_AGE_MS) add({ ...item, network: true });
    }
    if (info.mediaType === "video" && /^https?:\/\//i.test(info.srcUrl || "")) {
      const kind = /\.m3u8?(?:[?#]|$)/i.test(info.srcUrl) ? "hls" :
        /\.mpd(?:[?#]|$)/i.test(info.srcUrl) ? "dash" : "file";
      add({ url: info.srcUrl, kind, origin: "video", frameId: clickedFrameId, network: true });
    }

    const visible = await collapseHlsVariants([...byUrl.values()]);
    const candidates = visible.map((item) => {
      const frame = frameMap.get(item.frameId);
      const video = frame?.videos?.find((entry) => entry.src === item.url) ||
        (frame?.videos?.length === 1 ? frame.videos[0] : null);
      const title = video?.title || frame?.title || tab.title || "Video";
      return {
        url: item.url,
        kind: item.kind,
        frameId: item.frameId,
        filename: filenameFor(item, title),
        extensionKnown: item.kind !== "hls",
        title,
        score: sourceScore(item, frame, clickedFrameId),
        origin: item.network ? "network" : item.origin || "page",
        drm: Boolean(video?.drm)
      };
    }).sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
    return {
      candidates: candidates.slice(0, 10),
      truncatedCount: Math.max(0, candidates.length - 10),
      drmDetected: scans.some((scan) => (scan.videos || []).some((video) => video.drm)),
      scannedFrames: scans.length
    };
  }

  return { discoverVideoCandidates, scanFrames };
})();
