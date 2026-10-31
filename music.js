"use strict";

/**
 * !m <title> by <artist>      (also: !music, !song)
 *
 * Single source: SoundCloud -> sends the FULL song (audio file) + link.
 * Strict matching: if the title/artist does not match for sure, NOTHING is sent
 * ("walang nahanap") instead of sending a wrong song.
 *
 * Accepted formats:
 *   !m Blinding Lights by The Weeknd
 *   !music (Blinding Lights) The Weeknd
 *   !music Blinding Lights - The Weeknd
 *   !music Blinding Lights | The Weeknd
 *   !music Blinding Lights            (title only: exact title match required)
 *
 * SoundCloud needs a client_id. Set SOUNDCLOUD_CLIENT_ID (recommended). If it is not set,
 * the bot tries to discover one from soundcloud.com (fragile: can break when SoundCloud changes its site).
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
const MIN_FULL_S = 60;        // shorter than this = snippet/preview, never a full song
const MAX_FULL_S = 12 * 60;   // longer than this = mix/podcast, not the song
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

  m = text.match(/^(.+?)\s+(?:-|–|—|\|)\s+(.+)$/); // title - artist
  if (m) return { title: m[1].trim(), artist: m[2].trim() };

  // title by artist: split at the LAST " by " so "Stand By Me by Ben E. King" works
  m = text.match(/^(.+)\s+by\s+(.+)$/i);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };

  return { title: text, artist: "" };
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const padded = (s) => ` ${norm(s)} `;
const hasPhrase = (hay, needle) => !!norm(needle) && padded(hay).includes(padded(needle));

// words that do not change which song it is
const NOISE = new Set(["official", "audio", "video", "music", "lyrics", "lyric", "hd", "hq", "full", "song", "version", "visualizer", "mv", "m", "v", "feat", "ft", "featuring", "prod", "the", "a", "and", "of"]);
// words that mean it is a DIFFERENT version of the song
const VERSION_RE = /\b(karaoke|tribute|cover|instrumental|acoustic|8d|nightcore|sped up|speed up|slowed|reverb|remix|mashup|bass boosted|live|demo|piano version|loop|extended|rework|bootleg|edit|flip|vip|lofi|lo fi|type beat|reaction|parody|preview|snippet|teaser|clip)\b/i;

/**
 * Strict check. Returns a score (> 0) if this track is surely the requested song, otherwise 0.
 */
function matchScore(t, q) {
  const wantTitle = norm(q.title);
  const wantArtist = norm(q.artist);
  if (!wantTitle) return 0;

  const title = norm(t.title);
  const artist = norm(t.artist);
  const uploader = norm(t.uploader);
  const hay = `${title} ${artist} ${uploader}`;

  // 1. title must appear as whole words in the track title
  if (!hasPhrase(title, wantTitle)) return 0;

  // 2. artist (if given) must appear in title / artist / uploader as whole words
  if (wantArtist && !hasPhrase(hay, wantArtist)) return 0;

  // 3. no remix / cover / live / karaoke... unless the user asked for it
  if (VERSION_RE.test(`${t.title} ${t.album || ""}`) && !VERSION_RE.test(`${q.title} ${q.artist}`)) return 0;

  // 4. duration must look like a full song
  if (t.snippet) return 0;
  if (Number.isFinite(t.durationS) && (t.durationS < MIN_FULL_S || t.durationS > MAX_FULL_S)) return 0;

  // 5. what is left of the track title (besides title / artist / noise) must be small:
  //    "Blinding Lights (Official Audio)" ok, "Blinding Lights Mix by DJ Something" not
  const known = new Set([...wantTitle.split(" "), ...wantArtist.split(" "), ...artist.split(" "), ...uploader.split(" ")]);
  const extra = title.split(" ").filter((w) => w && !known.has(w) && !NOISE.has(w));
  if (extra.length > 2) return 0;

  // title-only query: require the title to be (almost) exactly the song title
  if (!wantArtist && extra.length > 0) return 0;

  let s = 10;
  if (title === wantTitle) s += 6;
  else if (title === `${wantArtist} ${wantTitle}` || title === `${wantTitle} ${wantArtist}`) s += 6;
  if (wantArtist && artist === wantArtist) s += 4;
  if (t.official) s += 4;
  if (t.hasProgressive) s += 3;              // can be sent as an audio file
  s += Math.min(3, Math.log10((t.plays || 0) + 1) / 2);   // popular upload wins ties
  s -= extra.length * 0.5;
  return s;
}

