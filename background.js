"use strict";

// Firefox MV2 keeps this page alive while streams are assembled and while the
// user chooses a save location. The website tab is never used as a worker.
const ROOT_MENU_ID = "video-download";
const SOURCE_LIMIT = 60;
const SOURCE_MAX_AGE_MS = 10 * 60 * 1000;
const sourceWrites = new Map();
const analysisCache = new Map();
let activeAnalyses = 0;
const menuCandidates = new Map();
const preparedCandidates = new Map();
const prepareTimers = new Map();
const prepareInFlight = new Map();
const prepareAgain = new Set();
const pendingChoices = new Map();
const tabGeneration = new Map();
const childMenuIds = Array.from({ length: 9 }, (_, index) => `${ROOT_MENU_ID}:${index + 1}`);
let menuEpoch = 0;
let menuMutation = Promise.resolve();

function kindFromUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname.toLowerCase();
    if (/\.m3u8?$/.test(path)) return "hls";
    if (/\.mpd$/.test(path)) return "dash";
    if (/\.(mp4|m4v|webm|mov|ogv|ogg|mkv|avi|wmv|flv)$/.test(path)) return "file";
    return null;
  } catch { return null; }
}

function headerValue(headers, name) {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value || "";
}

function kindFromResponse(details) {
  const type = headerValue(details.responseHeaders, "content-type").toLowerCase();
  // Stream fragments are not complete, independently downloadable videos.
  if (/\.(?:m4a|mp3|aac|opus|wav|flac|m4s|ts|vtt|srt)(?:[?#]|$)/i.test(details.url) ||
      /^(?:video\/(?:mp2t|iso\.segment)|audio\/)/.test(type)) return null;
  if (/mpegurl|vnd\.apple\.mpegurl/.test(type)) return "hls";
  if (/dash\+xml/.test(type)) return "dash";
  if (/^video\//.test(type)) return "file";
  if (/^(?:audio\/|image\/|text\/|application\/(?:json|javascript|xml))/.test(type)) return null;
  // A progressive video can have a signed URL without a filename.
  return details.type === "media" ? "file" : null;
}

function rememberSource(tabId, item) {
  if (tabId < 0 || !item.kind) return;
  if ((item.kind === "hls" || item.kind === "dash") && activeAnalyses < 4) {
    analyzeCached(item.url).catch(() => {});
  }
  const key = `sources:${tabId}`;
  const previous = sourceWrites.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const stored = await browser.storage.session.get(key);
    const list = Array.isArray(stored[key]) ? stored[key] : [];
    const duplicate = list.findIndex((candidate) => candidate.url === item.url);
    if (duplicate !== -1) list.splice(duplicate, 1);
    list.unshift({ ...item, seenAt: Date.now() });
    await browser.storage.session.set({ [key]: list.slice(0, SOURCE_LIMIT) });
  });
  sourceWrites.set(key, next);
  next.finally(() => {
    if (sourceWrites.get(key) === next) sourceWrites.delete(key);
  }).catch(() => {});
  next.then(() => schedulePrepareTab(tabId)).catch(() => {});
}

function clearTabSources(tabId) {
  const key = `sources:${tabId}`;
  const previous = sourceWrites.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => browser.storage.session.remove(key));
  sourceWrites.set(key, next);
  next.finally(() => {
    if (sourceWrites.get(key) === next) sourceWrites.delete(key);
  }).catch(() => {});
  menuCandidates.delete(tabId);
  preparedCandidates.delete(tabId);
  const timer = prepareTimers.get(tabId);
  if (timer) clearTimeout(timer);
  prepareTimers.delete(tabId);
}

async function getSources(tabId) {
  const key = `sources:${tabId}`;
  const pending = sourceWrites.get(key);
  if (pending) await pending.catch(() => {});
  const stored = await browser.storage.session.get(key);
  return Array.isArray(stored[key]) ? stored[key] : [];
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const kind = kindFromUrl(details.url);
    if (kind && (kind !== "file" || details.type === "media")) {
      rememberSource(details.tabId, { url: details.url, kind, frameId: details.frameId });
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const kind = kindFromResponse(details);
    if (kind && (kind !== "file" || details.type === "media")) {
      const disposition = headerValue(details.responseHeaders, "content-disposition");
      const rawHint = /filename\*?=(?:UTF-8''|\")?([^";]+)/i.exec(disposition)?.[1];
      let filenameHint;
      try { filenameHint = rawHint ? decodeURIComponent(rawHint).trim() : undefined; }
      catch { filenameHint = rawHint?.trim(); }
      rememberSource(details.tabId, {
        url: details.url, kind, frameId: details.frameId,
        filenameHint,
        mime: headerValue(details.responseHeaders, "content-type")
      });
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

browser.tabs.onRemoved.addListener((tabId) => {
  clearTabSources(tabId);
  tabGeneration.delete(tabId);
});
browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    tabGeneration.set(details.tabId, (tabGeneration.get(details.tabId) || 0) + 1);
    clearTabSources(details.tabId);
  }
});
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete") schedulePrepareTab(tabId);
});
browser.tabs.onActivated.addListener(({ tabId }) => schedulePrepareTab(tabId));

