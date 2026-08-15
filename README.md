# Sightline

🇬🇧 English · [🇷🇺 Русский](README.ru.md) · [🇨🇳 中文](README.zh.md)

A companion app for War Thunder. It reads the kill feed from the game's own local web server
(`http://127.0.0.1:8111`), shows who is fighting in what vehicle right now, and builds up a local
history of battles and players.

> Not affiliated with or endorsed by Gaijin Entertainment. War Thunder is a trademark of Gaijin
> Entertainment; the name is used here only to state compatibility. The app talks exclusively to the
> local API the game exposes itself and modifies nothing in the game client.

## Is this allowed?

`127.0.0.1:8111` is an official local API that War Thunder starts on its own — the same one used by
streaming overlays, WTRTI and similar tools. The `/hudmsg` endpoint returns exactly the kill feed
that is already drawn on your screen. It contains no hidden data: no positions of unspotted enemies,
no state of their vehicles. The app simply remembers what you are already reading with your own eyes.

**The limitation that shapes everything:** the game does not expose a full scoreboard. A player only
appears in the table after they kill someone, damage someone, or get killed. In practice that covers
most of the lobby a few minutes into a battle, but never all of it instantly.

## Running

```bash
npm install
```

```bash
npm start
```

Mock mode replays a recorded battle from `fixtures/hudmsg-live.json`, so you can see the interface
without launching the game:

```bash
npm run mock
```

Tests:

```bash
npm test
```

## One window, eight tabs

- **Battle** — the live table: allies on the left, enemies on the right. Each vehicle carries a class
  icon (`▮` ground, `◬` SPAA, `✈` plane, `⊹` helicopter). Your own row is highlighted.
- **Statistics** — four counter tiles (since launch, today, this week, this month; each resets
  independently), followed by charts: battles by hour of day, win/loss streaks, KDA and win rate
  by day as a seven-day rolling average, and a half-year activity calendar.
- **Battles** — battle history with search by nick or vehicle and filters by period, outcome
  and your own vehicle. The summary above the list is computed over the filtered selection,
  not the whole database. Click a battle to expand its full roster with awards and vehicles.
- **Players** — top allies and top enemies for a period, with a "minimum encounters" threshold.
- **My vehicles** — win rate plus per-vehicle stats, next to what the enemy team brings most often.
  Every column is sortable.
- **How to use** — a plain-language guide in larger type. The «?» button in the header opens the
  section about the tab you are currently on.
- **About** — version, licence, where the data file lives.
- **Settings** — tray and startup, your nickname, interface language (English, Russian, Chinese), interface size,
  always-on-top, database size and the destructive operations.

Counters do not store numbers. The database keeps the moment of the last reset, and the count is a
query — so resetting a counter deletes nothing, and clearing history zeroes all counters by itself.

## How it reads a battle

**Battle boundaries.** Message ids in `/hudmsg` run through the whole game session and do not restart
per battle, and the log is a sliding window covering several battles at once. The only reliable
boundary is the `time` field — seconds since battle start, which drops when a new battle begins.
Note that the respawn screen also reports `valid: false`, exactly like the hangar, so a short break
is never treated as a new battle.

**Teams.** The API carries no team flag. Sides are derived from a graph: every kill or damage event
means "these two are on opposite sides", and the colouring spreads from there. Two anchors tie that
graph to *your* side — you appearing in the feed, and team chat from `/gamechat`, which only your own
team can see. Players not yet connected to your side are shown grouped: within a group it is known
who opposes whom, just not which half is yours.

**What is filtered out.** Recon drones, missiles and other game entities (`[ии] Recon Micro`,
`weapons/us_agm_88a/short`, `130mm_9m120_1`) are not players: destroying one is neither a death nor
a frag.

## Database

SQLite through Node's built-in `node:sqlite` module — **no native dependencies**, nothing to compile
or rebuild against the Electron ABI. File: `%APPDATA%/Sightline/battles.db`.

Nothing is ever deleted automatically. Measured on the real schema (32 players per battle with their
sorties, duels and awards):

| Battles | Size |
|---|---|
| 1 000 | 13 MB |
| 10 000 | 126 MB |
| 50 000 | 632 MB |

