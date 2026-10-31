"use strict";

/**
 * Moderation commands (GoatBot-style): kick, ban, unban, banlist, warn, warns, unwarn, unsend, mods.
 *
 * Who can use them: the bot admins/owner, or any admin of the GC itself.
 * The bot account must be an ADMIN of the GC for kick/ban to actually remove people.
 * Saved in moderation.json (inside DATA_DIR): bans + warns per GC. Banned people are
 * re-kicked automatically if somebody adds them back, and their commands are ignored.
 */

const fs = require("fs");
const path = require("path");
const { getNames, targetOf } = require("./economy");

const MAX_WARNS = 3;

let FILE = null;
let db = { bans: {}, warns: {} };
let timer = null;
let logFn = () => {};
let isAdminId = () => false;
let isOwnerId = () => false;

function init(dataDir, log, hooks = {}) {
  FILE = path.join(dataDir, "moderation.json");
  if (typeof log === "function") logFn = log;
  if (typeof hooks.isAdminId === "function") isAdminId = hooks.isAdminId;
  if (typeof hooks.isOwnerId === "function") isOwnerId = hooks.isOwnerId;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") db = { bans: raw.bans || {}, warns: raw.warns || {} };
  } catch { /* first run */ }
}
function flush() {
  clearTimeout(timer); timer = null;
  if (!FILE) return;
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { logFn("error", "moderation save: " + (e.message || e)); }
}
function dirty() {
  if (timer) return;
  timer = setTimeout(flush, 1500);
  if (timer.unref) timer.unref();
}

const bansOf = (tid) => (db.bans[String(tid)] = db.bans[String(tid)] || {});
const warnsOf = (tid) => (db.warns[String(tid)] = db.warns[String(tid)] || {});
const isBanned = (tid, uid) => !!(db.bans[String(tid)] && db.bans[String(tid)][String(uid)]);

// ---------------------------------------------------------------- Messenger helpers
const adminCache = new Map(); // threadID -> { at, ids:Set }

function threadAdmins(api, tid) {
  const hit = adminCache.get(String(tid));
  if (hit && Date.now() - hit.at < 60e3) return Promise.resolve(hit.ids);
  return new Promise((resolve) => {
    if (!api || typeof api.getThreadInfo !== "function") return resolve(new Set());
    const guard = setTimeout(() => resolve(new Set()), 7000);
    try {
      api.getThreadInfo(tid, (err, info) => {
        clearTimeout(guard);
        if (err || !info) return resolve(new Set());
        const ids = new Set((info.adminIDs || []).map((a) => String(a && a.id ? a.id : a)));
        adminCache.set(String(tid), { at: Date.now(), ids });
        resolve(ids);
      });
    } catch { clearTimeout(guard); resolve(new Set()); }
  });
}

function removeUser(api, tid, uid) {
  return new Promise((resolve) => {
    if (!api || typeof api.removeUserFromGroup !== "function") return resolve(false);
    const guard = setTimeout(() => resolve(false), 10_000);
    try {
      api.removeUserFromGroup(String(uid), String(tid), (err) => { clearTimeout(guard); resolve(!err); });
    } catch { clearTimeout(guard); resolve(false); }
  });
}

async function canMod({ ev, S, isAdmin }) {
  if (isAdmin) return true;
  return (await threadAdmins(S.api, ev.threadID)).has(String(ev.senderID));
}

const isProtected = (S, uid) => String(uid) === S.uid || isAdminId(uid) || isOwnerId(uid);
const nameOf = async (S, id) => (await getNames(S.api, [id]))[id] || `User ${String(id).slice(-4)}`;

/** Common guard: GC only + moderator only + a target. Returns { err } or { t }. */
async function guard(ctx, usage) {
  const { ev, args, S } = ctx;
  if (ev.isGroup === false) return { err: "Sa group chat lang ito 😅" };
  if (!(await canMod(ctx))) return { err: "Admin lang ng GC (o ng bot) ang puwede nito 🔒" };
  const t = targetOf(ev, args);
  if (!t) return { err: usage };
  if (isProtected(S, t.id)) return { err: "Hindi puwede sa bot/owner/admin ng bot 🛡" };
  return { t };
}

