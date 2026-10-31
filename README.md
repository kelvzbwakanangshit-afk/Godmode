# Celestial Troll Bot

Troll bot na may pagka-assistant para sa Facebook Messenger. Lahat ng file ay nasa **root** (walang subfolder).

- Humanized na troll replies (`replies.json`) na may **working typing indicator**
- `!m [title] by [artist]` — info + 30s audio preview + link
- **GC name cycle** na hindi titigil hangga't hindi mo pinapatay
- Assistant commands: `!ask`, `!weather`, `!calc`, `!define`, `!time`, `!remind`, `!roll`, `!8ball`, `!pick`...
- Auto-reconnect, auto-save ng cookie, auto-resume pag nag-restart ang server

## Files (lahat nasa root)
`server.js` (main) · `commands.js` · `music.js` · `economy.js` · `gcname.js` · `human-typing.js` · `banat-*.js` · `human-*.js` · `replies.json` · `index.html` (dashboard) · `package.json` · `railway.json` · `.gitignore`

## Deploy (Railway)
1. Push sa GitHub → New Project → Deploy.
2. Mag-mount ng Volume at i-set ang `DATA_DIR=/app/data` (dito sine-save ang cookie at settings; kapag wala, mawawala ito sa bawat redeploy).
3. Buksan ang domain → paste cookie → **Save & connect** → pili ng GC → **Start**.
4. Optional na pang-lock ng dashboard: `ADMIN_PASSWORD`.

> **Huwag i-commit ang cookie.** Naka-`.gitignore` na ang `config.json`, `appstate.json`, `account.txt`. Kapag public ang repo, sinuman ay makaka-login sa account mo gamit ang cookie.

## Lazymeta FCA
Ang bot ay gumagamit lang ng standard na fca API (`login`, `listenMqtt`, `sendMessage`, `setTitle`, `sendTypingIndicator`, `getAppState`, `markAsRead`, `setMessageReaction`). Para gamitin ang lazymeta build mo:

```
npm i <pangalan-ng-lazymeta-package>
FCA_PACKAGE=<pangalan-ng-lazymeta-package>      # Railway Variable (o "fcaPackage" sa config.json)
```

Kung walang `FCA_PACKAGE`, `@dongdev/fca-unofficial` ang gagamitin. Makikita sa dashboard (taas) kung alin ang naka-load.

## Commands (prefix `!`)
**Lahat (sa napiling GC kapag naka-Start ang bot):**

| Command | Ginagawa |
|---|---|
| `!m [title] by [artist]` | Buong kanta (SoundCloud lang) + info + link. Strict: kapag hindi sigurado ang match, walang isesend. Alias: `!music`, `!song`. Gumagana rin: `(title) artist`, `title - artist`, `title \| artist`, `title by artist`, o title lang |
| `!ask <tanong>` | Sagot ni Claude (kailangan ng `ANTHROPIC_API_KEY`; model: `ASSISTANT_MODEL`, default `claude-haiku-5-5`) |
| `!weather <lugar>` | Panahon (Open-Meteo, walang key) |
| `!calc <math>` | `+ - * / % ^ ( )` (walang eval) |
| `!define <word>` | English definition |
| `!time [timezone]` | Oras, hal. `!time Asia/Tokyo` |
| `!remind 10m <text>` | `s/m/h/d`, max 7d, max 5 kada tao, saved sa config |
| `!roll [NdM]` `!flip` `!8ball` `!pick a \| b \| c` `!uptime` `!help` | |
| `!owner` (`!creator`) | Pangalan + Facebook link ng owner (Sinzu). Palitan gamit ang `OWNER_NAME` / `OWNER_LINK` env o `ownerName` / `ownerLink` sa config |

**Admin lang** (ang mismong bot account, o mga ID na nilagay mo sa **Admins** card ng dashboard; puwede rin ang `ADMIN_IDS` env):

| Command | Ginagawa |
|---|---|
| `!gcname start [sec]` | Simulan ang cycle sa chat na pinag-typan mo |
| `!gcname stop` | Patayin ang cycle |
| `!gcname status` / `list` / `now` | Status, listahan, next name agad |
| `!gcname add <name>` / `remove <#>` / `set A \| B \| C` | Ayusin ang listahan |
| `!gcname interval <sec>` | Min 10s |
| `!troll on\|off` | Patayin/buksan ang random troll replies (gumagana pa rin ang commands) |

Pwede mong i-type ang admin commands mismo sa GC gamit ang bot account (naka-`selfListen`), o gamitin ang **GC name cycle** card sa dashboard.

