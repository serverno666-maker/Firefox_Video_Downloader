/* Firefox WebExtension helper for finite HLS and unencrypted DASH streams.
 * Include this file in an extension page, then use StreamTools.
 * HLS AES-128 identity keys are supported when the session can fetch them.
 * There are no runtime dependencies or remote services.
 */
(function (root) {
  "use strict";

  class StreamError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "StreamError";
      this.code = code;
    }
  }

  const fail = (code, message) => { throw new StreamError(code, message); };
  const MAX_SEGMENTS = 20000;
  const MAX_MANIFEST_CHARS = 2_000_000;

  function absolute(url, base) {
    if (/\{\$[^}]+\}/.test(url)) fail("UNSUPPORTED_VARIABLE", "HLS variable substitution is not supported.");
    try {
      const result = new URL(url, base);
      if (!/^https?:$/.test(result.protocol)) fail("BAD_URL", "Only HTTP(S) media URLs are supported.");
      return result.href;
    } catch (error) {
      if (error instanceof StreamError) throw error;
      fail("BAD_URL", `Invalid media URL: ${url}`);
    }
  }

  function attrs(text) {
    const result = {};
    let i = 0;
    while (i < text.length) {
      while (text[i] === "," || /\s/.test(text[i] || "")) i++;
      const start = i;
      while (i < text.length && /[A-Za-z0-9-]/.test(text[i])) i++;
      if (i === start || text[i] !== "=") fail("INVALID_MANIFEST", "Invalid attribute list.");
      const name = text.slice(start, i++).toUpperCase();
      let value;
      if (text[i] === '"') {
        const from = ++i;
        while (i < text.length && text[i] !== '"') i++;
        if (i >= text.length) fail("INVALID_MANIFEST", "Unterminated quoted attribute.");
        value = text.slice(from, i++);
      } else {
        const from = i;
        while (i < text.length && text[i] !== ",") i++;
        value = text.slice(from, i).trim();
      }
      result[name] = value;
      if (i < text.length && text[i] !== ",") fail("INVALID_MANIFEST", "Invalid attribute separator.");
    }
    return result;
  }

  function byteRange(value, previousEnd, previousUrl, currentUrl, requireOffset = false) {
    const match = /^(\d+)(?:@(\d+))?$/.exec(value || "");
    if (!match) fail("UNSUPPORTED_RANGE", "Invalid HLS byte range.");
    const length = Number(match[1]);
    const start = match[2] == null ? previousEnd : Number(match[2]);
    if (requireOffset && match[2] == null) fail("UNSUPPORTED_RANGE", "An init-map range needs an explicit offset.");
    if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(start) || start < 0 ||
        (match[2] == null && previousUrl !== currentUrl)) {
      fail("UNSUPPORTED_RANGE", "The implicit HLS byte range cannot be resolved.");
    }
    const end = start + length - 1;
    if (!Number.isSafeInteger(end)) fail("UNSUPPORTED_RANGE", "HLS byte range is too large.");
    return { start, end };
  }

  function inferHlsContainer(parts) {
    if (parts.some(part => part.role === "init")) return { extension: "mp4", mime: "video/mp4" };
    const first = parts.find(part => part.role === "segment");
    const path = new URL(first.url).pathname.toLowerCase();
    if (/\.tsx?$/.test(path)) return { extension: "ts", mime: "video/mp2t" };
    if (/\.aac$/.test(path)) return { extension: "aac", mime: "audio/aac" };
    if (/\.mp3$/.test(path)) return { extension: "mp3", mime: "audio/mpeg" };
    if (/\.m4[as]$/.test(path)) fail("MISSING_INIT", "Fragmented MP4 requires EXT-X-MAP.");
    fail("UNSUPPORTED_CONTAINER", "The segment container is not recognized.");
  }

  function aesIv(value) {
    if (!/^0[xX][0-9a-fA-F]{1,32}$/.test(value || "")) fail("INVALID_MANIFEST", "Invalid HLS AES-128 IV.");
    return sequenceIv(BigInt(value));
  }

  function sequenceIv(sequence) {
    if (sequence < 0n || sequence >= (1n << 128n)) fail("INVALID_MANIFEST", "HLS media sequence exceeds the AES IV range.");
    const iv = new Uint8Array(16);
    for (let i = 15; i >= 0; i--) { iv[i] = Number(sequence & 255n); sequence >>= 8n; }
    return iv;
  }

  function hlsKey(attributes, playlistUrl) {
    if (attributes.METHOD === "NONE") return null;
    if (attributes.METHOD !== "AES-128" || (attributes.KEYFORMAT && attributes.KEYFORMAT !== "identity")) {
      fail("DRM_OR_UNSUPPORTED_ENCRYPTION", "HLS SAMPLE-AES or DRM key formats cannot be saved by this extension.");
    }
    if (attributes.KEYFORMATVERSIONS && !attributes.KEYFORMATVERSIONS.split("/").includes("1")) {
      fail("DRM_OR_UNSUPPORTED_ENCRYPTION", "Unsupported HLS key format version.");
    }
    if (!attributes.URI) fail("INVALID_MANIFEST", "HLS AES-128 key has no URI.");
    return { url: absolute(attributes.URI, playlistUrl), iv: attributes.IV ? aesIv(attributes.IV) : null };
  }

  function parseHls(url, source) {
    if (source.length > MAX_MANIFEST_CHARS) fail("MANIFEST_TOO_LARGE", "The playlist is too large.");
    const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") fail("INVALID_MANIFEST", "This is not an HLS playlist.");
    const master = lines.some(line => line.startsWith("#EXT-X-STREAM-INF:"));
    if (master) {
      const variants = [], audio = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#EXT-X-SESSION-KEY:")) hlsKey(attrs(line.slice(19)), url);
        if (line.startsWith("#EXT-X-MEDIA:")) {
          const item = attrs(line.slice(13));
          if (item.TYPE === "AUDIO") {
            const audioUrl = item.URI ? absolute(item.URI, url) : null;
            audio.push({ groupId: item["GROUP-ID"], name: item.NAME || "audio",
              language: item.LANGUAGE || "", default: item.DEFAULT === "YES",
              channels: item.CHANNELS || "",
              url: audioUrl, value: audioUrl || `embedded-audio:${audio.length}`,
              embedded: !audioUrl });
          }
        }
        if (line.startsWith("#EXT-X-STREAM-INF:")) {
          const item = attrs(line.slice(18));
          let next = i + 1;
          while (next < lines.length && lines[next].startsWith("#")) next++;
          if (next >= lines.length) fail("INVALID_MANIFEST", "An HLS variant has no URL.");
          variants.push({ url: absolute(lines[next], url), bandwidth: Number(item.BANDWIDTH || 0),
            resolution: item.RESOLUTION || "", frameRate: item["FRAME-RATE"] || "",
            codecs: item.CODECS || "", audioGroup: item.AUDIO || "" });
          i = next;
        }
      }
      if (!variants.length) fail("INVALID_MANIFEST", "The HLS master playlist has no variants.");
      return { format: "hls", kind: "master", variants, audio };
    }

    const parts = [];
    let map = null, lastMapKey = null, pendingRange = null, previousEnd = null, previousUrl = null;
    let ended = false, segmentCount = 0, discontinuity = false, pendingGap = false, key = null, keyId = 0;
    let sequence = 0n;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === "#EXT-X-ENDLIST") { ended = true; continue; }
      if (line === "#EXT-X-DISCONTINUITY") { discontinuity = true; continue; }
      if (line === "#EXT-X-GAP") { pendingGap = true; continue; }
      if (line === "#EXT-X-I-FRAMES-ONLY") fail("UNSUPPORTED_IFRAMES", "I-frame-only HLS playlists need special range handling.");
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        const value = line.slice(22);
        if (segmentCount || !/^\d+$/.test(value)) fail("INVALID_MANIFEST", "Invalid HLS media sequence.");
        sequence = BigInt(value);
        continue;
      }
      if (line.startsWith("#EXT-X-KEY:")) {
        key = hlsKey(attrs(line.slice(11)), url);
        if (key) key.id = ++keyId;
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const item = attrs(line.slice(11));
        if (!item.URI) fail("INVALID_MANIFEST", "HLS init map has no URL.");
        const initUrl = absolute(item.URI, url);
        const range = item.BYTERANGE ? byteRange(item.BYTERANGE, null, null, initUrl, true) : null;
        if (key && !key.iv) fail("INVALID_MANIFEST", "An encrypted HLS init map requires an explicit IV.");
        map = { url: initUrl, range, role: "init", key };
        continue;
      }
      if (line.startsWith("#EXT-X-BYTERANGE:")) { pendingRange = line.slice(17); continue; }
      if (line.startsWith("#")) continue;
      if (/\{\$[^}]+\}/.test(line)) fail("UNSUPPORTED_VARIABLE", "HLS variable substitution is not supported.");
      if (pendingGap) fail("UNSUPPORTED_GAP", "The HLS playlist contains a missing segment.");
      const segmentUrl = absolute(line, url);
      const range = pendingRange ? byteRange(pendingRange, previousEnd, previousUrl, segmentUrl) : null;
      if (map) {
        const mapId = `${map.url}|${map.range ? `${map.range.start}-${map.range.end}` : ""}|${map.key ? `${map.key.id}:${map.key.url}:${Array.from(map.key.iv).join("-")}` : ""}`;
        if (mapId !== lastMapKey) { parts.push(map); lastMapKey = mapId; }
      }
      parts.push({ url: segmentUrl, range, role: "segment", key: key ? { id: key.id, url: key.url, iv: key.iv || sequenceIv(sequence) } : null });
      sequence++;
      segmentCount++;
      if (segmentCount > MAX_SEGMENTS) fail("TOO_MANY_SEGMENTS", "The playlist has too many segments.");
      previousEnd = range ? range.end + 1 : null;
      previousUrl = segmentUrl;
      pendingRange = null;
      pendingGap = false;
    }
    if (!ended) fail("LIVE_STREAM", "The HLS playlist is still live or incomplete.");
    if (discontinuity) fail("UNSUPPORTED_DISCONTINUITY", "This HLS stream changes timeline or encoding.");
    if (!segmentCount || pendingRange) fail("INVALID_MANIFEST", "The HLS playlist contains no complete media segments.");
    const container = inferHlsContainer(parts);
    return { format: "hls", kind: "media", parts, segmentCount,
      encrypted: parts.some(part => !!part.key), ...container };
  }

  async function fetchManifest(url, fetchImpl = fetch, signal) {
    const response = await fetchImpl(url, { credentials: "include", signal });
    if (!response.ok) fail("HTTP_ERROR", `Manifest request failed: HTTP ${response.status}.`);
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_MANIFEST_CHARS) fail("MANIFEST_TOO_LARGE", "The manifest is too large.");
    const result = await response.text();
    if (result.length > MAX_MANIFEST_CHARS) fail("MANIFEST_TOO_LARGE", "The manifest is too large.");
    return { text: result, url: absolute(response.url || url, url) };
  }

  async function fetchText(url, fetchImpl = fetch, signal) {
    return (await fetchManifest(url, fetchImpl, signal)).text;
  }

  function manifestRecord(value, requestedUrl) {
    if (typeof value === "string") return { text: value, url: requestedUrl };
    if (value && typeof value.text === "string") {
      return { text: value.text, url: absolute(value.url || requestedUrl, requestedUrl) };
    }
    fail("INVALID_MANIFEST", "The manifest response is invalid.");
  }

  async function resolveHls(url, options = {}) {
    const getText = options.getText || (u => fetchManifest(u, options.fetchImpl, options.signal));
    const master = manifestRecord(await getText(url), url);
    let parsed = parseHls(master.url, master.text);
    if (parsed.kind === "media") return { format: "hls", tracks: [{ type: "media", ...parsed }] };
    const candidates = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth);
    const requestedVideo = requestedChoice(options, "videoChoice", "variantUrl");
    const variant = requestedVideo ? candidates.find(x => x.url === requestedVideo) : candidates[0];
    if (!variant) fail("NO_VARIANT", "The selected HLS variant was not found.");
    const videoManifest = manifestRecord(await getText(variant.url), variant.url);
    const video = parseHls(videoManifest.url, videoManifest.text);
    if (video.kind !== "media") fail("UNSUPPORTED_NESTING", "Nested HLS master playlists are not supported.");
    const tracks = [{ type: "video", url: videoManifest.url, ...video }];
    const audio = parsed.audio.filter(x => x.groupId === variant.audioGroup);
    let selectedAudio = null;
    if (audio.length) {
      const requestedAudio = requestedChoice(options, "audioChoice", "audioUrl");
      const embedded = audio.filter(x => x.embedded);
      const chosen = requestedAudio ? audio.find(x => x.value === requestedAudio) :
        embedded[0] || audio.find(x => x.default) || audio[0];
      if (!chosen) fail("NO_AUDIO", "The selected audio rendition was not found.");
      selectedAudio = chosen;
      if (chosen.embedded && embedded.length > 1 && requestedAudio) {
        fail("UNSUPPORTED_EMBEDDED_AUDIO_SELECTION", "An individual embedded audio language cannot be isolated from this video rendition.");
      }
      if (!chosen.embedded) {
        if (embedded.length) {
          fail("UNSUPPORTED_EMBEDDED_AUDIO_REPLACEMENT", "The selected external audio language cannot replace audio embedded in the video rendition.");
        }
        const audioManifest = manifestRecord(await getText(chosen.url), chosen.url);
        const audioPlaylist = parseHls(audioManifest.url, audioManifest.text);
        if (audioPlaylist.kind !== "media") fail("INVALID_MANIFEST", "The audio rendition is not a media playlist.");
        tracks.push({ type: "audio", url: audioManifest.url, language: chosen.language, ...audioPlaylist,
          mime: audioPlaylist.extension === "mp4" ? "audio/mp4" : audioPlaylist.mime,
          extension: audioPlaylist.extension === "mp4" ? "m4a" : audioPlaylist.extension });
      }
    }
    return { format: "hls", variant, tracks, selectedAudio,
      choices: { video: candidates, audio, allAudio: parsed.audio } };
  }

  function requestedChoice(options, choiceName, legacyName) {
    const raw = Object.prototype.hasOwnProperty.call(options, choiceName) ? options[choiceName] : options[legacyName];
    if (raw == null || raw === "auto") return null;
    if (typeof raw === "object") {
      const value = raw.value || raw.url || raw.id || null;
      return value === "auto" ? null : value;
    }
    return String(raw);
  }

  const childElements = (node, localName) => Array.from(node.children || []).filter(x => x.localName === localName);
  const firstChild = (node, localName) => childElements(node, localName)[0] || null;
  function descendants(node, localName) {
    return Array.from(node.getElementsByTagName("*")).filter(x => x.localName === localName);
  }
  function durationSeconds(value) {
    if (!value) return null;
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!m) fail("UNSUPPORTED_DURATION", `Unsupported DASH duration: ${value}`);
    return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
  }
  function numeric(value, fallback, minimum = 0) {
    const n = value == null ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < minimum) fail("INVALID_MANIFEST", "Invalid DASH segment number.");
    return n;
  }
  function nearestChild(nodes, name) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const found = firstChild(nodes[i], name);
      if (found) return found;
    }
    return null;
  }
  function inheritedSegment(nodes, name) {
    const all = nodes.map(node => firstChild(node, name)).filter(Boolean);
    if (!all.length) return null;
    const attributes = {};
    for (const el of all) for (const attr of Array.from(el.attributes)) attributes[attr.name] = attr.value;
    return { attributes, element: all[all.length - 1], hierarchy: all };
  }
  function dashBase(url, nodes) {
    let base = url;
    for (const node of nodes) {
      const next = firstChild(node, "BaseURL");
      if (next && next.textContent.trim()) base = absolute(next.textContent.trim(), base);
    }
    return base;
  }
  function dashTemplate(template, rep, number, time) {
    const result = template.replace(/\$\$|\$([^$]+)\$/g, (whole, key) => {
      if (whole === "$$") return "$";
      const match = /^(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?$/.exec(key);
      if (!match) fail("UNSUPPORTED_TEMPLATE", `Unsupported DASH template token: ${key}`);
      const values = { RepresentationID: rep.id, Bandwidth: rep.bandwidth, Number: number, Time: time };
      if (values[match[1]] == null) fail("INVALID_MANIFEST", `Missing DASH template value: ${match[1]}`);
      const width = match[2] ? Number(match[2]) : 0;
      if (width > 12) fail("UNSUPPORTED_TEMPLATE", "DASH template width is too large.");
      return String(values[match[1]]).padStart(width, "0");
    });
    if (/\$[^$]+\$/.test(result)) fail("UNSUPPORTED_TEMPLATE", "A DASH template token was not resolved.");
    return result;
  }
  function xmlByteRange(value) {
    if (!value) return null;
    const m = /^(\d+)-(\d+)$/.exec(value);
    if (!m) fail("UNSUPPORTED_RANGE", "Invalid DASH byte range.");
    const start = Number(m[1]), end = Number(m[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) fail("UNSUPPORTED_RANGE", "Invalid DASH byte range.");
    return { start, end };
  }
  function dashParts(nodes, base, rep, periodDuration) {
    const templ = inheritedSegment(nodes, "SegmentTemplate");
    const list = inheritedSegment(nodes, "SegmentList");
    if (templ && list) fail("UNSUPPORTED_ADDRESSING", "Conflicting DASH segment addressing modes.");
    if (templ) {
      const a = templ.attributes;
      if (!a.media) fail("INVALID_MANIFEST", "DASH SegmentTemplate has no media URL.");
      const parts = [];
      if (a.initialization) parts.push({ role: "init", url: absolute(dashTemplate(a.initialization, rep), base), range: null });
      const start = numeric(a.startNumber, 1, 0);
      const scale = numeric(a.timescale, 1, 1);
      const pto = numeric(a.presentationTimeOffset, 0, 0);
      let references = [];
      const timeline = nearestChild(templ.hierarchy, "SegmentTimeline");
      if (timeline) {
        let time = null, number = start;
        const entries = childElements(timeline, "S");
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const d = numeric(entry.getAttribute("d"), null, 1);
          if (entry.hasAttribute("t")) time = numeric(entry.getAttribute("t"), null, 0);
          if (time == null) fail("INVALID_MANIFEST", "DASH timeline has no start time.");
          const r = entry.hasAttribute("r") ? Number(entry.getAttribute("r")) : 0;
          if (!Number.isSafeInteger(r) || r < -1) fail("INVALID_MANIFEST", "Invalid DASH repeat count.");
          let count = r + 1;
          if (r === -1) {
            const next = entries[i + 1];
            const end = next && next.hasAttribute("t") ? numeric(next.getAttribute("t"), null, 0) :
              (periodDuration == null ? null : Math.ceil(periodDuration * scale + pto));
            if (end == null || end <= time) fail("UNSUPPORTED_TIMELINE", "Open-ended DASH timeline cannot be bounded.");
            count = Math.ceil((end - time) / d);
          }
          if (references.length + count > MAX_SEGMENTS) fail("TOO_MANY_SEGMENTS", "Too many DASH segments.");
          for (let j = 0; j < count; j++) { references.push({ number: number++, time }); time += d; }
        }
      } else {
        const d = numeric(a.duration, null, 1);
        if (periodDuration == null) fail("UNSUPPORTED_DURATION", "A DASH duration is required for this template.");
        const count = Math.ceil(periodDuration * scale / d);
        if (count > MAX_SEGMENTS) fail("TOO_MANY_SEGMENTS", "Too many DASH segments.");
        for (let i = 0; i < count; i++) references.push({ number: start + i, time: pto + i * d });
      }
      if (!references.length) fail("INVALID_MANIFEST", "No DASH segments were found.");
      for (const x of references) parts.push({ role: "segment", url: absolute(dashTemplate(a.media, rep, x.number, x.time), base), range: null });
      return parts;
    }
    if (list) {
      const parts = [];
      const init = nearestChild(list.hierarchy, "Initialization");
      if (init) {
        const source = init.getAttribute("sourceURL");
        if (!source) fail("UNSUPPORTED_ADDRESSING", "DASH Initialization without sourceURL is unsupported.");
        parts.push({ role: "init", url: absolute(source, base), range: xmlByteRange(init.getAttribute("range")) });
      }
      let urls = [];
      for (const node of list.hierarchy) {
        const entries = childElements(node, "SegmentURL");
        if (entries.length) urls = entries;
      }
      if (!urls.length || urls.length > MAX_SEGMENTS) fail("INVALID_MANIFEST", "Invalid DASH SegmentList length.");
      for (const item of urls) {
        const media = item.getAttribute("media");
        if (!media) fail("UNSUPPORTED_ADDRESSING", "DASH SegmentURL without media is unsupported.");
        parts.push({ role: "segment", url: absolute(media, base), range: xmlByteRange(item.getAttribute("mediaRange")) });
      }
      return parts;
    }
    fail("UNSUPPORTED_ADDRESSING", "DASH SegmentBase and single-file indexes are not supported.");
  }

  function parseDash(url, source, options = {}) {
    if (source.length > MAX_MANIFEST_CHARS) fail("MANIFEST_TOO_LARGE", "The MPD is too large.");
    if (typeof DOMParser === "undefined") fail("NO_XML_PARSER", "DASH parsing needs a browser DOMParser.");
    const xml = new DOMParser().parseFromString(source, "application/xml");
    const mpd = xml.documentElement;
    if (!mpd || mpd.localName !== "MPD" || descendants(xml, "parsererror").length) fail("INVALID_MANIFEST", "Invalid DASH MPD XML.");
    if ((mpd.getAttribute("type") || "static") !== "static") fail("LIVE_STREAM", "Dynamic DASH streams are not supported.");
    if (descendants(mpd, "ContentProtection").length) fail("ENCRYPTED", "The DASH MPD declares protected media.");
    const periods = childElements(mpd, "Period");
    if (periods.length !== 1) fail("UNSUPPORTED_PERIODS", "DASH requires exactly one period.");
    const period = periods[0];
    const duration = durationSeconds(period.getAttribute("duration") || mpd.getAttribute("mediaPresentationDuration"));
    const optionsByType = { video: [], audio: [] };
    for (const adaptation of childElements(period, "AdaptationSet")) {
      const mime = adaptation.getAttribute("mimeType") || "";
      const typeHint = adaptation.getAttribute("contentType") || "";
      for (const element of childElements(adaptation, "Representation")) {
        const repMime = element.getAttribute("mimeType") || mime;
        const type = typeHint || (repMime.startsWith("video/") ? "video" : repMime.startsWith("audio/") ? "audio" : "");
        if (type !== "video" && type !== "audio") continue;
        if (!/^(video|audio)\/mp4$/.test(repMime)) continue;
        const rep = { id: element.getAttribute("id"), bandwidth: Number(element.getAttribute("bandwidth") || 0) };
        if (!rep.id) fail("INVALID_MANIFEST", "DASH Representation has no ID.");
        const nodes = [mpd, period, adaptation, element];
        const base = dashBase(url, nodes);
        optionsByType[type].push({ type, id: rep.id, bandwidth: rep.bandwidth,
          width: Number(element.getAttribute("width") || adaptation.getAttribute("width") || 0),
          height: Number(element.getAttribute("height") || adaptation.getAttribute("height") || 0),
          frameRate: element.getAttribute("frameRate") || adaptation.getAttribute("frameRate") || "",
          codecs: element.getAttribute("codecs") || adaptation.getAttribute("codecs") || "",
          language: adaptation.getAttribute("lang") || "", extension: type === "audio" ? "m4a" : "mp4",
          mime: repMime, parts: dashParts(nodes, base, rep, duration) });
      }
    }
    for (const type of ["video", "audio"]) optionsByType[type].sort((a, b) => b.bandwidth - a.bandwidth);
    const tracks = [];
    for (const type of ["video", "audio"]) {
      const choices = optionsByType[type];
      if (!choices.length) continue;
      const requested = type === "video"
        ? requestedChoice(options, "videoChoice", "videoId")
        : requestedChoice(options, "audioChoice", "audioId");
      const chosen = requested ? choices.find(x => x.id === requested) : choices[0];
      if (!chosen) fail("NO_VARIANT", `DASH ${type} representation was not found.`);
      tracks.push(chosen);
    }
    if (!tracks.length) fail("UNSUPPORTED_CONTAINER", "No unencrypted MP4 audio or video representation was found.");
    return { format: "dash", tracks, choices: optionsByType };
  }

  async function resolveStream(url, options = {}) {
    const getText = options.getText || (u => fetchManifest(u, options.fetchImpl, options.signal));
    const manifest = manifestRecord(await getText(url), url);
    if (manifest.text.trimStart().startsWith("#EXTM3U")) {
      return resolveHls(manifest.url, {
        ...options,
        getText: u => u === manifest.url ? manifest : getText(u)
      });
    }
    if (manifest.text.trimStart().startsWith("<")) return parseDash(manifest.url, manifest.text, options);
    fail("UNKNOWN_FORMAT", "The URL does not contain an HLS or DASH manifest.");
  }

  async function fetchAesKey(url, fetchImpl, signal, subtle) {
    const response = await fetchImpl(url, { credentials: "include", signal });
    if (!response.ok) fail("KEY_HTTP_ERROR", `HLS key request failed: HTTP ${response.status}.`);
    const declaredLength = Number(response.headers && response.headers.get("content-length"));
    if (declaredLength > 16) fail("INVALID_KEY", "An HLS AES-128 identity key must be exactly 16 bytes.");
    const bytes = new Uint8Array(16);
    let length = 0;
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.byteLength > 16) {
          await reader.cancel();
          fail("INVALID_KEY", "An HLS AES-128 identity key must be exactly 16 bytes.");
        }
        bytes.set(value, length);
        length += value.byteLength;
      }
    } else {
      const value = new Uint8Array(await response.arrayBuffer());
      length = value.byteLength;
      if (length === 16) bytes.set(value);
    }
    if (length !== 16) fail("INVALID_KEY", "An HLS AES-128 identity key must be exactly 16 bytes.");
    try { return await subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["decrypt"]); }
    finally { bytes.fill(0); }
  }

  async function trackToSink(track, options, sink) {
    const fetchImpl = options.fetchImpl || fetch;
    const maxBytes = options.maxBytes == null ? Number.MAX_SAFE_INTEGER : options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("TOO_LARGE", "Invalid stream size limit.");
    if (!Array.isArray(track.parts) || !track.parts.length || track.parts.length > MAX_SEGMENTS + 20) {
      fail("INVALID_PLAN", "Invalid segment plan.");
    }
    const keyCache = new Map();
    let downloaded = 0;
    for (let index = 0; index < track.parts.length; index++) {
      if (options.signal && options.signal.aborted) fail("ABORTED", "Download cancelled.");
      const part = track.parts[index];
      const headers = part.range ? { Range: `bytes=${part.range.start}-${part.range.end}` } : {};
      const response = await fetchImpl(part.url, { credentials: "include", headers, signal: options.signal });
      if (!response.ok || (part.range && response.status !== 206)) {
        fail("HTTP_ERROR", `Segment ${index + 1} failed: HTTP ${response.status}.`);
      }
      const contentType = (response.headers && response.headers.get("content-type") || "").toLowerCase();
      if (contentType.startsWith("text/html") || contentType.startsWith("application/json")) {
        fail("UNEXPECTED_RESPONSE", `Segment ${index + 1} returned a web page or API response instead of media.`);
      }
      const contentLength = Number(response.headers && response.headers.get("content-length"));
      if (contentLength > 0 && downloaded + contentLength > maxBytes) {
        fail("TOO_LARGE", "The stream exceeds the available size limit.");
      }
      let partBytes = 0;
      // AES-CBC needs one complete segment for authentication/padding; ordinary
      // segments can be written a network chunk at a time.
      const partChunks = part.key ? [] : null;
      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (options.signal?.aborted) fail("ABORTED", "Download cancelled.");
            downloaded += value.byteLength;
            partBytes += value.byteLength;
            if (downloaded > maxBytes) fail("TOO_LARGE", "The stream exceeds the available size limit.");
            if (partChunks) partChunks.push(value);
            else await sink.write(value);
          }
        } catch (error) {
          try { await reader.cancel(); } catch (_) { /* Preserve the original error. */ }
          throw error;
        }
      } else {
        const value = new Uint8Array(await response.arrayBuffer());
        downloaded += value.byteLength;
        partBytes += value.byteLength;
        if (downloaded > maxBytes) fail("TOO_LARGE", "The stream exceeds the available size limit.");
        if (partChunks) partChunks.push(value);
        else await sink.write(value);
      }
      if (part.range && partBytes !== part.range.end - part.range.start + 1) {
        fail("RANGE_MISMATCH", `Segment ${index + 1} returned the wrong byte range length.`);
      }
      if (part.key) {
        if (partBytes === 0 || partBytes % 16 !== 0) fail("INVALID_CIPHERTEXT", "HLS AES-128 segment is not block-aligned.");
        const subtle = root.crypto && root.crypto.subtle;
        if (!subtle) fail("CRYPTO_UNAVAILABLE", "AES-CBC decryption is unavailable in this extension context.");
        const cacheId = part.key.id == null ? part.key.url : part.key.id;
        let cryptoKey = keyCache.get(cacheId);
        if (!cryptoKey) {
          cryptoKey = await fetchAesKey(part.key.url, fetchImpl, options.signal, subtle);
          keyCache.set(cacheId, cryptoKey);
        }
        const ciphertext = new Uint8Array(partBytes);
        let offset = 0;
        for (const chunk of partChunks) { ciphertext.set(chunk, offset); offset += chunk.byteLength; }
        let plaintext;
        try {
          plaintext = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: part.key.iv }, cryptoKey, ciphertext));
        } catch (_) {
          fail("DECRYPT_FAILED", `HLS segment ${index + 1} could not be decrypted with its playlist key.`);
        }
        await sink.write(plaintext);
      }
      if (options.onProgress) options.onProgress({ complete: index + 1, total: track.parts.length, bytes: downloaded });
    }
    return downloaded;
  }

  async function trackToBlob(track, options = {}) {
    const chunks = [];
    await trackToSink(track, {
      ...options,
      maxBytes: options.maxBytes == null ? 512 * 1024 * 1024 : options.maxBytes
    }, { write: chunk => { chunks.push(chunk); } });
    return new Blob(chunks, { type: track.mime || "application/octet-stream" });
  }

  async function temporaryFile(track, options = {}) {
    const storage = root.navigator?.storage;
    if (typeof storage?.getDirectory !== "function") return null;
    let directory;
    try {
      directory = await storage.getDirectory();
    } catch (error) {
      // Firefox can disable OPFS for a profile. The bounded Blob path below
      // still handles small files and reports its limit for larger ones.
      console.warn("Temporary file storage unavailable:", error);
      return null;
    }
    const name = `firefox-video-saver-${root.crypto.randomUUID()}.part`;
    let handle;
    try {
      handle = await directory.getFileHandle(name, { create: true });
    } catch (error) {
      console.warn("Temporary file could not be created:", error);
      return null;
    }
    let writable;
    try {
      writable = await handle.createWritable();
    } catch (error) {
      try { await directory.removeEntry(name); } catch (_) { /* Entry may not exist. */ }
      console.warn("Temporary file could not be opened:", error);
      return null;
    }
    try {
      await trackToSink(track, options, writable);
      if (options.signal?.aborted) fail("ABORTED", "Download cancelled.");
      await writable.close();
      writable = null;
      const file = await handle.getFile();
      return { file, cleanup: () => directory.removeEntry(name) };
    } catch (error) {
      if (writable) {
        try { await writable.abort(); } catch (_) { /* Preserve the original error. */ }
      }
      try { await directory.removeEntry(name); } catch (_) { /* Preserve the original error. */ }
      throw error;
    }
  }

  function safeFilename(name, extension) {
    const base = String(name || "video").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").replace(/[. ]+$/, "").slice(0, 120) || "video";
    return `${base}.${extension}`;
  }

  async function saveBlob(blob, name, extension, downloadsApi = root.browser && root.browser.downloads, signal) {
    if (!downloadsApi) fail("NO_DOWNLOAD_API", "Firefox downloads permission is required.");
    if (signal && signal.aborted) fail("ABORTED", "Download cancelled.");
    const url = URL.createObjectURL(blob);
    try {
      const id = await downloadsApi.download({ url, filename: safeFilename(name, extension), saveAs: true, conflictAction: "uniquify" });
      return await new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer = null;
        let checking = false;
        const finish = (state, error) => {
          if (settled || (state !== "complete" && state !== "interrupted")) return;
          settled = true;
          if (pollTimer !== null) clearInterval(pollTimer);
          downloadsApi.onChanged.removeListener(listener);
          if (signal) signal.removeEventListener("abort", abort);
          URL.revokeObjectURL(url);
          if (state === "complete") resolve(id);
          else reject(new StreamError("DOWNLOAD_INTERRUPTED", error || "Firefox interrupted the download."));
        };
        const listener = change => {
          if (change.id === id && change.state) finish(change.state.current, change.error && change.error.current);
        };
        const abort = () => {
          if (downloadsApi.cancel) Promise.resolve().then(() => downloadsApi.cancel(id))
            .catch(() => {}).finally(() => finish("interrupted", "Download cancelled."));
          else finish("interrupted", "Download cancelled.");
        };
        const inspect = async () => {
          if (settled || checking || !downloadsApi.search) return;
          checking = true;
          try {
            const items = await downloadsApi.search({ id });
            if (items[0]) finish(items[0].state, items[0].error);
          } catch (_) { /* onChanged may still report completion. */ }
          finally { checking = false; }
        };
        downloadsApi.onChanged.addListener(listener);
        if (signal) signal.addEventListener("abort", abort, { once: true });
        if (signal && signal.aborted) abort();
        // Firefox can miss an onChanged event while its native Save As dialog
        // is open. Poll until the transfer actually finishes before releasing
        // the Blob URL and the temporary file behind it.
        if (downloadsApi.search && !settled) {
          pollTimer = setInterval(inspect, 1000);
          inspect();
        }
      });
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function bitrateLabel(bandwidth) {
    const value = Number(bandwidth);
    if (!Number.isFinite(value) || value <= 0) return "";
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(value / 1_000)} kbit/s`;
  }

  function videoChoiceLabel(item, format) {
    const resolution = format === "hls" ? item.resolution :
      (item.width && item.height ? `${item.width}x${item.height}` : "");
    const quality = /^(\d+)x(\d+)$/.exec(resolution || "");
    const parts = [quality ? `${quality[2]}p (${resolution})` : (resolution || "")];
    const bitrate = bitrateLabel(item.bandwidth);
    if (bitrate) parts.push(bitrate);
    if (item.codecs) parts.push(item.codecs.split(",")[0].slice(0, 32));
    return parts.filter(Boolean).join(" · ") || `Video ${item.id || ""}`.trim();
  }

  function audioChoiceLabel(item) {
    const name = item.name || (item.language ? `Ton ${item.language}` : `Tonspur ${item.id || ""}`.trim());
    const parts = [name];
    if (item.language && !name.toLowerCase().includes(item.language.toLowerCase())) parts.push(item.language);
    const bitrate = bitrateLabel(item.bandwidth);
    if (bitrate) parts.push(bitrate);
    if (item.channels) parts.push(`${item.channels} Kanäle`);
    return parts.join(" · ");
  }

  function choiceList(raw, format, type, selectedId, automatic) {
    if (!raw?.length) return [];
    const result = [{
      value: "auto", label: type === "video" ? "Automatisch (beste Qualität)" : "Automatisch (Standardton)",
      selected: automatic, automatic: true
    }];
    for (const item of raw) {
      const value = format === "hls" ? (item.value || item.url) : item.id;
      const supported = !(format === "hls" && type === "audio" && !item.embedded &&
        raw.some(other => other.embedded && other.groupId === item.groupId));
      const label = type === "video" ? videoChoiceLabel(item, format) : audioChoiceLabel(item);
      result.push({
        value, label: supported ? label : `${label} · nicht speicherbar`, supported,
        selected: !automatic && value === selectedId,
        automatic: false,
        bandwidth: item.bandwidth || 0,
        language: item.language || "",
        resolution: item.resolution || (item.width && item.height ? `${item.width}x${item.height}` : ""),
        groupId: item.groupId || "",
        audioGroup: item.audioGroup || "",
        embedded: Boolean(item.embedded)
      });
    }
    return result;
  }

  async function analyze(url, fetcher = fetch, options = {}) {
    const plan = await resolveStream(url, { ...options, fetchImpl: fetcher });
    const videoChoices = plan.choices?.video || [];
    const audioChoices = plan.choices?.audio || [];
    const allAudioChoices = plan.choices?.allAudio || audioChoices;
    const videoSelected = plan.format === "hls" ? plan.variant?.url : plan.tracks.find(track => track.type === "video")?.id;
    const audioSelected = plan.format === "hls" ? plan.selectedAudio?.value :
      plan.tracks.find(track => track.type === "audio")?.id;
    const explicitVideo = requestedChoice(options, "videoChoice", plan.format === "hls" ? "variantUrl" : "videoId");
    const explicitAudio = requestedChoice(options, "audioChoice", plan.format === "hls" ? "audioUrl" : "audioId");
    const fragmented = track => track && ["mp4", "m4a"].includes(track.extension) &&
      track.parts.some(part => part.role === "init");
    const outputExtension = plan.tracks.length === 1 ? plan.tracks[0].extension :
      plan.tracks.length === 2 && fragmented(plan.tracks.find(track => track.type === "video")) &&
      fragmented(plan.tracks.find(track => track.type === "audio")) ? "mp4" : null;
    return {
      ...plan,
      variants: videoChoices,
      audioVariants: audioChoices,
      videoChoices: choiceList(videoChoices, plan.format, "video", videoSelected, !explicitVideo),
      audioChoices: choiceList(allAudioChoices, plan.format, "audio", audioSelected, !explicitAudio)
        .map(choice => ({ ...choice, compatible: choice.automatic || plan.format !== "hls" ||
          choice.groupId === plan.variant?.audioGroup })),
      outputExtension,
      downloadable: Boolean(outputExtension),
      separateTracks: plan.tracks.length > 1,
      encrypted: plan.tracks.some(track => track.encrypted),
      segmentCount: plan.tracks.reduce((sum, track) => sum + track.parts.filter(part => part.role === "segment").length, 0)
    };
  }

  async function download(url, options = {}) {
    const fetcher = options.fetcher || fetch;
    const plan = await analyze(url, fetcher, options);
    if (!plan.downloadable) {
      fail("MUX_UNSUPPORTED", "The selected video and audio tracks cannot be saved as one file.");
    }
    const requestedLimit = options.maxBytes == null ? Number.MAX_SAFE_INTEGER : options.maxBytes;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) fail("TOO_LARGE", "Invalid stream size limit.");
    // The MP4 remuxer still needs both tracks in memory. Single tracks go
    // directly to Firefox's native download when a stream saver is supplied.
    const maxTotalBytes = Math.min(requestedLimit, 512 * 1024 * 1024);
    const basename = options.name || "video";
    const video = plan.tracks.find(track => track.type === "video");
    const audio = plan.tracks.find(track => track.type === "audio");
    const isFragmentedMp4 = track => track && ["mp4", "m4a"].includes(track.extension) &&
      track.parts.some(part => part.role === "init");
    if (plan.separateTracks) {
      if (plan.tracks.length !== 2 || !isFragmentedMp4(video) || !isFragmentedMp4(audio)) {
        fail("MUX_UNSUPPORTED", "Separate tracks can only be combined when both are fragmented MP4 with init segments.");
      }
      if (!root.Mp4Mux || typeof root.Mp4Mux.remux !== "function") {
        fail("MUX_UNAVAILABLE", "The local MP4 remuxer is not loaded.");
      }
    }
    const mergeTracks = async signal => {
      let usedBytes = 0;
      const load = async track => {
        const blob = await trackToBlob(track, {
          fetchImpl: fetcher, signal, maxBytes: maxTotalBytes - usedBytes,
          onProgress: progress => options.onProgress && options.onProgress({ ...progress, track: track.type })
        });
        usedBytes += blob.size;
        return blob;
      };
      const videoBlob = await load(video);
      const audioBlob = await load(audio);
      if (signal?.aborted) throw new DOMException("Download abgebrochen.", "AbortError");
      if (options.onProgress) options.onProgress({ phase: "mux", track: "combined", bytes: usedBytes });
      return root.Mp4Mux.remux(videoBlob, audioBlob);
    };
    if (options.streamSaver) {
      const extension = plan.outputExtension;
      const filename = safeFilename(basename, extension);
      const saved = await options.streamSaver({
        url, filename, extension, signal: options.signal,
        mime: extension === "ts" ? "video/mp2t" : extension === "m4a" ? "audio/mp4" : "video/mp4",
        produce: async (sink, signal) => {
          if (!plan.separateTracks) {
            const track = plan.tracks[0];
            return trackToSink(track, {
              fetchImpl: fetcher, signal, maxBytes: requestedLimit,
              onProgress: progress => options.onProgress && options.onProgress({ ...progress, track: track.type })
            }, sink);
          }
          const merged = await mergeTracks(signal);
          const reader = merged.stream().getReader();
          try {
            while (true) {
              if (signal?.aborted) throw new DOMException("Download abgebrochen.", "AbortError");
              const { value, done } = await reader.read();
              if (done) break;
              await sink.write(value);
            }
          } finally { reader.releaseLock(); }
        }
      });
      return { format: plan.format, files: [{ id: saved.id, filename,
        type: plan.separateTracks ? "combined" : plan.tracks[0].type, bytes: saved.bytes }],
        separateTracks: false, muxed: plan.separateTracks };
    }
    const saveOne = async (blob, extension, muxed) => {
      const filename = safeFilename(basename, extension);
      const id = await saveBlob(blob, basename, extension, options.downloadsApi, options.signal);
      return { format: plan.format, files: [{ id, filename, type: muxed ? "combined" : plan.tracks[0].type,
        bytes: blob.size }], separateTracks: false, muxed };
    };
    if (!plan.separateTracks) {
      const track = plan.tracks[0];
      const trackOptions = {
        fetchImpl: fetcher,
        signal: options.signal,
        maxBytes: requestedLimit,
        onProgress: progress => options.onProgress && options.onProgress({ ...progress, track: track.type })
      };
      const temporary = await temporaryFile(track, trackOptions);
      if (temporary) {
        try { return await saveOne(temporary.file, track.extension, false); }
        finally {
          try { await temporary.cleanup(); }
          catch (error) { console.warn("Temporary video file cleanup failed:", error); }
        }
      }
      try {
        const blob = await trackToBlob(track, { ...trackOptions, maxBytes: maxTotalBytes });
        return saveOne(blob, track.extension, false);
      } catch (error) {
        if (error?.code === "TOO_LARGE" && requestedLimit > maxTotalBytes) {
          fail("TOO_LARGE", "Temporärer Dateispeicher ist in diesem Firefox-Kontext nicht verfügbar; der Stream überschreitet das 512-MiB-Speicherlimit.");
        }
        throw error;
      }
    }

    const merged = await mergeTracks(options.signal);
    return saveOne(merged, "mp4", true);
  }

  const api = { StreamError, analyze, download, parseHls, parseDash, resolveHls, resolveStream,
    fetchText, trackToBlob, saveBlob, safeFilename };
  root.StreamDownloads = api;
  root.StreamTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