const NOT_ADMIN_NOTE = "Hindi ko ma-kick. Siguraduhing admin ang bot account sa GC na ito.";

// ---------------------------------------------------------------- commands
const commands = {
  kick: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}kick @tao (o i-reply sa mensahe nila)`);
      if (g.err) return g.err;
      const name = await nameOf(ctx.S, g.t.id);
      const ok = await removeUser(ctx.S.api, ctx.ev.threadID, g.t.id);
      return ok ? `👢 Na-kick si ${name}.` : `⚠️ ${NOT_ADMIN_NOTE}`;
    },
  },

  ban: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}ban @tao [dahilan]`);
      if (g.err) return g.err;
      const { ev, S } = ctx;
      const name = await nameOf(S, g.t.id);
      const reason = g.t.rest.replace(/\s+/g, " ").trim().slice(0, 120);
      bansOf(ev.threadID)[g.t.id] = { at: Date.now(), by: String(ev.senderID), reason, name };
      delete warnsOf(ev.threadID)[g.t.id];
      dirty();
      const ok = await removeUser(S.api, ev.threadID, g.t.id);
      return `🚫 Banned si ${name}${reason ? ` — ${reason}` : ""}.\n${ok ? "Na-kick na rin." : `⚠️ ${NOT_ADMIN_NOTE} (Naka-ban pa rin: ikikick ulit kapag nag-join.)`}`;
    },
  },

  unban: {
    run: async (ctx) => {
      const { ev, args, prefix, S } = ctx;
      if (ev.isGroup === false) return "Sa group chat lang ito 😅";
      if (!(await canMod(ctx))) return "Admin lang ng GC (o ng bot) ang puwede nito 🔒";
      const list = Object.keys(bansOf(ev.threadID));
      let id = null;
      const idx = /^\d{1,3}$/.exec(String(args || "").trim());
      if (idx) id = list[Number(idx[0]) - 1] || null;
      else { const t = targetOf(ev, args); id = t && t.id; }
      if (!id) return `Format: ${prefix}unban <# sa ${prefix}banlist> (o @tao / ID)`;
      if (!isBanned(ev.threadID, id)) return "Hindi siya naka-ban sa GC na ito.";
      const name = (db.bans[String(ev.threadID)][id] || {}).name || (await nameOf(S, id));
      delete db.bans[String(ev.threadID)][id]; dirty();
      return `✅ Unbanned si ${name}. Puwede na siyang i-add ulit.`;
    },
  },

  banlist: {
    run: async ({ ev }) => {
      const entries = Object.entries(bansOf(ev.threadID));
      if (!entries.length) return "✅ Walang naka-ban sa GC na ito.";
      return "🚫 Banlist\n" + entries.map(([id, b], i) => `${i + 1}. ${b.name || id}${b.reason ? ` — ${b.reason}` : ""}`).join("\n");
    },
  },

  warn: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}warn @tao [dahilan]`);
      if (g.err) return g.err;
      const { ev, S } = ctx;
      const name = await nameOf(S, g.t.id);
      const reason = g.t.rest.replace(/\s+/g, " ").trim().slice(0, 120);
      const w = (warnsOf(ev.threadID)[g.t.id] = warnsOf(ev.threadID)[g.t.id] || []);
      w.push({ at: Date.now(), by: String(ev.senderID), reason });
      dirty();
      if (w.length >= MAX_WARNS) {
        delete warnsOf(ev.threadID)[g.t.id]; dirty();
        const ok = await removeUser(S.api, ev.threadID, g.t.id);
        return `⚠️ ${name}: warning ${MAX_WARNS}/${MAX_WARNS}${reason ? ` — ${reason}` : ""}\n${ok ? "👢 Na-kick dahil umabot na sa limit." : `⚠️ ${NOT_ADMIN_NOTE}`}`;
      }
      return `⚠️ Warning kay ${name}: ${w.length}/${MAX_WARNS}${reason ? ` — ${reason}` : ""}\n(${MAX_WARNS} warnings = kick)`;
    },
  },

  warns: {
    run: async ({ ev, args, S }) => {
      const t = args ? targetOf(ev, args) : null;
      const id = t ? t.id : String(ev.senderID);
      const w = warnsOf(ev.threadID)[id] || [];
      const name = t ? await nameOf(S, id) : "Ikaw";
      if (!w.length) return `✅ ${name}: walang warning.`;
      return `⚠️ ${name}: ${w.length}/${MAX_WARNS} warnings\n` + w.map((x, i) => `${i + 1}. ${x.reason || "walang dahilan"}`).join("\n");
    },
  },
  warnlist: { alias: "warns" },

  unwarn: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}unwarn @tao [all]`);
      if (g.err) return g.err;
      const { ev, S } = ctx;
      const w = warnsOf(ev.threadID)[g.t.id] || [];
      const name = await nameOf(S, g.t.id);
      if (!w.length) return `✅ ${name}: walang warning.`;
      if (/\ball\b/i.test(g.t.rest)) { delete warnsOf(ev.threadID)[g.t.id]; dirty(); return `✅ Na-clear lahat ng warning ni ${name}.`; }
      w.pop(); if (!w.length) delete warnsOf(ev.threadID)[g.t.id]; dirty();
      return `✅ Tinanggal ang huling warning ni ${name} (${w.length}/${MAX_WARNS}).`;
    },
  },

  unsend: {
    run: async (ctx) => {
      const { ev, S, prefix } = ctx;
      if (!(await canMod(ctx))) return "Admin lang ng GC (o ng bot) ang puwede nito 🔒";
      const r = ev.messageReply;
      if (!r || !r.messageID || String(r.senderID) !== S.uid) return `I-reply ang ${prefix}unsend sa mensahe ng bot na gusto mong burahin.`;
      const ok = await new Promise((resolve) => {
        try { S.api.unsendMessage(r.messageID, (err) => resolve(!err)); } catch { resolve(false); }
      });
      return ok ? null : "Hindi ko ma-unsend 😭";
    },
  },

  mods: {
    run: async ({ ev, S }) => {
      if (ev.isGroup === false) return "Sa group chat lang ito 😅";
      const ids = [...(await threadAdmins(S.api, ev.threadID))];
      if (!ids.length) return "Hindi ko makuha ang admin list ng GC na ito.";
      const names = await getNames(S.api, ids);
      return "🛡 Admins ng GC\n" + ids.map((id, i) => `${i + 1}. ${names[id] || id}${id === S.uid ? " (bot)" : ""}`).join("\n");
    },
  },
};