## Maramihang GC
- Puwedeng sabay-sabay sa maraming GC. **Sa mga GC lang na naka-ON ito magcha-chat** (troll replies at commands ng ibang tao).
- Paano i-ON: i-tick ang GC sa **Mga Group chat** card ng dashboard, **o** i-type ang `!on` sa mismong GC (admin). `!off` para patayin sa GC na iyon.
- **GC name cycle** ay multi-GC din: `!gcname start` sa isang GC = idadagdag ito sa cycle (sabay-sabay ang palit ng pangalan, may 2-6s pagitan kada GC). `!gcname stop` = aalisin lang ang GC na iyon; `!gcname stop all` = patay lahat. Sa dashboard, **Start cycle** = lahat ng naka-ON na GC.
- Ang lumang single-GC na config ay kusang nililipat sa listahan.

## Economy (coins · bank · shop)
Naka-save sa `economy.json` (nasa `DATA_DIR`, kaya ilagay sa Volume para hindi mawala ang pera sa redeploy). Pwede sa lahat ng nasa GC.

| Command | Ginagawa |
|---|---|
| `!balance [@tao]` (`!bal`) | Wallet, bank, net worth |
| `!daily` | 🪙500 + 🪙50 kada streak day (max +1,500), 20h cooldown, +1% bank interest (max 200) |
| `!work` | 🪙50–250, 30 min cooldown |
| `!bet <amt\|all>` | 45% panalo, max 🪙10,000 |
| `!deposit <amt\|all>` (`!dep`) / `!withdraw <amt\|all>` (`!with`) | Bank (limit 5,000, +10,000 kada Vault). Hindi nawawala ang nasa bank sa `!bet` |
| `!bank` | Info ng bank |
| `!give @tao <amt>` (`!pay`) | Magpadala. Pwede ring i-reply sa mensahe nila: `!give 500` |
| `!shop` / `!buy <# o pangalan> [dami]` / `!sell <item> [dami]` / `!inv` | Shop: 🍀 Lucky Charm (+10% kita, max 5), 🏦 Bank Vault (+10k limit), 📱 Cellphone, 🚙 Jeep, 🏠 Bahay, 👑 Korona. Benta = 50% ng presyo |
| `!top` | Top 10 pinakamayaman |
| `!eco add\|remove\|reset @tao [amt]` | **Admin lang** |

Amounts: `500`, `1k`, `2.5m`, `half`, `all`.

## Currency converter
`!convert 100 usd php` · `!convert 10 usd` (PHP ang default) · `!rate 1000 eur to jpy` — rates mula sa frankfurter.dev (ECB), walang key.

## "Ala patayan" — paano hindi namamatay
- **GC cycle**: naka-save ang `on` sa config; pagka-login ulit (restart/reconnect), kusang magre-resume. Ang error ay nagpapabagal lang (backoff hanggang 10 min), hindi nagpapatigil. Huminto lang kapag `!gcname stop` o Stop sa dashboard.
- **Reconnect**: unlimited na retry (backoff 8s → 5 min, tapos kada 30 min). Kapag checkpoint/expired, naka-pause ang mabilis na retry at may pulang banner, pero susubukan pa rin kada 30 min.
- **Process**: hindi namamatay sa stray exception; `restartPolicyType: ALWAYS` sa Railway; `/health` endpoint. Para sa hosts na natutulog, i-set ang `SELF_URL=https://domain-mo` para mag-self-ping.
- Cookie na ni-refresh ay sine-save kada 5 min kung may pagbabago at pag-shutdown.

## Typing indicator
Ang lumang `human-typing.js` ay hindi napapatay ang indicator (walang `sendTyping` sa fca). Ngayon: sine-save ang `end()` na ibinabalik ng `sendTypingIndicator`, nire-refresh kada 4.5s habang naghihintay (music search, `!ask`), at laging pinapatay pagkatapos mag-send (may 45s safety cutoff).

## Env (optional)
`ADMIN_PASSWORD` · `DATA_DIR` · `BOT_TZ` (default `Asia/Manila`) · `FCA_PACKAGE` · `ADMIN_IDS` (comma-separated) · `APPSTATE` (cookie JSON para sa unang boot) · `ANTHROPIC_API_KEY` · `SOUNDCLOUD_CLIENT_ID` · `MUSIC_SEND_AUDIO` · `MUSIC_MAX_MB` · `ASSISTANT_MODEL` · `SELF_URL` · `BANAT_TYPO_RATE` · `BANAT_SHORTHAND_RATE` · `BANAT_HESITATION_RATE`

## Lazy 24/7 profile (default)
- **Fast** (~1-3s), walang quiet hours, walang away break, 24/7.
- **Lazy skip:** minsan hindi sinasagot ang isang mensahe (50% chance), pero **hindi lalampas sa 4 na sunod-sunod** (`skipMax`, 0-4 sa dashboard; 0 = sasagot sa lahat). Pagkatapos ng max na skip, siguradong sasagot na.
- **Walang message limit:** `hourlyMax`, `dailyMax`, per-GC cap at cooldown kada tao ay 0 (= unlimited). Puwede mo pa ring maglagay ng limit sa dashboard (0 = walang limit). Sa commands, 2s cooldown kada tao lang. 1 auto-retry kapag pumalya ang pag-send.
- Sa unang start ng bagong bersyon, ina-apply ito sa naka-save na config (isang beses); pagkatapos, ang dashboard na ang masusunod.
- **Render:** ang free web service ay natutulog kapag walang bumibisita. Para 24/7, i-set ang `SELF_URL=https://troller.onrender.com` (self-ping kada 4 min) o gumamit ng uptime pinger. Ang free disk ay nabubura kada redeploy: gumamit ng Persistent Disk (`DATA_DIR`) o i-set ang `APPSTATE` env para hindi mawala ang cookie.

