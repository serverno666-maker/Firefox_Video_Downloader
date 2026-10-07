(() => {
"use strict";

if (globalThis.__videoSaverContentInstalled) return;
globalThis.__videoSaverContentInstalled = true;

const encryptedVideos = new WeakSet();
const MEDIA_EXTENSION = /\.(?:m3u8?|mpd|mp4|m4v|webm|mov|ogv|ogg|mkv|avi|wmv|flv)(?:[?#]|$)/i;
const SCRIPT_VALUE = /["'`]([^"'`\r\n]{1,1600})["'`]/g;
let lastContextVideo = null;
let lastContextAt = 0;

function videoFromTarget(target) {
  if (target instanceof HTMLVideoElement) return target;
  if (target instanceof Element) return target.closest("video");
  return null;
}

function openRoots(root = document, found = []) {
  found.push(root);
  if (found.length >= 100) return found;
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) openRoots(element.shadowRoot, found);
    if (found.length >= 100) break;
  }
  return found;
}

function videosInOpenRoots() {
  return openRoots().flatMap((root) => [...root.querySelectorAll("video")]);
}

function isVisible(video) {
  const rect = video.getBoundingClientRect();
  return rect.width >= 50 && rect.height >= 50 &&
    rect.right > 0 && rect.bottom > 0 &&
    rect.left < innerWidth && rect.top < innerHeight;
}

function mediaKind(url, mime = "") {
  if (/mpegurl/i.test(mime)) return "hls";
  if (/dash\+xml/i.test(mime)) return "dash";
  if (/^video\//i.test(mime)) return "file";
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.m3u8?$/.test(path)) return "hls";
    if (/\.mpd$/.test(path)) return "dash";
    if (/\.(mp4|m4v|webm|mov|ogv|ogg|mkv|avi|wmv|flv)$/.test(path)) return "file";
  } catch { /* Ignore malformed URLs. */ }
  return null;
}

function normalizeMediaUrl(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/\\\//g, "/").replace(/&amp;/g, "&");
  if (!value || value.length > 2500) return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function scanSources(roots, videos) {
  const candidates = new Map();
  function add(raw, origin, mime = "", explicit = false) {
    const url = normalizeMediaUrl(raw);
    if (!url || candidates.has(url) || candidates.size >= 120) return;
    const kind = mediaKind(url, mime);
    if (!kind && !explicit) return;
    candidates.set(url, { url, kind: kind || "file", origin });
  }

  for (const video of videos) {
    add(video.currentSrc, "video", video.getAttribute("type") || "", true);
    add(video.getAttribute("src"), "video", video.getAttribute("type") || "", true);
    for (const source of video.querySelectorAll("source[src]")) {
      add(source.getAttribute("src"), "source", source.getAttribute("type") || "", true);
    }
  }

  for (const root of roots) {
    for (const element of root.querySelectorAll("source[src],link[href],meta[content],[data-src],[data-file],[data-video],[data-hls],[data-dash]")) {
      if (element.localName === "source") {
        add(element.getAttribute("src"), "source", element.getAttribute("type") || "", true);
      } else if (element.localName === "link") {
        add(element.getAttribute("href"), "link", element.getAttribute("type") || "", false);
      } else if (element.localName === "meta") {
        const property = element.getAttribute("property") || element.getAttribute("name") || "";
        if (/video|stream|player/i.test(property)) add(element.getAttribute("content"), "meta");
      } else {
        for (const attr of ["data-src", "data-file", "data-video", "data-hls", "data-dash"]) {
          add(element.getAttribute(attr), "attribute");
        }
      }
    }
  }

  let scriptBytes = 0;
  for (const script of document.scripts) {
    const body = script.textContent || "";
    scriptBytes += body.length;
    if (scriptBytes > 1_000_000) break;
    SCRIPT_VALUE.lastIndex = 0;
    for (const match of body.matchAll(SCRIPT_VALUE)) {
      const value = match[1];
      if (MEDIA_EXTENSION.test(value.replace(/\\\//g, "/"))) add(value, "script");
    }
  }

  for (const entry of performance.getEntriesByType("resource").slice(-1000)) {
    if (MEDIA_EXTENSION.test(entry.name)) add(entry.name, "resource");
  }
  return [...candidates.values()];
}

document.addEventListener("encrypted", (event) => {
  if (event.target instanceof HTMLVideoElement) encryptedVideos.add(event.target);
}, true);

document.addEventListener("contextmenu", (event) => {
  lastContextAt = Date.now();
  lastContextVideo = videoFromTarget(event.composedPath()[0]);
  if (lastContextVideo) return;
  lastContextVideo = videosInOpenRoots().find((video) => {
    const rect = video.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
  }) || null;
}, true);

function findClickedVideo(targetElementId) {
  let target = null;
  try { target = browser.menus.getTargetElement(targetElementId); }
  catch { /* The context-menu target may have expired. */ }
  return videoFromTarget(target) || (Date.now() - lastContextAt < 30_000 ? lastContextVideo : null);
}

function videoInfo(video) {
  return {
    src: video.currentSrc || video.src || video.querySelector("source[src]")?.src || "",
    drm: Boolean(video.mediaKeys || encryptedVideos.has(video)),
    playing: !video.paused && !video.ended && video.readyState >= 2,
    visible: isVisible(video),
    title: document.title || video.getAttribute("title") || "Video"
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "identify-video") {
    const video = findClickedVideo(message.targetElementId);
    return Promise.resolve(video ? videoInfo(video) : null);
  }
  if (message?.type === "scan-video-sources") {
    const roots = openRoots();
    const videos = roots.flatMap((root) => [...root.querySelectorAll("video")]);
    return Promise.resolve({
      title: document.title || "Video",
      videos: videos.map(videoInfo),
      sources: scanSources(roots, videos)
    });
  }
});

let discoveryHintTimer;
function sendDiscoveryHint() {
  clearTimeout(discoveryHintTimer);
  discoveryHintTimer = setTimeout(() => {
    browser.runtime.sendMessage({ type: "video-discovery-changed" }).catch(() => {});
  }, 300);
}
document.addEventListener("DOMContentLoaded", sendDiscoveryHint, { once: true });
document.addEventListener("loadedmetadata", sendDiscoveryHint, true);
document.addEventListener("playing", sendDiscoveryHint, true);
if (document.readyState !== "loading") sendDiscoveryHint();
})();
