/* Remux two unencrypted, fragmented MP4 tracks into one playable MP4.
 * Supports relocatable CMAF/DASH fragments (default-base-is-moof + trun data offset).
 * A classic script: window.Mp4Mux.remux(videoBlob, audioBlob) -> Promise<Blob>.
 */
(function (root) {
  "use strict";

  class MuxError extends Error {
    constructor(code, message) { super(message); this.name = "MuxError"; this.code = code; }
  }
  const fail = (code, message) => { throw new MuxError(code, message); };
  const LIMIT_INIT = 16 * 1024 * 1024;
  const LIMIT_MOOF = 16 * 1024 * 1024;
  const MAX_FRAGMENTS = 20000;

  function u32(bytes, at) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at); }
  function u64(bytes, at) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at); }
  function put32(bytes, at, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value); }
  function put64(bytes, at, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(at, value); }
  function typeAt(bytes, at) { return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]); }
  function concat(parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) { result.set(part, at); at += part.byteLength; }
    return result;
  }
  function makeBox(type, payload) {
    if (type.length !== 4 || payload.byteLength + 8 > 0xffffffff) fail("MUX_SIZE", "MP4 box is too large.");
    const box = new Uint8Array(payload.byteLength + 8);
    put32(box, 0, box.length);
    for (let i = 0; i < 4; i++) box[4 + i] = type.charCodeAt(i);
    box.set(payload, 8);
    return box;
  }

  function boxList(bytes, from = 0, end = bytes.byteLength) {
    const result = [];
    let pos = from;
    while (pos < end) {
      if (pos + 8 > end) fail("INVALID_MP4", "Truncated MP4 box header.");
      let size = u32(bytes, pos), header = 8;
      const type = typeAt(bytes, pos + 4);
      if (size === 1) {
        if (pos + 16 > end) fail("INVALID_MP4", "Truncated large MP4 box header.");
        const large = u64(bytes, pos + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail("MUX_SIZE", "MP4 box exceeds safe size.");
        size = Number(large); header = 16;
      } else if (size === 0) size = end - pos;
      if (size < header || pos + size > end) fail("INVALID_MP4", `Invalid ${type} box length.`);
      result.push({ type, start: pos, end: pos + size, size, header, payload: pos + header });
      pos += size;
    }
    return result;
  }
  function children(bytes, parent) { return boxList(bytes, parent.payload, parent.end); }
  function one(boxes, type) {
    const matches = boxes.filter(x => x.type === type);
    if (matches.length !== 1) fail("UNSUPPORTED_MP4", `Expected one ${type} box, found ${matches.length}.`);
    return matches[0];
  }
  function copy(bytes, box) { return bytes.slice(box.start, box.end); }
  function fullBoxVersion(bytes, box) { return bytes[box.payload]; }
  function fullBoxFlags(bytes, box) {
    return (bytes[box.payload + 1] << 16) | (bytes[box.payload + 2] << 8) | bytes[box.payload + 3];
  }
  function uint64Or32(bytes, box, offset32, offset64) {
    return fullBoxVersion(bytes, box) === 1 ? u64(bytes, box.payload + offset64) : BigInt(u32(bytes, box.payload + offset32));
  }
  function findNested(bytes, box, path) {
    let node = box;
    for (const type of path) node = one(children(bytes, node), type);
    return node;
  }
  function scanEncryption(bytes, boxes) {
    const forbidden = new Set(["pssh", "senc", "saiz", "saio", "sinf", "tenc"]);
    const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"]);
    for (const box of boxes) {
      if (forbidden.has(box.type)) fail("PROTECTED_MP4", "The MP4 track contains encryption metadata.");
      if (containers.has(box.type)) scanEncryption(bytes, children(bytes, box));
    }
  }

  async function topLevel(blob) {
    const boxes = [];
    for (let pos = 0; pos < blob.size;) {
      const bytes = new Uint8Array(await blob.slice(pos, Math.min(blob.size, pos + 16)).arrayBuffer());
      if (bytes.length < 8) fail("INVALID_MP4", "Truncated top-level MP4 box.");
      let size = u32(bytes, 0), header = 8;
      const type = typeAt(bytes, 4);
      if (size === 1) {
        if (bytes.length < 16) fail("INVALID_MP4", "Truncated large top-level MP4 box.");
        const large = u64(bytes, 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail("MUX_SIZE", "MP4 box exceeds safe size.");
        size = Number(large); header = 16;
      } else if (size === 0) size = blob.size - pos;
      if (size < header || pos + size > blob.size) fail("INVALID_MP4", `Invalid ${type} box length.`);
      boxes.push({ type, start: pos, end: pos + size, size, header });
      pos += size;
      if (boxes.length > MAX_FRAGMENTS * 8) fail("TOO_MANY_BOXES", "The MP4 contains too many boxes.");
    }
    return boxes;
  }

  async function inspectTrack(blob, expectedType) {
    if (!(blob instanceof Blob) || !blob.size) fail("INVALID_TRACK", "A complete track Blob is required.");
    const top = await topLevel(blob);
    if (top.some(box => box.type === "pssh")) fail("PROTECTED_MP4", "The MP4 track contains DRM metadata.");
    const ftyp = one(top, "ftyp"), moov = one(top, "moov");
    if (ftyp.start > moov.start) fail("INVALID_MP4", "ftyp must precede moov.");
    if (moov.size > LIMIT_INIT) fail("MUX_SIZE", "MP4 initialization metadata is too large.");
    const ftypBytes = new Uint8Array(await blob.slice(ftyp.start, ftyp.end).arrayBuffer());
    const moovBytes = new Uint8Array(await blob.slice(moov.start, moov.end).arrayBuffer());
    const rootBox = one(boxList(moovBytes), "moov");
    const moovChildren = children(moovBytes, rootBox);
    scanEncryption(moovBytes, moovChildren);
    const mvhd = one(moovChildren, "mvhd"), trak = one(moovChildren, "trak"), mvex = one(moovChildren, "mvex");
    const tkhd = one(children(moovBytes, trak), "tkhd");
    const mdhd = findNested(moovBytes, trak, ["mdia", "mdhd"]);
    const hdlr = findNested(moovBytes, trak, ["mdia", "hdlr"]);
    const trex = one(children(moovBytes, mvex), "trex");
    if (children(moovBytes, trak).some(x => x.type === "tref")) fail("UNSUPPORTED_MP4", "Track references need a full MP4 muxer.");
    const handler = typeAt(moovBytes, hdlr.payload + 8);
    if (handler !== expectedType) fail("INVALID_TRACK", `Expected ${expectedType}, found ${handler}.`);
    const trackIdOffset = tkhd.payload + (fullBoxVersion(moovBytes, tkhd) === 1 ? 20 : 12);
    const trackId = u32(moovBytes, trackIdOffset);
    if (!trackId || u32(moovBytes, trex.payload + 4) !== trackId) fail("INVALID_MP4", "Inconsistent MP4 track ID.");
    const timescale = u32(moovBytes, mdhd.payload + (fullBoxVersion(moovBytes, mdhd) === 1 ? 20 : 12));
    const movieTimescale = u32(moovBytes, mvhd.payload + (fullBoxVersion(moovBytes, mvhd) === 1 ? 20 : 12));
    if (!timescale || !movieTimescale) fail("INVALID_MP4", "Invalid MP4 timescale.");
    const stbl = findNested(moovBytes, trak, ["mdia", "minf", "stbl"]);
    const tables = children(moovBytes, stbl);
    const stsd = tables.find(x => x.type === "stsd");
    if (stsd) {
      const count = u32(moovBytes, stsd.payload + 4);
      const sampleEntries = boxList(moovBytes, stsd.payload + 8, stsd.end);
      if (sampleEntries.length !== count) fail("INVALID_MP4", "Invalid MP4 sample descriptions.");
      if (sampleEntries.some(x => x.type === "encv" || x.type === "enca")) {
        fail("PROTECTED_MP4", "Encrypted MP4 sample entries are not supported.");
      }
    }
    const stsz = tables.find(x => x.type === "stsz");
    const stco = tables.find(x => x.type === "stco" || x.type === "co64");
    if (stsz && u32(moovBytes, stsz.payload + 8) !== 0) fail("UNSUPPORTED_MP4", "The track contains non-fragmented samples.");
    if (stco && u32(moovBytes, stco.payload + 4) !== 0) fail("UNSUPPORTED_MP4", "The track contains absolute chunk offsets.");
    if (tables.some(x => x.type === "stz2")) fail("UNSUPPORTED_MP4", "Compact sample tables are unsupported.");
    return { blob, top, ftypBytes, moovBytes, moovChildren, mvhd, trak, mvex, tkhd,
      trex, trackId, trackIdOffset, timescale, movieTimescale };
  }

  function combinedMoov(video, audio, audioId) {
    const audioTrak = copy(audio.moovBytes, audio.trak);
    const trakRoot = one(boxList(audioTrak), "trak");
    const localTrak = one(children(audioTrak, trakRoot), "tkhd");
    put32(audioTrak, localTrak.payload + (fullBoxVersion(audioTrak, localTrak) === 1 ? 20 : 12), audioId);
    const rescale = (value, bits) => {
      const max = (1n << BigInt(bits)) - 1n;
      if (value === max) return value;
      const scaled = (value * BigInt(video.movieTimescale) + BigInt(audio.movieTimescale) / 2n) / BigInt(audio.movieTimescale);
      if (scaled > max) fail("MUX_SIZE", "MP4 movie duration exceeds its field width.");
      return scaled;
    };
    const tkhdVersion = fullBoxVersion(audioTrak, localTrak);
    const tkhdDurationOffset = localTrak.payload + (tkhdVersion === 1 ? 28 : 20);
    const tkhdDuration = tkhdVersion === 1 ? u64(audioTrak, tkhdDurationOffset) : BigInt(u32(audioTrak, tkhdDurationOffset));
    const scaledTkhd = rescale(tkhdDuration, tkhdVersion === 1 ? 64 : 32);
    if (tkhdVersion === 1) put64(audioTrak, tkhdDurationOffset, scaledTkhd);
    else put32(audioTrak, tkhdDurationOffset, Number(scaledTkhd));
    const edts = children(audioTrak, trakRoot).find(x => x.type === "edts");
    if (edts) {
      const elst = one(children(audioTrak, edts), "elst");
      const version = fullBoxVersion(audioTrak, elst);
      const count = u32(audioTrak, elst.payload + 4);
      const width = version === 1 ? 20 : 12;
      if (elst.payload + 8 + count * width > elst.end) fail("INVALID_MP4", "Invalid MP4 edit list.");
      for (let i = 0; i < count; i++) {
        const at = elst.payload + 8 + i * width;
        const original = version === 1 ? u64(audioTrak, at) : BigInt(u32(audioTrak, at));
        const scaled = rescale(original, version === 1 ? 64 : 32);
        if (version === 1) put64(audioTrak, at, scaled);
        else put32(audioTrak, at, Number(scaled));
      }
    }
    const audioTrex = copy(audio.moovBytes, audio.trex);
    const localTrex = one(boxList(audioTrex), "trex");
    put32(audioTrex, localTrex.payload + 4, audioId);
    const videoMvexChildren = children(video.moovBytes, video.mvex);
    if (videoMvexChildren.some(x => x.type !== "trex" && x.type !== "mehd")) {
      fail("UNSUPPORTED_MP4", "Unexpected movie-fragment metadata.");
    }
    const mvex = makeBox("mvex", concat([...videoMvexChildren.filter(x => x.type === "trex").map(x => copy(video.moovBytes, x)), audioTrex]));
    const parts = [];
    for (const item of video.moovChildren) {
      if (item.type === "trak") { parts.push(copy(video.moovBytes, item), audioTrak); continue; }
      if (item.type === "mvex") { parts.push(mvex); continue; }
      if (item.type === "mvhd") {
        const mvhd = copy(video.moovBytes, item);
        const local = one(boxList(mvhd), "mvhd");
        const version = fullBoxVersion(mvhd, local);
        const durationAt = local.payload + (version === 1 ? 24 : 16);
        const currentDuration = version === 1 ? u64(mvhd, durationAt) : BigInt(u32(mvhd, durationAt));
        const audioDurationAt = audio.mvhd.payload + (fullBoxVersion(audio.moovBytes, audio.mvhd) === 1 ? 24 : 16);
        const rawAudioDuration = fullBoxVersion(audio.moovBytes, audio.mvhd) === 1 ?
          u64(audio.moovBytes, audioDurationAt) : BigInt(u32(audio.moovBytes, audioDurationAt));
        const scaledAudioDuration = rescale(rawAudioDuration, version === 1 ? 64 : 32);
        const combinedDuration = currentDuration > scaledAudioDuration ? currentDuration : scaledAudioDuration;
        if (version === 1) put64(mvhd, durationAt, combinedDuration);
        else put32(mvhd, durationAt, Number(combinedDuration));
        const nextId = Math.max(video.trackId, audioId) + 1;
        if (nextId > 0xffffffff) fail("INVALID_MP4", "No free MP4 track ID is available.");
        put32(mvhd, local.payload + (fullBoxVersion(mvhd, local) === 1 ? 108 : 96), nextId);
        parts.push(mvhd);
        continue;
      }
      if (item.type === "pssh") fail("PROTECTED_MP4", "DRM metadata is not supported.");
      parts.push(copy(video.moovBytes, item));
    }
    return makeBox("moov", concat(parts));
  }

  function combinedFtyp(video, audio) {
    const brands = [];
    const seen = new Set();
    for (const ftyp of [video.ftypBytes, audio.ftypBytes]) {
      const box = one(boxList(ftyp), "ftyp");
      if (box.size < 16 || (box.size - 16) % 4) fail("INVALID_MP4", "Invalid MP4 file type box.");
      for (let pos = box.payload + 8; pos < box.end; pos += 4) {
        const name = typeAt(ftyp, pos);
        if (!seen.has(name)) { seen.add(name); brands.push(ftyp.slice(pos, pos + 4)); }
      }
    }
    return makeBox("ftyp", concat([video.ftypBytes.slice(8, 16), ...brands]));
  }

  async function fragments(track, mappedTrackId) {
    const result = [];
    const { top, blob } = track;
    for (let i = 0; i < top.length; i++) {
      const box = top[i];
      if (box.type !== "moof") continue;
      if (box.size > LIMIT_MOOF) fail("MUX_SIZE", "An MP4 fragment header is too large.");
      let nextMoof = i + 1, mdat = null;
      while (nextMoof < top.length && top[nextMoof].type !== "moof") {
        if (top[nextMoof].type === "mdat") {
          if (mdat) fail("UNSUPPORTED_MP4", "Multiple mdat boxes in one fragment are unsupported.");
          mdat = top[nextMoof];
        }
        nextMoof++;
      }
      if (!mdat) fail("INVALID_MP4", "A movie fragment has no media-data box.");
      const moofBytes = new Uint8Array(await blob.slice(box.start, box.end).arrayBuffer());
      const moof = one(boxList(moofBytes), "moof");
      const parts = children(moofBytes, moof);
      scanEncryption(moofBytes, parts);
      const mfhd = one(parts, "mfhd");
      const trafs = parts.filter(x => x.type === "traf");
      if (!trafs.length) fail("INVALID_MP4", "Fragment has no track data.");
      let time = null;
      for (const traf of trafs) {
        const inner = children(moofBytes, traf);
        const tfhd = one(inner, "tfhd"), tfdt = one(inner, "tfdt");
        const flags = fullBoxFlags(moofBytes, tfhd);
        if ((flags & 0x000001) || !(flags & 0x020000)) {
          fail("UNSUPPORTED_OFFSETS", "Fragment does not use relocatable moof-relative addressing.");
        }
        if (u32(moofBytes, tfhd.payload + 4) !== track.trackId) fail("INVALID_MP4", "Fragment track ID differs from initialization segment.");
        const runs = inner.filter(x => x.type === "trun");
        if (!runs.length || !(fullBoxFlags(moofBytes, runs[0]) & 0x000001)) {
          fail("UNSUPPORTED_OFFSETS", "Fragment lacks an explicit media data offset.");
        }
        const offset = new DataView(moofBytes.buffer).getInt32(runs[0].payload + 8);
        const dataStart = mdat.start + mdat.header - box.start;
        if (offset < dataStart || offset >= mdat.end - box.start) {
          fail("UNSUPPORTED_OFFSETS", "Fragment media offset does not point into its mdat box.");
        }
        const decodeTime = uint64Or32(moofBytes, tfdt, 4, 4);
        if (time == null || decodeTime < time) time = decodeTime;
        put32(moofBytes, tfhd.payload + 4, mappedTrackId);
      }
      result.push({ time, timescale: track.timescale, moofBytes,
        rest: blob.slice(box.end, mdat.end), mfhdOffset: mfhd.payload + 4 });
      if (result.length > MAX_FRAGMENTS) fail("TOO_MANY_FRAGMENTS", "Too many MP4 fragments.");
    }
    if (!result.length) fail("INVALID_MP4", "The track contains no movie fragments.");
    return result;
  }

  async function remux(videoBlob, audioBlob) {
    const [video, audio] = await Promise.all([
      inspectTrack(videoBlob, "vide"), inspectTrack(audioBlob, "soun")
    ]);
    const audioId = video.trackId === audio.trackId ? video.trackId + 1 : audio.trackId;
    if (audioId > 0xffffffff) fail("INVALID_MP4", "No free MP4 track ID is available.");
    const moov = combinedMoov(video, audio, audioId);
    const [videoFragments, audioFragments] = await Promise.all([
      fragments(video, video.trackId), fragments(audio, audioId)
    ]);
    const firstVideo = videoFragments.reduce((best, fragment) => fragment.time < best ? fragment.time : best, videoFragments[0].time);
    const firstAudio = audioFragments.reduce((best, fragment) => fragment.time < best ? fragment.time : best, audioFragments[0].time);
    const startDifference = firstVideo * BigInt(audio.timescale) - firstAudio * BigInt(video.timescale);
    const allowedDifference = 2n * BigInt(video.timescale) * BigInt(audio.timescale);
    if (startDifference > allowedDifference || startDifference < -allowedDifference) {
      fail("UNSUPPORTED_TIMELINE", "The audio and video timelines start too far apart for safe remuxing.");
    }
    const all = [...videoFragments, ...audioFragments].sort((a, b) => {
      const left = a.time * BigInt(b.timescale), right = b.time * BigInt(a.timescale);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const output = [combinedFtyp(video, audio), moov];
    for (let i = 0; i < all.length; i++) {
      put32(all[i].moofBytes, all[i].mfhdOffset, i + 1);
      output.push(all[i].moofBytes, all[i].rest);
    }
    return new Blob(output, { type: "video/mp4" });
  }

  const api = { MuxError, remux };
  root.Mp4Mux = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
