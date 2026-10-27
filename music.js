"use strict";

/**
 * !music <title> [artist]
 *
 * Accepted formats:
 *   !music (Blinding Lights) The Weeknd
 *   !music Blinding Lights - The Weeknd
 *   !music Blinding Lights | The Weeknd
 *   !music Blinding Lights by The Weeknd
 *   !music blinding lights the weeknd
 *
 * Source order:
 *   1. SoundCloud  (audio of the track + link)       <- main source
 *   2. Deezer      (30s preview + link)              <- fallback
 *   3. iTunes      (30s preview + link)              <- fallback
 *
 * SoundCloud needs a client_id. Set SOUNDCLOUD_CLIENT_ID (recommended). If it is not set,
 * the bot tries to discover one from soundcloud.com (fragile: it can break whenever
 * SoundCloud changes its site; the fallbacks then take over).
 *
 * Env:
 *   SOUNDCLOUD_CLIENT_ID   your client id
 *   MUSIC_SEND_AUDIO=0     send info + link only (no audio file)
 *   MUSIC_MAX_MB           max audio size to send (default 24, Messenger limit is 25)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_AUDIO_BYTES = Math.max(1, Math.min(25, Number(process.env.MUSIC_MAX_MB || 24))) * 1024 * 1024;
const SEND_AUDIO = String(process.env.MUSIC_SEND_AUDIO || "1") !== "0";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function http(url, { ms = 12_000, json = true, text = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": UA, accept: "*/*" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return text ? await res.text() : json ? await res.json() : res;
  } finally {
    clearTimeout(t);
  }
}

function parseQuery(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  let m = text.match(/^\(([^)]+)\)\s*(.*)$/); // (title) artist
  if (m) return { title: m[1].trim(), artist: m[2].trim() };

  m = text.match(/^(.+?)\s+(?:-|–|—|\||by)\s+(.+)$/i); // title - artist
  if (m) return { title: m[1].trim(), artist: m[2].trim() };

  return { title: text, artist: "" };
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function score(track, q) {
  const title = norm(track.title);
  const artist = norm(track.artist);
  const both = `${title} ${artist}`;
  const wantTitle = norm(q.title);
  const wantArtist = norm(q.artist);
  let s = 0;
  if (title === wantTitle) s += 6;
  else if (title.includes(wantTitle) || wantTitle.includes(title)) s += 3;
  if (wantArtist) {
    if (artist === wantArtist) s += 6;
    else if (artist.includes(wantArtist) || wantArtist.includes(artist)) s += 4;
    else if (both.includes(wantArtist)) s += 3; // SoundCloud often puts the artist in the title
  } else if (both.includes(wantTitle)) s += 1;
  if (/karaoke|tribute|cover|instrumental|8d|nightcore|sped up|slowed|reverb|remix|bass boosted/i.test(`${track.title} ${track.album || ""}`) &&
      !/karaoke|tribute|cover|instrumental|8d|nightcore|sped up|slowed|reverb|remix|bass boosted/i.test(`${q.title} ${q.artist}`)) s -= 5;
  if (track.official) s += 1;
  return s;
}

function pickBest(list, q) {
  const usable = list.filter((t) => t.previewUrl || t.getAudioUrl);
  if (!usable.length) return null;
  return usable.map((t) => ({ t, s: score(t, q) })).sort((a, b) => b.s - a.s)[0].t;
}

// ---------------------------------------------------------------- SoundCloud
let scClientId = process.env.SOUNDCLOUD_CLIENT_ID || null;
let scDiscoveredAt = 0;

async function discoverClientId() {
  if (scClientId && Date.now() - scDiscoveredAt < 6 * 3600e3) return scClientId;
  const html = await http("https://soundcloud.com/", { text: true, json: false });
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]*sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
  for (const src of scripts.slice(0, 8)) {
    try {
      const js = await http(src, { text: true, json: false, ms: 15_000 });
      const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
      if (m) { scClientId = m[1]; scDiscoveredAt = Date.now(); return scClientId; }
    } catch { /* next script */ }
  }
  throw new Error("no soundcloud client_id");
}

async function scGet(buildUrl) {
  let id = await (process.env.SOUNDCLOUD_CLIENT_ID ? Promise.resolve(process.env.SOUNDCLOUD_CLIENT_ID) : discoverClientId());
  try {
    return await http(buildUrl(id));
  } catch (e) {
    // a discovered id may have been revoked: refresh once
    if (!process.env.SOUNDCLOUD_CLIENT_ID && /HTTP (401|403)/.test(String(e.message))) {
      scClientId = null; scDiscoveredAt = 0;
      id = await discoverClientId();
      return await http(buildUrl(id));
    }
    throw e;
  }
}