// ---------------------------------------------------------------- event hook (someone added a banned person back)
async function onEvent(api, ev, { S, isTarget }) {
  if (!api || !ev || ev.type !== "event" || ev.logMessageType !== "log:subscribe") return;
  if (isTarget && !isTarget(ev)) return;
  const added = (ev.logMessageData && ev.logMessageData.addedParticipants) || [];
  for (const p of added) {
    const uid = String(p.userFbId || p.userId || "");
    if (!uid || uid === S.uid || !isBanned(ev.threadID, uid)) continue;
    const ok = await removeUser(api, ev.threadID, uid);
    logFn("mod", `banned ${uid} re-added to ${ev.threadID}: ${ok ? "kicked" : "kick failed"}`);
    if (ok) { try { api.sendMessage("🚫 Naka-ban ang taong iyon sa GC na ito kaya na-kick ulit.", ev.threadID); } catch {} }
  }
}

module.exports = { init, flush, commands, onEvent, isBanned };
"use strict";

/**
 * Moderation commands (GoatBot-style): kick, ban, unban, banlist, warn, warns, unwarn, unsend, mods.
 *
 * Who can use them: the bot admins/owner, or any admin of the GC itself.
 * The bot account must be an ADMIN of the GC for kick/ban to actually remove people.
 * Saved in moderation.json (inside DATA_DIR): bans + warns per GC. Banned people are
 * re-kicked automatically if somebody adds them back, and their commands are ignored.
 */

