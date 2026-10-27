"use strict";

/**
 * Virtual economy: currency (coins), bank, shop.
 *
 * Saved in economy.json (inside DATA_DIR) so balances survive restarts/redeploys
 * (put DATA_DIR on a Railway Volume). Writes are atomic and debounced.
 *
 * Commands exported in `commands` are merged into commands.js.
 */

const fs = require("fs");
const path = require("path");

const COIN = "🪙";
const BASE_BANK = 5000;
const VAULT_BONUS = 10_000;
const DAILY_BASE = 500;
const DAILY_STREAK = 50;
const DAILY_MAX_STREAK = 30;
const DAILY_COOLDOWN = 20 * 3600e3;
const STREAK_BREAK = 48 * 3600e3;
const WORK_COOLDOWN = 30 * 60e3;
const BET_MAX = 10_000;
const BET_WIN = 0.45;
const SELL_RATE = 0.5;

const ITEMS = {
  charm: { emoji: "🍀", name: "Lucky Charm", price: 2500, max: 5, desc: "+10% sa !work at !daily (max 5)" },
  vault: { emoji: "🏦", name: "Bank Vault", price: 5000, max: 20, desc: `+${VAULT_BONUS.toLocaleString("en-US")} bank limit` },
  phone: { emoji: "📱", name: "Cellphone", price: 8000, desc: "Pang-flex lang" },
  jeep: { emoji: "🚙", name: "Jeep", price: 15000, desc: "Pang-flex lang" },
  house: { emoji: "🏠", name: "Bahay", price: 100_000, desc: "Pang-flex lang" },
  crown: { emoji: "👑", name: "Korona", price: 500_000, desc: "Pinaka-flex" },
};
const ITEM_KEYS = Object.keys(ITEMS);

const JOBS = [
  "nag-deliver ka ng pagkain", "nag-tutor ka ng grade school", "naging tindero ka sa sari-sari store",
  "nag-edit ka ng video", "nag-ayos ka ng cellphone", "nag-drive ka ng jeep", "nag-freelance ka bilang designer",
  "nagbenta ka ng fishball", "nag-barista ka buong araw", "nag-repair ka ng aircon",
];

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => `${COIN} ${fmt(n)}`;

// ---------------------------------------------------------------- store
let FILE = null;
let db = { users: {} };
let timer = null;
let logFn = () => {};

function init(dataDir, log) {
  FILE = path.join(dataDir, "economy.json");
  if (typeof log === "function") logFn = log;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object" && raw.users) db = raw;
  } catch { /* first run */ }
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!FILE) return;
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { logFn("error", "economy save: " + (e.message || e)); }
}
function dirty() {
  if (timer) return;
  timer = setTimeout(flush, 2000);
  if (timer.unref) timer.unref();
}

function user(id) {
  const key = String(id);
  if (!db.users[key]) db.users[key] = { wallet: 0, bank: 0, inv: {}, lastDaily: 0, streak: 0, lastWork: 0 };
  return db.users[key];
}
const items = (u, k) => Number((u.inv && u.inv[k]) || 0);
const bankCap = (u) => BASE_BANK + VAULT_BONUS * items(u, "vault");
const boost = (u) => 1 + 0.1 * items(u, "charm");
const total = (u) => u.wallet + u.bank;