Every destructive operation makes a backup copy next to the database first and requires typing a
confirmation word, so a stray click costs nothing.

## Getting started

1. Enter **your in-game nickname** in Settings. Without it the app cannot tell allies from enemies.
   The clan tag is not needed: `Username` matches `[CLAN] Username`.
2. "Always on top" works when the game runs in **borderless windowed** mode; Windows will not show it
   over exclusive fullscreen.
3. The table clears when a new battle starts, not when you die or return to the hangar.

## What the battle table shows

| Column | Meaning |
|---|---|
| K / D / A | frags, losses and assists. Assists are derived, not reported: you damaged a target, someone else finished it |
| ★ | awards earned this battle — hover for the list. Only awards the game writes into the kill feed |
| Status | `in battle` · `destroyed · choosing` · `left` · `not deployed` |
| Vehicles | one chip per sortie in order. `×N` — frags on that vehicle, a struck-through chip means it was destroyed, a solid border marks the current one, a dashed one means the sortie ended without a confirmed death |

The player who killed you last is outlined in gold — the target for the *Eye for an Eye* award. The
outline disappears once the award is out of reach.

## How you know the stats are real

The stats are gathered by an app running on the player's own machine — which means they can be
faked. We do not pretend otherwise and do not hide behind obfuscation: any key the client signs
requests with sits on the machine of the very person we would be defending against.

Instead, battles verify each other. Several people running this app can end up in the same battle,
and all of them see the same kill feed. When their records of the same event agree, the battle gets
a **green check**. When someone's data contradicts the rest, the discrepancy stays in the database
for good.

The key detail is **who** confirmed it. An ally can be brought along: take a second account into
your squad and confirm anything to yourself. Opponents, however, are not chosen — you cannot put
your own alt on the enemy team. That makes confirmation from the enemy side worth far more, and the
green check is granted for exactly that.

A missing check is not an accusation. While there are few users, a player will be the only one in
most of their battles, and there is simply nobody to corroborate them. Such battles stay neutral.
The yellow triangle on an account appears not for a lack of witnesses but only for **confirmed
discrepancies** with other people's records — and not for a single one, but for a consistent
pattern: a client may have started mid-battle or lost some lines, and that is a gap, not a lie.

The more people use the app, the denser the web of witnesses and the less point there is in faking
anything. It cuts both ways: verified data will be scarce at first, and we honestly show how many
battles in a profile are confirmed.

## What is not possible

- **Battle rewards and XP.** The post-battle results screen is not exposed by the local API at all.
  Only OCR of the screen could get it — a separate project.
- **Map name and battle rating.** Not in the API either.
- **The full player list.** See the limitation above.

## Layout

| File | Purpose |
|---|---|
| `src/main/wt-client.js` | polling `/hudmsg`, `/map_info.json`, `/gamechat`; battle boundaries |
| `src/main/killfeed-parser.js` | a feed line → participants, event type, awards |
| `src/main/verbs.js` | verb and award phrasings (ru/en) — the one place to extend |
| `src/main/battle-state.js` | K/D/A, sorties, statuses, team graph (union-find with parity) |
| `src/main/vehicle-class.js` | vehicle class for icons; filters out game entities |
| `src/main/db.js` | SQLite: battles, players, counters, awards, backups |
| `src/main/migrations.js` | schema version in `PRAGMA user_version`; steps run in order, once each |
| `src/renderer/` | the single window: tabs, ally/enemy split |
| `src/renderer/charts.js` | inline-SVG charts, no third-party libraries |
| `src/i18n/` | interface strings in three languages; key parity is covered by a test |
| `src/renderer/i18n.js` | t(key), plural forms, substitution into the markup |

Roadmap: [ROADMAP.txt](ROADMAP.txt). The original plan that got the app this far:
[docs/PLAN.md](docs/PLAN.md).

`npm run harness` builds the whole interface into a single HTML file backed by stub data —
handy for working on the layout in a browser without launching Electron.

## Extending the parser

If the "unrecognised kill feed lines" block appears in Settings, copy the line and add its phrasing
to `src/main/verbs.js`. Nothing else needs editing.

One trap worth knowing: in JavaScript `\b` is based on ASCII word characters, so it never matches
next to Cyrillic. Patterns for Russian phrasings must not use it.