const fs = require("fs");
const path = require("path");
const { getNames, targetOf } = require("./economy");

const MAX_WARNS = 3;

let FILE = null;
let db = { bans: {}, warns: {} };
let timer = null;
let logFn = () => {};
let isAdminId = () => false;
let isOwnerId = () => false;

function init(dataDir, log, hooks = {}) {
  FILE = path.join(dataDir, "moderation.json");
  if (typeof log === "function") logFn = log;
  if (typeof hooks.isAdminId === "function") isAdminId = hooks.isAdminId;
  if (typeof hooks.isOwnerId === "function") isOwnerId = hooks.isOwnerId;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") db = { bans: raw.bans || {}, warns: raw.warns || {} };
  } catch { /* first run */ }
}
function flush() {
  clearTimeout(timer); timer = null;
  if (!FILE) return;
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { logFn("error", "moderation save: " + (e.message || e)); }
}
function dirty() {
  if (timer) return;
  timer = setTimeout(flush, 1500);
  if (timer.unref) timer.unref();
}

const bansOf = (tid) => (db.bans[String(tid)] = db.bans[String(tid)] || {});
const warnsOf = (tid) => (db.warns[String(tid)] = db.warns[String(tid)] || {});
const isBanned = (tid, uid) => !!(db.bans[String(tid)] && db.bans[String(tid)][String(uid)]);

// ---------------------------------------------------------------- Messenger helpers
const adminCache = new Map(); // threadID -> { at, ids:Set }

function threadAdmins(api, tid) {
  const hit = adminCache.get(String(tid));
  if (hit && Date.now() - hit.at < 60e3) return Promise.resolve(hit.ids);
  return new Promise((resolve) => {
    if (!api || typeof api.getThreadInfo !== "function") return resolve(new Set());
    const guard = setTimeout(() => resolve(new Set()), 7000);
    try {
      api.getThreadInfo(tid, (err, info) => {
        clearTimeout(guard);
        if (err || !info) return resolve(new Set());
        const ids = new Set((info.adminIDs || []).map((a) => String(a && a.id ? a.id : a)));
        adminCache.set(String(tid), { at: Date.now(), ids });
        resolve(ids);
      });
    } catch { clearTimeout(guard); resolve(new Set()); }
  });
}

function removeUser(api, tid, uid) {
  return new Promise((resolve) => {
    if (!api || typeof api.removeUserFromGroup !== "function") return resolve(false);
    const guard = setTimeout(() => resolve(false), 10_000);
    try {
      api.removeUserFromGroup(String(uid), String(tid), (err) => { clearTimeout(guard); resolve(!err); });
    } catch { clearTimeout(guard); resolve(false); }
  });
}

async function canMod({ ev, S, isAdmin }) {
  if (isAdmin) return true;
  return (await threadAdmins(S.api, ev.threadID)).has(String(ev.senderID));
}

const isProtected = (S, uid) => String(uid) === S.uid || isAdminId(uid) || isOwnerId(uid);
const nameOf = async (S, id) => (await getNames(S.api, [id]))[id] || `User ${String(id).slice(-4)}`;

/** Common guard: GC only + moderator only + a target. Returns { err } or { t }. */
async function guard(ctx, usage) {
  const { ev, args, S } = ctx;
  if (ev.isGroup === false) return { err: "Sa group chat lang ito 😅" };
  if (!(await canMod(ctx))) return { err: "Admin lang ng GC (o ng bot) ang puwede nito 🔒" };
  const t = targetOf(ev, args);
  if (!t) return { err: usage };
  if (isProtected(S, t.id)) return { err: "Hindi puwede sa bot/owner/admin ng bot 🛡" };
  return { t };
}