## Mga dapat tandaan
- **`!music` ay SoundCloud na ang main source** (audio + link). Kung pumalya, fallback sa Deezer/iTunes (30s preview). Mag-set ng `SOUNDCLOUD_CLIENT_ID` sa Railway para stable; kung wala, susubukan nitong hanapin ang client_id sa soundcloud.com (pwedeng masira kapag nagbago ang site nila). `MUSIC_SEND_AUDIO=0` para link/info lang, `MUSIC_MAX_MB` para sa max na laki (default 24, limit ng Messenger ay 25). Ang ibang kanta sa SoundCloud (Go+) ay snippet lang ang ibinibigay nila.
- **Ang GC name cycle ay nagpo-post ng "X named the group Y" sa bawat palit.** Mas mabilis ang interval, mas maingay at mas mataas ang tsansang ma-flag. Para sa mahabang buhay ng account, gumamit ng 45s pataas.
- Ang troll replies ay may limits (skip rate, cooldown, hourly/daily cap, quiet hours). Ang commands ay may hiwalay na cooldown (4s kada tao, 150/oras).
- Labag sa Terms ng Facebook ang unofficial automation; may risk na ma-restrict o ma-lock ang account. Gumamit ng account na kaya mong mawala.


## Economy / Shop / Moderation (GoatBot-style)

| Command | Gamit |
|---|---|
| `!balance` `!daily` `!work` `!bet` `!deposit` `!withdraw` `!give` `!top` | Economy (wallet + bank) |
| `!slot <amt>` · `!cf heads\|tails <amt>` · `!rob @tao` | Laro: slot, coinflip, nakawan (30 min cooldown) |
| `!shop` · `!item <#>` · `!buy <#> [dami]` · `!sell <item>` · `!inv` | Shop (may Laptop at Padlock na) |
| `!kick @tao` · `!ban @tao [dahilan]` · `!unban <#\|@tao>` · `!banlist` | Moderation. Naka-ban = ikikick ulit kapag in-add, at ignored ang commands niya |
| `!warn @tao [dahilan]` · `!warns [@tao]` · `!unwarn @tao [all]` | 3 warnings = auto kick |
| `!unsend` (i-reply sa mensahe ng bot) · `!mods` | Burahin ang mensahe ng bot / admin list ng GC |
| `!additem Pizza \| 150 \| 🍕 \| Masarap \| 10` · `!edititem <#> price\|name\|emoji\|desc\|max <value>` · `!delitem <#>` | **Owner lang.** Dagdag/edit/tanggal ng item sa shop (emoji, desc, max optional). Naka-save sa `economy.json`. Kapag tinanggal, nire-refund ng 50% ang may-ari. Custom items lang ang puwedeng i-edit/tanggalin |
| `!setbal @tao <amt> [wallet\|bank]` | **Owner lang.** Puwede ring i-reply ang mensahe nila, o `!setbal 5000` para sa sarili. Tumatanggap ng `5k`, `1m` |

- Moderation commands: admin ng GC o admin ng bot ang puwede. **Dapat admin ang bot account sa GC** para gumana ang kick/ban.
- Owner = bot account + `OWNER_IDS` (env, comma-separated) + `cfg.owners`. Kung walang `OWNER_IDS`, ang mga admin (`ADMIN_IDS`) ang owner.
- Saved sa `economy.json` at `moderation.json` (ilagay ang `DATA_DIR` sa Railway Volume).


## Dashboard bilang offline web app (PWA)

- Buksan ang dashboard sa browser, tapos **Install app** (Chrome/Edge/Android) o **Share → Add to Home Screen** (iPhone Safari). Magiging app icon na ito.
- Kahit walang internet, mabubuksan ang dashboard at makikita ang **huling status** na na-save sa device. Hindi gagana ang mga button (Start/Stop, settings) hangga't walang koneksyon sa server; kusa itong magre-refresh pagbalik ng internet.
- Hindi kailanman nasa cache ang `/api/*` (live data at password). Ang page, icons, at font lang ang naka-cache.
- Mga bagong file: `manifest.webmanifest`, `sw.js`, `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`. Ilagay ang lahat sa tabi ng `server.js`.
- Kung babaguhin mo ang listahan ng naka-cache na files sa `sw.js`, palitan ang `VERSION` doon.
