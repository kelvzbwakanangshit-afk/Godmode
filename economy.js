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
const ROB_COOLDOWN = 30 * 60e3;
const ROB_WIN = 0.4;
const ROB_MAX = 5000;
const SLOT_SYMBOLS = ["🍒", "🍋", "🔔", "⭐", "💎", "7️⃣"];

const ITEMS = {
  charm: { emoji: "🍀", name: "Lucky Charm", price: 2500, max: 5, desc: "+10% sa !work at !daily (max 5)" },
  vault: { emoji: "🏦", name: "Bank Vault", price: 5000, max: 20, desc: `+${VAULT_BONUS.toLocaleString("en-US")} bank limit` },
  laptop: { emoji: "💻", name: "Laptop", price: 6000, max: 3, desc: "+25% sa !work (max 3)" },
  padlock: { emoji: "🔒", name: "Padlock", price: 1500, max: 10, desc: "Pangharang sa 1 !rob (nauubos)" },
  phone: { emoji: "📱", name: "Cellphone", price: 8000, desc: "Pang-flex lang" },
  jeep: { emoji: "🚙", name: "Jeep", price: 15000, desc: "Pang-flex lang" },
  house: { emoji: "🏠", name: "Bahay", price: 100_000, desc: "Pang-flex lang" },
  crown: { emoji: "👑", name: "Korona", price: 500_000, desc: "Pinaka-flex" },
};
const itemKeys = () => Object.keys(ITEMS);
for (const k of Object.keys(ITEMS)) ITEMS[k].builtin = true;
const MAX_CUSTOM = 60;

const JOBS = [
  "nag-deliver ka ng pagkain", "nag-tutor ka ng grade school", "naging tindero ka sa sari-sari store",
  "nag-edit ka ng video", "nag-ayos ka ng cellphone", "nag-drive ka ng jeep", "nag-freelance ka bilang designer",
  "nagbenta ka ng fishball", "nag-barista ka buong araw", "nag-repair ka ng aircon",
];

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => `${COIN} ${fmt(n)}`;

// ---------------------------------------------------------------- store
let FILE = null;
let db = { users: {}, customItems: {} };
let timer = null;
let logFn = () => {};

