/* Runs one HLS/DASH download in Firefox's persistent Manifest V2 background page.
 * Load after mp4-mux.js and streaming.js, before background.js.
 * start(url, {name, videoChoice, audioChoice, ...}) uses title only as a
 * fallback for name. Variant URL aliases support the current StreamTools API.
 */
(function (root) {
  "use strict";

  const jobs = new Map();

  function requirePersistentBackground() {
    const manifest = browser.runtime.getManifest();
    if (manifest.manifest_version !== 2 || manifest.background?.persistent !== true) {
      throw new Error("Stream-Downloads mit Dateiauswahl benötigen eine dauerhafte Firefox-MV2-Hintergrundseite.");
    }
  }

  function sourceUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Die Stream-Quelle muss eine HTTP- oder HTTPS-Adresse sein.");
    }
    return url.href;
  }

  function filenameBase(raw) {
    return String(raw || "Video")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "")
      .slice(0, 100) || "Video";
  }

  function emit(callback, state) {
    try { callback?.(state); }
    catch (error) { console.error("Stream job status listener failed:", error); }
  }

  function downloadsApi(incognito) {
    return {
      download: (options) => browser.downloads.download({
        ...options,
        saveAs: true,
        ...(incognito ? { incognito: true } : {})
      }),
      onChanged: browser.downloads.onChanged,
      search: (query) => browser.downloads.search(query),
      cancel: (id) => browser.downloads.cancel(id)
    };
  }

  function start(rawUrl, options = {}) {
    requirePersistentBackground();
    if (!root.StreamTools?.download) throw new Error("Stream-Downloader ist nicht geladen.");
    const url = sourceUrl(rawUrl);
    const name = filenameBase(options.name || options.title);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });

    const job = { id, url, title: name, startedAt: Date.now(), controller, promise: null };
    const promise = (async () => {
      emit(options.onState, { id, state: "running", title: name });
      try {
        const result = await root.StreamTools.download(url, {
          name,
          signal: controller.signal,
          fetcher: options.fetcher,
          maxBytes: options.maxBytes,
          videoChoice: options.videoChoice,
          audioChoice: options.audioChoice,
          variantUrl: options.variantUrl ??
            (typeof options.videoChoice === "string" ? options.videoChoice : options.videoChoice?.url),
          audioUrl: options.audioUrl ??
            (typeof options.audioChoice === "string" ? options.audioChoice : options.audioChoice?.url),
          downloadsApi: downloadsApi(Boolean(options.incognito)),
          onProgress: (progress) => emit(options.onProgress, { id, ...progress })
        });
        emit(options.onState, { id, state: "complete", result });
        return { id, ...result };
      } catch (error) {
        emit(options.onState, { id, state: controller.signal.aborted ? "cancelled" : "failed", error });
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", forwardAbort);
        jobs.delete(id);
      }
    })();
    job.promise = promise;
    jobs.set(id, job);
    return promise;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  function active() {
    return [...jobs.values()].map(({ id, url, title, startedAt }) => ({ id, url, title, startedAt }));
  }

  root.StreamJob = Object.freeze({ start, cancel, active });
})(typeof globalThis !== "undefined" ? globalThis : this);