async function searchSoundcloud(q) {
  const term = `${q.title} ${q.artist}`.trim();
  const data = await scGet((id) =>
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(term)}&limit=20&client_id=${id}`
  );
  return (Array.isArray(data.collection) ? data.collection : [])
    .filter((x) => x && x.streamable !== false && x.media && Array.isArray(x.media.transcodings))
    .map((x) => {
      const prog = x.media.transcodings.find((t) => t.format && t.format.protocol === "progressive");
      return {
        title: x.title,
        artist: (x.publisher_metadata && x.publisher_metadata.artist) || (x.user && x.user.username),
        album: x.publisher_metadata && x.publisher_metadata.album_title,
        durationS: x.full_duration ? Math.round(x.full_duration / 1000) : x.duration ? Math.round(x.duration / 1000) : null,
        link: x.permalink_url,
        source: "SoundCloud",
        snippet: x.policy === "SNIP", // Go+ track: SoundCloud only serves a short snippet
        official: !!(x.user && x.user.verified),
        getAudioUrl: prog
          ? async () => {
              const r = await scGet((id) =>
                `${prog.url}${prog.url.includes("?") ? "&" : "?"}client_id=${id}` +
                  (x.track_authorization ? `&track_authorization=${x.track_authorization}` : "")
              );
              if (!r || !r.url) throw new Error("no stream url");
              return r.url;
            }
          : null,
      };
    })
    .filter((t) => t.getAudioUrl);
}

// -------------------------------------------------------------------- Deezer / iTunes
async function searchDeezer(q) {
  const query = q.artist ? `artist:"${q.artist}" track:"${q.title}"` : q.title;
  let data = await http(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(query)}`);
  let items = Array.isArray(data.data) ? data.data : [];
  if (!items.length && q.artist) {
    data = await http(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(`${q.title} ${q.artist}`)}`);
    items = Array.isArray(data.data) ? data.data : [];
  }
  return items.map((x) => ({
    title: x.title,
    artist: x.artist && x.artist.name,
    album: x.album && x.album.title,
    durationS: x.duration,
    previewUrl: x.preview,
    link: x.link,
    source: "Deezer",
    preview: true,
  }));
}

async function searchItunes(q) {
  const term = `${q.title} ${q.artist}`.trim();
  const data = await http(
    `https://itunes.apple.com/search?media=music&entity=song&limit=15&term=${encodeURIComponent(term)}`
  );
  return (Array.isArray(data.results) ? data.results : []).map((x) => ({
    title: x.trackName,
    artist: x.artistName,
    album: x.collectionName,
    durationS: x.trackTimeMillis ? Math.round(x.trackTimeMillis / 1000) : null,
    previewUrl: x.previewUrl,
    link: x.trackViewUrl,
    source: "Apple Music",
    preview: true,
  }));
}

async function findTrack(q) {
  for (const search of [searchSoundcloud, searchDeezer, searchItunes]) {
    try {
      const best = pickBest(await search(q), q);
      if (best) return best;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

// -------------------------------------------------------------------- download
async function downloadAudio(url, ms = 60_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": UA } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (declared && declared > MAX_AUDIO_BYTES) throw new Error("too big");
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_AUDIO_BYTES) throw new Error("bad audio size");
    const ext = /\.m4a(\?|$)/i.test(url) ? "m4a" : "mp3";
    const file = path.join(os.tmpdir(), `music-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  } finally {
    clearTimeout(t);
  }
}

const fmtTime = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : null);

/** @returns {Promise<string | {body, attachment, cleanup}>} */
async function musicCommand(rawArgs, prefix = "!") {
  const q = parseQuery(rawArgs);
  if (!q) return `Format: ${prefix}music (title) artist\nHal: ${prefix}music (Blinding Lights) The Weeknd`;

  const track = await findTrack(q);
  if (!track) return `Walang nahanap para sa "${[q.title, q.artist].filter(Boolean).join(" - ")}" 😅 Subukan mong i-check ang spelling o dagdagan ng artist.`;

  const note = track.preview ? `(30s preview via ${track.source})` : track.snippet ? `(snippet lang · via ${track.source})` : `via ${track.source}`;
  const lines = [
    `🎵 ${track.title}`,
    `👤 ${track.artist || "Unknown artist"}`,
    track.album ? `💿 ${track.album}` : null,
    fmtTime(track.durationS) ? `⏱ ${fmtTime(track.durationS)}` : null,
    track.link ? `🔗 ${track.link}` : null,
    note,
  ].filter(Boolean);
  const body = lines.join("\n");

  if (!SEND_AUDIO) return body;

  let file = null;
  try {
    const url = track.previewUrl || (await track.getAudioUrl());
    file = await downloadAudio(url);
  } catch (e) {
    const why = /too big|bad audio size/.test(String(e && e.message)) ? "Masyadong malaki ang audio para sa Messenger" : "Hindi ma-download ang audio ngayon";
    return `${body}\n⚠️ ${why}, i-click na lang ang link.`;
  }

  const stream = fs.createReadStream(file);
  stream.on("error", () => {}); // e.g. file removed before it was read; never crash the bot over a track

  return {
    body,
    attachment: stream,
    cleanup: () => {
      try { stream.destroy(); } catch {}
      fs.unlink(file, () => {});
    },
  };
}

module.exports = { musicCommand, parseQuery };