function init(dataDir, log) {
  FILE = path.join(dataDir, "economy.json");
  if (typeof log === "function") logFn = log;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object" && raw.users) db = raw;
  } catch { /* first run */ }
  if (!db.customItems || typeof db.customItems !== "object") db.customItems = {};
  for (const [k, v] of Object.entries(db.customItems)) if (!ITEMS[k] && v && v.name && v.price > 0) ITEMS[k] = { ...v, custom: true };
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
  if (!db.users[key]) db.users[key] = { wallet: 0, bank: 0, inv: {}, lastDaily: 0, streak: 0, lastWork: 0, lastRob: 0 };
  return db.users[key];
}
const items = (u, k) => Number((u.inv && u.inv[k]) || 0);
const bankCap = (u) => BASE_BANK + VAULT_BONUS * items(u, "vault");
const boost = (u) => 1 + 0.1 * items(u, "charm");
const workBoost = (u) => boost(u) + 0.25 * items(u, "laptop");
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
      for (const v of ["@" + label.replace(/^@/, ""), label]) if (v && v !== "@") rest = rest.split(v).join(" ");
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
  if (/^\d+$/.test(t)) return itemKeys()[Number(t) - 1] || null;
  return itemKeys().find((k) => k === t || ITEMS[k].name.toLowerCase() === t || ITEMS[k].name.toLowerCase().includes(t)) || null;
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
      const gain = Math.round((50 + Math.random() * 200) * workBoost(u));
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
      itemKeys().map((k, i) => `${i + 1}. ${ITEMS[k].emoji} ${ITEMS[k].name} — ${money(ITEMS[k].price)}\n   ${ITEMS[k].desc}`).join("\n") +
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
      const own = itemKeys().filter((k) => items(u, k) > 0);
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

  // ---- games ----
  slot: {
    run: async ({ ev, args, prefix }) => {
      const u = user(ev.senderID);
      const amt = parseAmount(args, Math.min(u.wallet, BET_MAX));
      if (!amt) return `Format: ${prefix}slot 100 (o all) · max ${money(BET_MAX)}`;
      if (amt > BET_MAX) return `Max bet: ${money(BET_MAX)}.`;
      if (amt > u.wallet) return `Kulang ang wallet mo (${money(u.wallet)}).`;
      const r = [pick(SLOT_SYMBOLS), pick(SLOT_SYMBOLS), pick(SLOT_SYMBOLS)];
      const uniq = new Set(r).size;
      const mult = uniq === 1 ? 8 : uniq === 2 ? 1.5 : 0;
      const ret = Math.floor(amt * mult);
      u.wallet += ret - amt; dirty();
      const head = `🎰 [ ${r.join(" | ")} ]`;
      if (uniq === 1) return `${head}\n🎉 JACKPOT! +${money(ret - amt)}\nWallet: ${money(u.wallet)}`;
      if (uniq === 2) return `${head}\n✨ Pares! +${money(ret - amt)}\nWallet: ${money(u.wallet)}`;
      return `${head}\n💀 Talo... -${money(amt)}\nWallet: ${money(u.wallet)}`;
    },
  },
  cf: {
    run: async ({ ev, args, prefix }) => {
      const [sideRaw, ...rest] = String(args || "").trim().split(/\s+/);
      const side = { h: "Heads", heads: "Heads", head: "Heads", t: "Tails", tails: "Tails", tail: "Tails" }[(sideRaw || "").toLowerCase()];
      const u = user(ev.senderID);
      const amt = parseAmount(rest.join(" "), Math.min(u.wallet, BET_MAX));
      if (!side || !amt) return `Format: ${prefix}cf heads|tails 100 · max ${money(BET_MAX)}`;
      if (amt > BET_MAX) return `Max bet: ${money(BET_MAX)}.`;
      if (amt > u.wallet) return `Kulang ang wallet mo (${money(u.wallet)}).`;
      const win = Math.random() < BET_WIN;
      const result = win ? side : side === "Heads" ? "Tails" : "Heads";
      u.wallet += win ? amt : -amt; dirty();
      return `🪙 ${result}! ${win ? `Panalo +${money(amt)}` : `Talo -${money(amt)}`}\nWallet: ${money(u.wallet)}`;
    },
  },
  rob: {
    run: async ({ ev, args, prefix, S }) => {
      const t = targetOf(ev, args);
      if (!t) return `Format: ${prefix}rob @tao (o i-reply sa mensahe nila)`;
      if (t.id === String(ev.senderID)) return "Sarili mo? 😅";
      const me = user(ev.senderID), now = Date.now();
      if (now - (me.lastRob || 0) < ROB_COOLDOWN) return `🚓 Lay low ka muna. Balik in ${remaining(ROB_COOLDOWN - (now - me.lastRob))}.`;
      const you = user(t.id);
      if (you.wallet < 200) return "Walang laman ang wallet nila (min 🪙 200). Sayang ang effort 😅";
      me.lastRob = now;
      const name = (await getNames(S.api, [t.id]))[t.id] || "biktima";
      if (items(you, "padlock") > 0) {
        you.inv.padlock -= 1; if (!you.inv.padlock) delete you.inv.padlock; dirty();
        return `🔒 Naka-padlock ang wallet ni ${name}! Nasira ang padlock pero wala kang nakuha.`;
      }
      if (Math.random() < ROB_WIN) {
        const take = Math.min(ROB_MAX, Math.max(1, Math.floor(you.wallet * (0.1 + Math.random() * 0.2))));
        you.wallet -= take; me.wallet += take; dirty();
        return `🦹 Nakuha mo ang ${money(take)} kay ${name}!\nWallet: ${money(me.wallet)}`;
      }
      const fine = Math.min(me.wallet, Math.min(2000, Math.max(100, Math.floor(me.wallet * 0.1))));
      me.wallet -= fine; you.wallet += fine; dirty();
      return `🚓 Nahuli ka! Multa ${money(fine)} na napunta kay ${name}.\nWallet: ${money(me.wallet)}`;
    },
  },

  item: {
    run: async ({ args, prefix }) => {
      const key = findItem(args);
      if (!key) return `Format: ${prefix}item <# o pangalan> (tingnan ang ${prefix}shop)`;
      const it = ITEMS[key];
      return `${it.emoji} ${it.name}\nPresyo: ${money(it.price)} · Benta: ${money(Math.floor(it.price * SELL_RATE))}${it.max ? `\nMax: ${it.max}` : ""}\n${it.desc}`;
    },
  },

  // owner only: !setbal @tao 5000 [wallet|bank] · !setbal 5000 (sarili) · i-reply + !setbal 5000
  setbal: {
    owner: true,
    run: async ({ ev, args, prefix, S }) => {
      const usage = `Format: ${prefix}setbal @tao 5000 [wallet|bank]\n(o i-reply ang mensahe nila · ${prefix}setbal 5000 para sa sarili)`;
      let field = "wallet";
      const rest = [];
      for (const w of String(args || "").trim().split(/\s+/).filter(Boolean)) {
        const l = w.toLowerCase();
        if (l === "wallet" || l === "cash") field = "wallet";
        else if (l === "bank") field = "bank";
        else rest.push(w);
      }
      const m = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(String(rest.pop() || "").replace(/,/g, "").toLowerCase());
      if (!m) return usage;
      const amt = Math.floor(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
      if (!Number.isFinite(amt) || amt > 1e12) return "Masyadong malaki ang amount (max 1 trillion).";
      let id = String(ev.senderID);
      if (rest.length) {
        const t = targetOf(ev, rest.join(" "));
        if (!t) return usage;
        id = t.id;
      } else if (ev.messageReply && ev.messageReply.senderID) id = String(ev.messageReply.senderID);
      const u = user(id);
      const before = u[field];
      u[field] = amt; dirty();
      const name = id === String(ev.senderID) ? "Ikaw" : (await getNames(S.api, [id]))[id] || `User ${id.slice(-4)}`;
      return `✅ ${name}: ${field} ${money(before)} → ${money(amt)}\nWallet: ${money(u.wallet)} · Bank: ${money(u.bank)}`;
    },
  },
  setbalance: { alias: "setbal" },

  // ---- owner: manage shop items ----
  // !additem Pizza | 150 | 🍕 | Masarap na pizza | 10      (name | price | emoji | description | max — emoji/desc/max optional)
  additem: {
    owner: true,
    run: async ({ args, prefix }) => {
      const usage = `Format: ${prefix}additem Pangalan | presyo | emoji | description | max\nHal: ${prefix}additem Pizza | 150 | 🍕 | Masarap | 10\n(emoji, description, max ay optional · tumatanggap ng 5k, 1m)`;
      const raw = String(args || "").trim();
      if (!raw) return usage;
      let parts = raw.split("|").map((x) => x.trim());
      if (parts.length === 1) {                      // "Pizza 150"
        const m = /^(.+?)\s+(\d[\d,.]*[kmb]?)$/i.exec(raw);
        if (!m) return usage;
        parts = [m[1], m[2]];
      }
      const [name, priceRaw, emojiRaw, descRaw, maxRaw] = parts;
      if (!name || name.length > 30) return "Ang pangalan ay 1–30 letra lang.";
      const price = parseAmount(priceRaw, 0);
      if (!price || price > 1e12) return `Mali ang presyo. ${usage}`;
      if (Object.values(ITEMS).some((it) => it.name.toLowerCase() === name.toLowerCase())) return "May item na may ganyang pangalan na.";
      if (Object.keys(db.customItems).length >= MAX_CUSTOM) return `Max ${MAX_CUSTOM} custom items na.`;
      let max = 0;
      if (maxRaw) { max = Math.floor(Number(maxRaw)); if (!(max >= 1 && max <= 1000)) return "Ang max ay 1–1000 (iwan na lang kung walang limit)."; }
      let key = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "item";
      if (/^\d+$/.test(key)) key = "i" + key;
      let base = key, n = 2;
      while (ITEMS[key]) key = base + n++;
      const item = { emoji: (emojiRaw || "🎁").slice(0, 8), name, price, desc: (descRaw || "Custom item").slice(0, 120), ...(max ? { max } : {}) };
      db.customItems[key] = item; ITEMS[key] = { ...item, custom: true }; dirty();
      return `✅ Nadagdag sa shop: #${itemKeys().indexOf(key) + 1} ${item.emoji} ${name} — ${money(price)}${max ? ` (max ${max})` : ""}\n${item.desc}`;
    },
  },
  // !edititem <# o name> price|name|emoji|desc|max <value>   (custom items lang)
  edititem: {
    owner: true,
    run: async ({ args, prefix }) => {
      const m = /^(.+?)\s+(price|presyo|name|emoji|desc|description|max)\s+([\s\S]+)$/i.exec(String(args || "").trim());
      const key = m && findItem(m[1]);
      const usage = `Format: ${prefix}edititem <# o pangalan> price|name|emoji|desc|max <bagong value>`;
      if (!m || !key) return usage;
      if (!db.customItems[key]) return "Custom items lang ang puwedeng i-edit (hindi ang built-in).";
      const it = db.customItems[key], field = m[2].toLowerCase(), val = m[3].trim();
      if (field === "price" || field === "presyo") { const p = parseAmount(val, 0); if (!p || p > 1e12) return "Mali ang presyo."; it.price = p; }
      else if (field === "name") { if (!val || val.length > 30) return "Ang pangalan ay 1–30 letra lang."; it.name = val; }
      else if (field === "emoji") it.emoji = val.slice(0, 8);
      else if (field === "max") { if (/^(0|none|wala)$/i.test(val)) delete it.max; else { const x = Math.floor(Number(val)); if (!(x >= 1 && x <= 1000)) return "Ang max ay 1–1000 (o 0 para walang limit)."; it.max = x; } }
      else it.desc = val.slice(0, 120);
      ITEMS[key] = { ...it, custom: true }; dirty();
      return `✅ Na-update: ${ITEMS[key].emoji} ${ITEMS[key].name} — ${money(ITEMS[key].price)}${ITEMS[key].max ? ` (max ${ITEMS[key].max})` : ""}\n${ITEMS[key].desc}`;
    },
  },
  // !delitem <# o name>   — tinatanggal sa shop; ang may-ari nito ay nire-refund ng 50%
  delitem: {
    owner: true,
    run: async ({ args, prefix }) => {
      const key = findItem(args);
      if (!key) return `Format: ${prefix}delitem <# o pangalan>`;
      if (!db.customItems[key]) return "Custom items lang ang puwedeng tanggalin (hindi ang built-in).";
      const it = ITEMS[key];
      let holders = 0, refunded = 0;
      for (const u of Object.values(db.users)) {
        const have = items(u, key);
        if (!have) continue;
        const gain = Math.floor(it.price * SELL_RATE) * have;
        u.wallet += gain; refunded += gain; holders++; delete u.inv[key];
      }
      delete db.customItems[key]; delete ITEMS[key]; dirty();
      return `🗑 Tinanggal: ${it.emoji} ${it.name}${holders ? `\nNa-refund (50%) ang ${holders} may-ari: ${money(refunded)} lahat` : ""}`;
    },
  },

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

module.exports = { init, flush, commands, ITEMS, parseAmount, money, getNames, targetOf };