function safeFilename(raw) {
  return String(raw || "Video.mp4")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120) || "Video.mp4";
}

function withExtension(filename, extension) {
  const base = safeFilename(filename).replace(/\.[^.]+$/, "");
  return safeFilename(`${base}.${extension}`);
}

function labelFor(candidate) {
  return `Download ${safeFilename(candidate.filename)}`.slice(0, 150);
}

function errorText(error) {
  const raw = String(error?.message || error || "Unbekannter Fehler");
  return raw.replace(/https?:\/\/\S+/g, "[Medienadresse]").slice(0, 260);
}

async function notifyError(message) {
  console.error("Video herunterladen:", message);
  try {
    await browser.notifications.create({
      type: "basic", title: "Video konnte nicht gespeichert werden", message: errorText(message)
    });
  } catch (error) { console.error("Notification failed:", error); }
}

function analyzeCached(url) {
  const current = analysisCache.get(url);
  if (current && Date.now() - current.seenAt < 5 * 60 * 1000) return current.promise;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  activeAnalyses++;
  const promise = StreamTools.analyze(url, fetch, { signal: controller.signal })
    .catch((error) => {
      if (analysisCache.get(url)?.promise === promise) analysisCache.delete(url);
      throw error;
    })
    .finally(() => { clearTimeout(timer); activeAnalyses--; });
  analysisCache.set(url, { promise, seenAt: Date.now() });
  if (analysisCache.size > 100) analysisCache.delete(analysisCache.keys().next().value);
  return promise;
}

async function enrichCandidate(candidate) {
  if (candidate.kind === "file") return candidate;
  let timer;
  try {
    const plan = await Promise.race([
      analyzeCached(candidate.url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Analyse läuft noch")), 5000); })
    ]);
    const extension = plan.outputExtension || "mp4";
    return { ...candidate, filename: withExtension(candidate.filename, extension), plan };
  } catch (error) {
    return { ...candidate, analysisError: errorText(error) };
  } finally { clearTimeout(timer); }
}

async function collectCandidates(tab, info = {}) {
  const found = await VideoDiscovery.discoverVideoCandidates(tab, info, await getSources(tab.id));
  const enriched = await Promise.all(found.candidates.map(enrichCandidate));
  const renditionUrls = new Set(enriched.flatMap((candidate) =>
    candidate.kind === "hls" ? (candidate.plan?.variants || []).map((variant) => variant.url) : []));
  return {
    candidates: enriched.filter((candidate) => !renditionUrls.has(candidate.url)),
    drmDetected: found.drmDetected,
    analyzing: enriched.some((candidate) => candidate.analysisError === "Analyse läuft noch")
  };
}

function schedulePrepareTab(tabId, delay = 350) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const old = prepareTimers.get(tabId);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    prepareTimers.delete(tabId);
    prepareTab(tabId).catch((error) => console.warn("Video pre-scan failed:", error));
  }, delay);
  prepareTimers.set(tabId, timer);
}