function pickBest(list, q) {
  const ranked = list.map((t) => ({ t, s: matchScore(t, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return ranked.length ? ranked[0].t : null;
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

async function searchSoundcloudTerm(term) {
  const data = await scGet((id) =>
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(term)}&limit=30&client_id=${id}`
  );
  return (Array.isArray(data.collection) ? data.collection : [])
    .filter((x) => x && x.streamable !== false && x.media && Array.isArray(x.media.transcodings))
    .map((x) => {
      const prog = x.media.transcodings.find((t) => t.format && t.format.protocol === "progressive");
      const ms = x.full_duration || x.duration;
      return {
        title: x.title,
        artist: (x.publisher_metadata && x.publisher_metadata.artist) || (x.user && x.user.username),
        uploader: x.user && x.user.username,
        album: x.publisher_metadata && x.publisher_metadata.album_title,
        durationS: ms ? Math.round(ms / 1000) : null,
        link: x.permalink_url,
        source: "SoundCloud",
        snippet: x.policy === "SNIP",            // Go+ track: SoundCloud only serves a short snippet
        official: !!(x.user && x.user.verified),
        plays: x.playback_count || 0,
        hasProgressive: !!prog,
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
    });
}

/** Only source: SoundCloud. Tries "title artist" first, then title alone (artist is often just the uploader name). */
async function findTrack(q) {
  const terms = [`${q.title} ${q.artist}`.trim()];
  if (q.artist) terms.push(q.title);
  for (const term of terms) {
    const best = pickBest(await searchSoundcloudTerm(term), q);
    if (best) return best;
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
  if (!q) return `Format: ${prefix}m [title] by [artist]\nHal: ${prefix}m Blinding Lights by The Weeknd`;

  let track = null;
  try {
    track = await findTrack(q);
    if (!track && q.artist) {
      // the split may have been wrong (e.g. "Stand by Me"): retry with the whole text as the title
      track = await findTrack({ title: String(rawArgs).trim(), artist: "" });
    }
  } catch {
    return "Hindi ma-reach ang SoundCloud ngayon 😭 subukan ulit mamaya.";
  }
  if (!track) {
    return `Walang eksaktong nahanap para sa "${[q.title, q.artist].filter(Boolean).join(" by ")}" 😅\nPara hindi ako magpadala ng maling kanta, wala akong isinend. I-check ang spelling o ilagay ang artist: ${prefix}m [title] by [artist]`;
  }

  const lines = [
    `🎵 ${track.title}`,
    `👤 ${track.artist || "Unknown artist"}`,
    track.album ? `💿 ${track.album}` : null,
    fmtTime(track.durationS) ? `⏱ ${fmtTime(track.durationS)}` : null,
    track.link ? `🔗 ${track.link}` : null,
  ].filter(Boolean);
  const body = lines.join("\n");

  if (!SEND_AUDIO) return body;
  if (!track.getAudioUrl) return `${body}\n⚠️ Hindi maibigay ng SoundCloud ang audio file nito, i-click na lang ang link.`;

  let file = null;
  try {
    file = await downloadAudio(await track.getAudioUrl());
  } catch (e) {
    const why = /too big|bad audio size/.test(String(e && e.message)) ? "Masyadong malaki ang audio para sa Messenger" : "Hindi ma-download ang audio ngayon";
    return `${body}\n⚠️ ${why}, i-click na lang ang link.`;
  }

  const stream = fs.createReadStream(file);
  stream.on("error", () => {}); // never crash the bot over a track

  return {
    body,
    attachment: stream,
    cleanup: () => {
      try { stream.destroy(); } catch {}
      fs.unlink(file, () => {});
    },
  };
}

module.exports = { musicCommand, parseQuery, matchScore, pickBest };