// ---------------------------------------------------------------- parsing helpers
function parseAmount(text, available) {
  const t = String(text || "").trim().toLowerCase().replace(/,/g, "");
  if (t === "all" || t === "max") return Math.floor(available);
  if (t === "half") return Math.floor(available / 2);
  const m = /^(\d+(?:\.\d+)?)\s*([kmb])?$/.exec(t);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  const n = Math.floor(parseFloat(m[1]) * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// mention > replied-to message > raw numeric id in the args
function targetOf(ev, args) {
  const text = String(args || "");
  if (ev.mentions && typeof ev.mentions === "object") {
    const id = Object.keys(ev.mentions)[0];
    if (id) {
      const label = String(ev.mentions[id] || "");
      let rest = text;
      for (const v of [label, "@" + label.replace(/^@/, "")]) if (v && v !== "@") rest = rest.split(v).join(" ");
      return { id: String(id), rest: rest.replace(/\s+/g, " ").trim() };
    }
  }
  const idMatch = /\b(\d{8,})\b/.exec(text);
  if (idMatch) return { id: idMatch[1], rest: text.replace(idMatch[1], "").trim() };
  if (ev.messageReply && ev.messageReply.senderID) return { id: String(ev.messageReply.senderID), rest: text };
  return null;
}

function remaining(ms) {
  const s = Math.ceil(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function findItem(q) {
  const t = String(q || "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return ITEM_KEYS[Number(t) - 1] || null;
  return ITEM_KEYS.find((k) => k === t || ITEMS[k].name.toLowerCase() === t || ITEMS[k].name.toLowerCase().includes(t)) || null;
}

function getNames(api, ids) {
  return new Promise((resolve) => {
    if (!api || typeof api.getUserInfo !== "function" || !ids.length) return resolve({});
    const guard = setTimeout(() => resolve({}), 6000);
    try {
      api.getUserInfo(ids, (err, info) => {
        clearTimeout(guard);
        if (err || !info) return resolve({});
        const out = {};
        for (const id of ids) if (info[id] && info[id].name) out[id] = info[id].name;
        resolve(out);
      });
    } catch { clearTimeout(guard); resolve({}); }
  });
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------- commands
const commands = {
  balance: {
    run: async ({ ev, args, S }) => {
      const t = args ? targetOf(ev, args) : null;
      const id = t ? t.id : ev.senderID;
      const u = user(id);
      const who = t ? (await getNames(S.api, [id]))[id] || "User" : "Ikaw";
      return `💰 ${who}\nWallet: ${money(u.wallet)}\nBank: ${money(u.bank)} / ${fmt(bankCap(u))}\nNet worth: ${money(total(u))}`;
    },
  },
  bal: { alias: "balance" },
  bank: {
    run: async ({ ev, prefix }) => {
      const u = user(ev.senderID);
      return `🏦 Bank\nLaman: ${money(u.bank)} / ${fmt(bankCap(u))}\nWallet: ${money(u.wallet)}\n\n${prefix}deposit <amount|all> · ${prefix}withdraw <amount|all>\n+1% interest kapag nag-${prefix}daily (max ${COIN} 200).\nAng nasa bank ay hindi nawawala sa ${prefix}bet.`;
    },
  },
  deposit: {
    run: async ({ ev, args, prefix }) => {
      const u = user(ev.senderID);
      const room = bankCap(u) - u.bank;
      const amt = parseAmount(args, Math.min(u.wallet, room));
      if (!amt) return `Format: ${prefix}deposit 500 (o all)`;
      if (amt > u.wallet) return `Kulang ang wallet mo (${money(u.wallet)}).`;
      if (amt > room) return room <= 0 ? `Puno na ang bank mo. Bumili ng 🏦 Bank Vault sa ${prefix}shop.` : `Hanggang ${money(room)} na lang ang kasya sa bank.`;
      u.wallet -= amt; u.bank += amt; dirty();
      return `✅ Na-deposit: ${money(amt)}\nWallet: ${money(u.wallet)} · Bank: ${money(u.bank)}`;
    },
  },
  dep: { alias: "deposit" },
  withdraw: {
    run: async ({ ev, args, prefix }) => {
      const u = user(ev.senderID);
      const amt = parseAmount(args, u.bank);
      if (!amt) return `Format: ${prefix}withdraw 500 (o all)`;
      if (amt > u.bank) return `Kulang ang bank mo (${money(u.bank)}).`;
      u.bank -= amt; u.wallet += amt; dirty();
      return `✅ Na-withdraw: ${money(amt)}\nWallet: ${money(u.wallet)} · Bank: ${money(u.bank)}`;
    },
  },
  with: { alias: "withdraw" },

  daily: {
    run: async ({ ev }) => {
      const u = user(ev.senderID);
      const now = Date.now();
      if (now - u.lastDaily < DAILY_COOLDOWN) return `⏳ Na-claim mo na. Balik ka in ${remaining(DAILY_COOLDOWN - (now - u.lastDaily))}.`;
      u.streak = u.lastDaily && now - u.lastDaily <= STREAK_BREAK ? u.streak + 1 : 1;
      const base = DAILY_BASE + DAILY_STREAK * Math.min(u.streak - 1, DAILY_MAX_STREAK);
      const gain = Math.round(base * boost(u));
      const interest = Math.min(200, Math.floor(u.bank * 0.01));
      u.wallet += gain; u.bank += interest; u.lastDaily = now; dirty();
      return `🎁 Daily: +${money(gain)}${interest ? `\n🏦 Interest: +${money(interest)}` : ""}\n🔥 Streak: ${u.streak} araw\nWallet: ${money(u.wallet)}`;
    },
  },
  work: {
    run: async ({ ev }) => {
      const u = user(ev.senderID);
      const now = Date.now();
      if (now - u.lastWork < WORK_COOLDOWN) return `😮‍💨 Pagod ka pa. Balik in ${remaining(WORK_COOLDOWN - (now - u.lastWork))}.`;
      const gain = Math.round((50 + Math.random() * 200) * boost(u));
      u.wallet += gain; u.lastWork = now; dirty();
      return `💼 ${pick(JOBS)} at kumita ka ng ${money(gain)}.\nWallet: ${money(u.wallet)}`;
    },
  },
  bet: {
    run: async ({ ev, args, prefix }) => {
      const u = user(ev.senderID);
      const amt = parseAmount(args, Math.min(u.wallet, BET_MAX));
      if (!amt) return `Format: ${prefix}bet 100 (o all) · max ${money(BET_MAX)}`;
      if (amt > BET_MAX) return `Max bet: ${money(BET_MAX)}.`;
      if (amt > u.wallet) return `Kulang ang wallet mo (${money(u.wallet)}).`;
      const win = Math.random() < BET_WIN;
      u.wallet += win ? amt : -amt; dirty();
      return win ? `🎲 Panalo! +${money(amt)}\nWallet: ${money(u.wallet)}` : `🎲 Talo... -${money(amt)}\nWallet: ${money(u.wallet)}`;
    },
  },
  give: {
    run: async ({ ev, args, prefix, S }) => {
      const t = targetOf(ev, args);
      const amt = t && parseAmount(t.rest.split(/\s+/).pop(), user(ev.senderID).wallet);
      if (!t || !amt) return `Format: ${prefix}give @tao 500 (o i-reply sa mensahe nila: ${prefix}give 500)`;
      if (t.id === String(ev.senderID)) return "Hindi puwedeng sa sarili 😅";
      const me = user(ev.senderID);
      if (amt > me.wallet) return `Kulang ang wallet mo (${money(me.wallet)}).`;
      const you = user(t.id);
      me.wallet -= amt; you.wallet += amt; dirty();
      const name = (await getNames(S.api, [t.id]))[t.id] || "kaibigan mo";
      return `💸 Naipadala mo ang ${money(amt)} kay ${name}.\nWallet mo: ${money(me.wallet)}`;
    },
  },
  pay: { alias: "give" },

  shop: {
    run: async ({ prefix }) =>
      "🛒 Shop\n" +
      ITEM_KEYS.map((k, i) => `${i + 1}. ${ITEMS[k].emoji} ${ITEMS[k].name} — ${money(ITEMS[k].price)}\n   ${ITEMS[k].desc}`).join("\n") +
      `\n\n${prefix}buy <# o pangalan> [dami] · ${prefix}sell <item> [dami] · ${prefix}inv`,
  },
  buy: {
    run: async ({ ev, args, prefix }) => {
      const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
      const qty = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? Math.min(50, Number(parts.pop())) : 1;
      const key = findItem(parts.join(" "));
      if (!key) return `Format: ${prefix}buy 1 (o ${prefix}buy charm 2). Tingnan ang ${prefix}shop.`;
      const it = ITEMS[key], u = user(ev.senderID);
      if (it.max && items(u, key) + qty > it.max) return `Max na ang ${it.emoji} ${it.name} (${it.max}).`;
      const cost = it.price * qty;
      if (u.wallet < cost) return `Kulang ang wallet mo. Kailangan: ${money(cost)} · Meron ka: ${money(u.wallet)}\n(Nasa bank ang pera? ${prefix}withdraw muna.)`;
      u.wallet -= cost; u.inv[key] = items(u, key) + qty; dirty();
      return `🛍 Nabili: ${qty}× ${it.emoji} ${it.name} (-${money(cost)})\nWallet: ${money(u.wallet)}`;
    },
  },
  sell: {
    run: async ({ ev, args, prefix }) => {
      const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
      const qty = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? Number(parts.pop()) : 1;
      const key = findItem(parts.join(" "));
      const u = user(ev.senderID);
      if (!key) return `Format: ${prefix}sell jeep (o ${prefix}sell charm 2)`;
      if (items(u, key) < qty) return `Kulang ang ${ITEMS[key].emoji} ${ITEMS[key].name} mo.`;
      if (key === "vault" && total(u) > 0 && u.bank > bankCap(u) - VAULT_BONUS * qty) return "Hindi mo maibebenta ang Vault: lalampas sa bank limit ang laman ng bank mo. Mag-withdraw muna.";
      const gain = Math.floor(ITEMS[key].price * SELL_RATE) * qty;
      u.inv[key] -= qty; if (!u.inv[key]) delete u.inv[key]; u.wallet += gain; dirty();
      return `💵 Naibenta: ${qty}× ${ITEMS[key].emoji} ${ITEMS[key].name} (+${money(gain)}, 50% ng presyo)`;
    },
  },
  inventory: {
    run: async ({ ev }) => {
      const u = user(ev.senderID);
      const own = ITEM_KEYS.filter((k) => items(u, k) > 0);
      return own.length ? "🎒 Inventory\n" + own.map((k) => `${ITEMS[k].emoji} ${ITEMS[k].name} ×${items(u, k)}`).join("\n") : "🎒 Walang laman. Tingnan ang !shop";
    },
  },
  inv: { alias: "inventory" },
  leaderboard: {
    run: async ({ S }) => {
      const top = Object.entries(db.users).map(([id, u]) => ({ id, t: total(u) })).filter((x) => x.t > 0).sort((a, b) => b.t - a.t).slice(0, 10);
      if (!top.length) return "Wala pang may pera. Mag-!daily na!";
      const names = await getNames(S.api, top.map((x) => x.id));
      const medal = ["🥇", "🥈", "🥉"];
      return "🏆 Pinakamayayaman\n" + top.map((x, i) => `${medal[i] || i + 1 + "."} ${names[x.id] || "User " + x.id.slice(-4)} — ${money(x.t)}`).join("\n");
    },
  },
  top: { alias: "leaderboard" },

  // admin: !eco add @tao 1000 | remove @tao 500 | reset @tao
  eco: {
    admin: true,
    run: async ({ ev, args, prefix }) => {
      const [sub, ...rest] = String(args || "").trim().split(/\s+/);
      const t = targetOf(ev, rest.join(" "));
      if (!t) return `Format: ${prefix}eco add|remove|reset @tao [amount]`;
      const u = user(t.id);
      const amt = parseAmount(t.rest.split(/\s+/).pop(), 0);
      switch ((sub || "").toLowerCase()) {
        case "add": if (!amt) return "Kulang ang amount."; u.wallet += amt; dirty(); return `✅ +${money(amt)} → wallet: ${money(u.wallet)}`;
        case "remove": if (!amt) return "Kulang ang amount."; u.wallet = Math.max(0, u.wallet - amt); dirty(); return `✅ -${money(amt)} → wallet: ${money(u.wallet)}`;
        case "reset": delete db.users[String(t.id)]; dirty(); return "✅ Na-reset.";
        default: return `Format: ${prefix}eco add|remove|reset @tao [amount]`;
      }
    },
  },
};

module.exports = { init, flush, commands, ITEMS, parseAmount, money };