async function prepareTab(tabId) {
  if (prepareInFlight.has(tabId)) {
    prepareAgain.add(tabId);
    return prepareInFlight.get(tabId);
  }
  const task = (async () => {
    const tab = await browser.tabs.get(tabId);
    if (!/^https?:\/\//i.test(tab.url || "")) return;
    const generation = tabGeneration.get(tabId) || 0;
    const result = await collectCandidates(tab);
    if (generation !== (tabGeneration.get(tabId) || 0)) return;
    preparedCandidates.set(tabId, { ...result, generation, seenAt: Date.now() });
    if (result.analyzing) {
      const pending = result.candidates.map((candidate) => analysisCache.get(candidate.url)?.promise).filter(Boolean);
      Promise.allSettled(pending).then(() => schedulePrepareTab(tabId, 100));
    }
  })();
  prepareInFlight.set(tabId, task);
  try { return await task; }
  finally {
    prepareInFlight.delete(tabId);
    if (prepareAgain.delete(tabId)) schedulePrepareTab(tabId, 100);
  }
}

// Persistent Firefox background pages recreate their menu items at script load.
browser.menus.create({
  id: ROOT_MENU_ID, title: "Videoquellen werden gesucht…", contexts: ["all"], enabled: true
});
for (const id of childMenuIds) {
  browser.menus.create({ id, title: "Download Video.mp4", contexts: ["all"], visible: false });
}

async function removeChildren() {
  await Promise.all(childMenuIds.map((id) => browser.menus.update(id, { visible: false }).catch(() => {})));
}

function mutateMenu(callback) {
  const next = menuMutation.catch(() => {}).then(callback);
  menuMutation = next.catch(() => {});
  return next;
}

async function showCandidates(info, tab, epoch) {
  const generation = tabGeneration.get(tab.id) || 0;
  const cached = preparedCandidates.get(tab.id);
  const freshCache = cached?.candidates.length && cached.generation === generation &&
    Date.now() - cached.seenAt < 2 * 60 * 1000;
  if (!freshCache) {
    await mutateMenu(async () => {
      if (epoch !== menuEpoch) return;
      await browser.menus.update(ROOT_MENU_ID, { title: "Videoquellen werden gesucht…", enabled: true });
      if (epoch !== menuEpoch) return;
      await removeChildren();
      if (epoch === menuEpoch) await browser.menus.refresh();
    });
  }
  if (epoch !== menuEpoch) return;
  const result = freshCache ? cached : await collectCandidates(tab, info);
  const candidates = result.candidates;
  if (epoch !== menuEpoch || generation !== (tabGeneration.get(tab.id) || 0)) return;
  preparedCandidates.set(tab.id, { ...result, generation, seenAt: Date.now() });
  menuCandidates.set(tab.id, candidates);
  await mutateMenu(async () => {
    if (epoch !== menuEpoch) return;
    if (freshCache) await removeChildren();
    if (epoch !== menuEpoch) return;
    if (!candidates.length) {
      await browser.menus.update(ROOT_MENU_ID, {
        title: result.drmDetected ? "DRM-Video: kein Download möglich" : "Kein Video gefunden",
        enabled: true
      });
    } else if (candidates.length === 1) {
      await browser.menus.update(ROOT_MENU_ID, { title: labelFor(candidates[0]), enabled: true });
    } else {
      await browser.menus.update(ROOT_MENU_ID, { title: labelFor(candidates[0]), enabled: true });
      if (epoch !== menuEpoch) return;
      for (let index = 1; index < candidates.length; index++) {
        await browser.menus.update(childMenuIds[index - 1], {
          title: labelFor(candidates[index]), visible: true, enabled: true
        });
      }
    }
    if (epoch === menuEpoch) await browser.menus.refresh();
  });
}

browser.menus.onShown.addListener((info, tab) => {
  if (!Number.isInteger(tab?.id)) return;
  const epoch = ++menuEpoch;
  const cached = preparedCandidates.get(tab.id);
  if (cached?.candidates.length && cached.generation === (tabGeneration.get(tab.id) || 0) &&
      Date.now() - cached.seenAt < 2 * 60 * 1000) {
    // Keep a prepared source clickable even before Firefox finishes refreshing
    // its context-menu label.
    menuCandidates.set(tab.id, cached.candidates);
  } else menuCandidates.delete(tab.id);
  showCandidates(info, tab, epoch).catch((error) => {
    if (epoch === menuEpoch) notifyError(`Videoquellen konnten nicht gelesen werden: ${errorText(error)}`);
  });
});

browser.menus.onHidden.addListener(() => {
  const epoch = ++menuEpoch;
  mutateMenu(async () => {
    await browser.menus.update(ROOT_MENU_ID, { title: "Videoquellen werden gesucht…", enabled: true });
    if (epoch === menuEpoch) await removeChildren();
  }).catch(console.error);
});

function choiceItems(plan, kind) {
  const choices = kind === "video" ? plan?.videoChoices : plan?.audioChoices;
  if (choices) return choices.filter((item) => !item.automatic);
  return plan?.choices?.[kind] || [];
}

function choiceValue(item) {
  return item?.value || item?.url || item?.id || null;
}

function choiceLabel(item, kind) {
  if (item.label) return item.label;
  if (kind === "video") {
    const resolution = item.resolution || (item.width && item.height ? `${item.width}×${item.height}` : "");
    const rate = item.bandwidth ? ` · ${Math.round(item.bandwidth / 1000)} kbit/s` : "";
    return `${resolution || "Video"}${rate}`;
  }
  return [item.language, item.name, item.channels].filter(Boolean).join(" · ") || "Tonspur";
}

function choiceSummary(plan) {
  return {
    format: plan?.format || "",
    video: choiceItems(plan, "video").map((item, index) => ({ index, label: choiceLabel(item, "video"), audioGroup: item.audioGroup || "" })),
    audio: choiceItems(plan, "audio").map((item, index) => ({
      index, label: choiceLabel(item, "audio"), groupId: item.groupId || "",
      supported: item.supported !== false
    }))
  };
}

function startStream(candidate, incognito, videoChoice, audioChoice) {
  const name = safeFilename(candidate.filename).replace(/\.[^.]+$/, "");
  const job = StreamJob.start(candidate.url, {
    name, incognito, videoChoice, audioChoice,
    onState: (state) => {
      if (state.state === "running") {
        browser.notifications.create({
          type: "basic", title: "Video wird geladen",
          message: "Firefox fragt jetzt nach dem Speicherort und zeigt anschließend den Download-Fortschritt. Die Webseite kann geschlossen werden."
        }).catch(console.error);
      }
      if (state.state === "failed") notifyError(state.error);
    }
  });
  job.catch(() => {});
}

async function startCandidate(candidate, tab) {
  if (candidate.drm) {
    await notifyError("Dieses Video ist DRM-geschützt. Nutzen Sie die offizielle Offline-Funktion der Website.");
    return;
  }
  if (candidate.kind === "file") {
    try {
      const options = {
        url: candidate.url, filename: safeFilename(candidate.filename),
        saveAs: true, conflictAction: "uniquify"
      };
      if (tab.incognito) options.incognito = true;
      await browser.downloads.download(options);
    } catch (error) {
      if (!/cancell?ed|abgebrochen/i.test(errorText(error))) await notifyError(error);
    }
    return;
  }
  const plan = candidate.plan || await analyzeCached(candidate.url);
  const summary = choiceSummary(plan);
  const selectedGroup = summary.video[0]?.audioGroup || plan.variant?.audioGroup || "";
  const relevantAudio = plan.format === "hls" ? summary.audio.filter((item) => item.groupId === selectedGroup) : summary.audio;
  if (summary.video.length > 1 || relevantAudio.length > 1) {
    const token = crypto.randomUUID();
    pendingChoices.set(token, { candidate, plan, incognito: Boolean(tab.incognito), createdAt: Date.now() });
    try {
      await browser.windows.create({
        type: "popup", url: browser.runtime.getURL(`choice.html#${encodeURIComponent(token)}`),
        width: 520, height: 390
      });
    } catch (error) {
      pendingChoices.delete(token);
      await notifyError(error);
    }
    return;
  }
  if (!plan.downloadable) {
    await notifyError("Diese getrennten Video- und Tonspuren können derzeit nicht als eine Datei gespeichert werden.");
    return;
  }
  startStream(candidate, Boolean(tab.incognito));
}

async function startSelectedCandidate(candidate, tab) {
  if (candidate.kind !== "hls") return startCandidate(candidate, tab);
  // A slow master manifest may finish after the menu is shown. Resolve sibling
  // playlists before starting so a clicked rendition still offers quality.
  const siblings = (menuCandidates.get(tab.id) || []).filter((item) => item.kind === "hls");
  const analyzed = await Promise.all(siblings.map(async (item) => {
    try { return { item, plan: item.plan || await analyzeCached(item.url) }; }
    catch { return null; }
  }));
  const master = analyzed.find((entry) => entry?.plan?.variants?.some((variant) => variant.url === candidate.url));
  if (master) candidate = { ...master.item, plan: master.plan };
  else {
    const current = analyzed.find((entry) => entry?.item.url === candidate.url);
    if (current) candidate = { ...candidate, plan: current.plan };
  }
  return startCandidate(candidate, tab);
}

browser.menus.onClicked.addListener((info, tab) => {
  if (!Number.isInteger(tab?.id)) return;
  const id = String(info.menuItemId);
  if (id !== ROOT_MENU_ID && !id.startsWith(`${ROOT_MENU_ID}:`)) return;
  const index = id === ROOT_MENU_ID ? 0 : Number(id.slice(ROOT_MENU_ID.length + 1));
  const candidate = menuCandidates.get(tab.id)?.[index];
  if (!candidate) { notifyError("Diese Videoquelle ist nicht mehr verfügbar. Öffnen Sie das Rechtsklick-Menü erneut."); return; }
  if (candidate.kind === "hls" && (menuCandidates.get(tab.id) || []).some((item) => item.kind === "hls" && !item.plan)) {
    browser.notifications.create({
      type: "basic", title: "Videoquelle wird geprüft",
      message: "Die Streamvarianten werden geladen. Die Auswahl erscheint anschließend."
    }).catch(console.error);
  }
  startSelectedCandidate(candidate, tab).catch(notifyError);
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "video-discovery-changed" && Number.isInteger(sender?.tab?.id)) {
    schedulePrepareTab(sender.tab.id);
    return;
  }
  if (message?.type === "choice-get") {
    const pending = pendingChoices.get(message.token);
    if (!pending) return Promise.resolve({ error: "Diese Auswahl ist nicht mehr verfügbar." });
    return Promise.resolve({ filename: pending.candidate.filename, ...choiceSummary(pending.plan) });
  }
  if (message?.type === "choice-start") {
    const pending = pendingChoices.get(message.token);
    if (!pending) return Promise.resolve({ error: "Diese Auswahl ist nicht mehr verfügbar." });
    const videoItems = choiceItems(pending.plan, "video");
    const audioItems = choiceItems(pending.plan, "audio");
    const videoIndex = message.videoIndex === "" ? NaN : Number(message.videoIndex);
    const audioIndex = message.audioIndex === "" ? NaN : Number(message.audioIndex);
    if (videoItems.length > 1 && (!Number.isInteger(videoIndex) || videoIndex < 0 || videoIndex >= videoItems.length)) {
      return Promise.resolve({ error: "Bitte Auflösung und Tonspur auswählen." });
    }
    const selectedVideo = videoItems.length > 1 ? videoItems[videoIndex] : videoItems[0];
    const audioGroup = selectedVideo ? (selectedVideo.audioGroup || "") : (pending.plan.variant?.audioGroup || "");
    const compatibleAudio = pending.plan.format === "hls" ?
      (audioGroup ? audioItems.filter((item) => item.groupId === audioGroup) : []) : audioItems;
    const selectedAudio = compatibleAudio.length > 1 ? audioItems[audioIndex] : compatibleAudio[0];
    if (compatibleAudio.length > 1 &&
        (!Number.isInteger(audioIndex) || !compatibleAudio.includes(selectedAudio))) {
      return Promise.resolve({ error: "Bitte eine passende Tonspur auswählen." });
    }
    if (selectedAudio?.supported === false) {
      return Promise.resolve({ error: "Diese Tonspur kann nicht mit dem Video gespeichert werden." });
    }
    const videoChoice = videoItems.length > 1 ? choiceValue(videoItems[videoIndex]) : undefined;
    const audioChoice = compatibleAudio.length > 1 ? choiceValue(selectedAudio) : undefined;
    if (pending.choosing) return Promise.resolve({ error: "Die Auswahl wird bereits geprüft." });
    pending.choosing = true;
    return (async () => {
      try {
        const chosenPlan = await StreamTools.analyze(pending.candidate.url, fetch, { videoChoice, audioChoice });
        if (!chosenPlan.downloadable) {
          return { error: "Diese Video- und Tonspuren können derzeit nicht als eine Datei gespeichert werden." };
        }
        const chosenCandidate = {
          ...pending.candidate,
          filename: withExtension(pending.candidate.filename, chosenPlan.outputExtension)
        };
        pendingChoices.delete(message.token);
        startStream(chosenCandidate, pending.incognito, videoChoice, audioChoice);
        return { started: true };
      } catch (error) { return { error: errorText(error) }; }
      finally { pending.choosing = false; }
    })();
  }
});

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [token, pending] of pendingChoices) {
    if (pending.createdAt < cutoff) pendingChoices.delete(token);
  }
}, 60_000);

browser.tabs.query({ active: true }).then((tabs) => {
  for (const tab of tabs) schedulePrepareTab(tab.id, 0);
}).catch((error) => console.warn("Initial video pre-scan failed:", error));

// A Firefox restart or add-on update can interrupt a stream after its OPFS
// file was created. No job survives a background-page restart, so these files
// can be removed safely before the next download starts.
(async () => {
  const startedAt = Date.now();
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== "function") return;
  const directory = await storage.getDirectory();
  for await (const [name, handle] of directory.entries()) {
    if (/^firefox-video-saver-[0-9a-f-]+\.part$/i.test(name)) {
      try {
        const file = await handle.getFile();
        if (file.lastModified < startedAt) await directory.removeEntry(name);
      }
      catch (error) { console.warn("Old temporary video file could not be removed:", error); }
    }
  }
})().catch((error) => console.warn("Temporary video file cleanup unavailable:", error));