const NOT_ADMIN_NOTE = "Hindi ko ma-kick. Siguraduhing admin ang bot account sa GC na ito.";

// ---------------------------------------------------------------- commands
const commands = {
  kick: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}kick @tao (o i-reply sa mensahe nila)`);
      if (g.err) return g.err;
      const name = await nameOf(ctx.S, g.t.id);
      const ok = await removeUser(ctx.S.api, ctx.ev.threadID, g.t.id);
      return ok ? `👢 Na-kick si ${name}.` : `⚠️ ${NOT_ADMIN_NOTE}`;
    },
  },

  ban: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}ban @tao [dahilan]`);
      if (g.err) return g.err;
      const { ev, S } = ctx;
      const name = await nameOf(S, g.t.id);
      const reason = g.t.rest.replace(/\s+/g, " ").trim().slice(0, 120);
      bansOf(ev.threadID)[g.t.id] = { at: Date.now(), by: String(ev.senderID), reason, name };
      delete warnsOf(ev.threadID)[g.t.id];
      dirty();
      const ok = await removeUser(S.api, ev.threadID, g.t.id);
      return `🚫 Banned si ${name}${reason ? ` — ${reason}` : ""}.\n${ok ? "Na-kick na rin." : `⚠️ ${NOT_ADMIN_NOTE} (Naka-ban pa rin: ikikick ulit kapag nag-join.)`}`;
    },
  },

  unban: {
    run: async (ctx) => {
      const { ev, args, prefix, S } = ctx;
      if (ev.isGroup === false) return "Sa group chat lang ito 😅";
      if (!(await canMod(ctx))) return "Admin lang ng GC (o ng bot) ang puwede nito 🔒";
      const list = Object.keys(bansOf(ev.threadID));
      let id = null;
      const idx = /^\d{1,3}$/.exec(String(args || "").trim());
      if (idx) id = list[Number(idx[0]) - 1] || null;
      else { const t = targetOf(ev, args); id = t && t.id; }
      if (!id) return `Format: ${prefix}unban <# sa ${prefix}banlist> (o @tao / ID)`;
      if (!isBanned(ev.threadID, id)) return "Hindi siya naka-ban sa GC na ito.";
      const name = (db.bans[String(ev.threadID)][id] || {}).name || (await nameOf(S, id));
      delete db.bans[String(ev.threadID)][id]; dirty();
      return `✅ Unbanned si ${name}. Puwede na siyang i-add ulit.`;
    },
  },

  banlist: {
    run: async ({ ev }) => {
      const entries = Object.entries(bansOf(ev.threadID));
      if (!entries.length) return "✅ Walang naka-ban sa GC na ito.";
      return "🚫 Banlist\n" + entries.map(([id, b], i) => `${i + 1}. ${b.name || id}${b.reason ? ` — ${b.reason}` : ""}`).join("\n");
    },
  },

  warn: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}warn @tao [dahilan]`);
      if (g.err) return g.err;
      const { ev, S } = ctx;
      const name = await nameOf(S, g.t.id);
      const reason = g.t.rest.replace(/\s+/g, " ").trim().slice(0, 120);
      const w = (warnsOf(ev.threadID)[g.t.id] = warnsOf(ev.threadID)[g.t.id] || []);
      w.push({ at: Date.now(), by: String(ev.senderID), reason });
      dirty();
      if (w.length >= MAX_WARNS) {
        delete warnsOf(ev.threadID)[g.t.id]; dirty();
        const ok = await removeUser(S.api, ev.threadID, g.t.id);
        return `⚠️ ${name}: warning ${MAX_WARNS}/${MAX_WARNS}${reason ? ` — ${reason}` : ""}\n${ok ? "👢 Na-kick dahil umabot na sa limit." : `⚠️ ${NOT_ADMIN_NOTE}`}`;
      }
      return `⚠️ Warning kay ${name}: ${w.length}/${MAX_WARNS}${reason ? ` — ${reason}` : ""}\n(${MAX_WARNS} warnings = kick)`;
    },
  },

  warns: {
    run: async ({ ev, args, S }) => {
      const t = args ? targetOf(ev, args) : null;
      const id = t ? t.id : String(ev.senderID);
      const w = warnsOf(ev.threadID)[id] || [];
      const name = t ? await nameOf(S, id) : "Ikaw";
      if (!w.length) return `✅ ${name}: walang warning.`;
      return `⚠️ ${name}: ${w.length}/${MAX_WARNS} warnings\n` + w.map((x, i) => `${i + 1}. ${x.reason || "walang dahilan"}`).join("\n");
    },
  },
  warnlist: { alias: "warns" },

  unwarn: {
    run: async (ctx) => {
      const g = await guard(ctx, `Format: ${ctx.prefix}unwarn @tao [all]`);
      if (g.err) return g.err;
      const { ev, S } = ctx;
      const w = warnsOf(ev.threadID)[g.t.id] || [];
      const name = await nameOf(S, g.t.id);
      if (!w.length) return `✅ ${name}: walang warning.`;
      if (/\ball\b/i.test(g.t.rest)) { delete warnsOf(ev.threadID)[g.t.id]; dirty(); return `✅ Na-clear lahat ng warning ni ${name}.`; }
      w.pop(); if (!w.length) delete warnsOf(ev.threadID)[g.t.id]; dirty();
      return `✅ Tinanggal ang huling warning ni ${name} (${w.length}/${MAX_WARNS}).`;
    },
  },

  unsend: {
    run: async (ctx) => {
      const { ev, S, prefix } = ctx;
      if (!(await canMod(ctx))) return "Admin lang ng GC (o ng bot) ang puwede nito 🔒";
      const r = ev.messageReply;
      if (!r || !r.messageID || String(r.senderID) !== S.uid) return `I-reply ang ${prefix}unsend sa mensahe ng bot na gusto mong burahin.`;
      const ok = await new Promise((resolve) => {
        try { S.api.unsendMessage(r.messageID, (err) => resolve(!err)); } catch { resolve(false); }
      });
      return ok ? null : "Hindi ko ma-unsend 😭";
    },
  },

  mods: {
    run: async ({ ev, S }) => {
      if (ev.isGroup === false) return "Sa group chat lang ito 😅";
      const ids = [...(await threadAdmins(S.api, ev.threadID))];
      if (!ids.length) return "Hindi ko makuha ang admin list ng GC na ito.";
      const names = await getNames(S.api, ids);
      return "🛡 Admins ng GC\n" + ids.map((id, i) => `${i + 1}. ${names[id] || id}${id === S.uid ? " (bot)" : ""}`).join("\n");
    },
  },
};

// ---------------------------------------------------------------- event hook (someone added a banned person back)
async function onEvent(api, ev, { S, isTarget }) {
  if (!api || !ev || ev.type !== "event" || ev.logMessageType !== "log:subscribe") return;
  if (isTarget && !isTarget(ev)) return;
  const added = (ev.logMessageData && ev.logMessageData.addedParticipants) || [];
  for (const p of added) {
    const uid = String(p.userFbId || p.userId || "");
    if (!uid || uid === S.uid || !isBanned(ev.threadID, uid)) continue;
    const ok = await removeUser(api, ev.threadID, uid);
    logFn("mod", `banned ${uid} re-added to ${ev.threadID}: ${ok ? "kicked" : "kick failed"}`);
    if (ok) { try { api.sendMessage("🚫 Naka-ban ang taong iyon sa GC na ito kaya na-kick ulit.", ev.threadID); } catch {} }
  }
}

module.exports = { init, flush, commands, onEvent, isBanned };
