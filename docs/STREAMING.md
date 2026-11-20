# Streaming with souldew

OBS overlays, the TV overview, the coffee pop-up, Pokélink themes and the overlay API. Back to the [README](../README.md).
Building your own layout? The **[open stream API](STREAM_API.md)** has the run's data, live events and sprites.

## Streamer mode

**Streamer mode** (Stream page): one switch covers invite codes (also in the "copied" toast), folders and file names, the Discord webhook and locks the spoiler tab. A LIVE badge shows next to "souldew".

## TV overview

Playing in one room? The **TV overview** (Stream page, first card) puts the whole run on one screen – a television or a
second monitor – while everybody plays on their own computer: one column per player (up to five) with their name in
their colour, whether their game is running, badges, play time, where they are and the battle they're in, all six
team members with level, HP and status, and how many of their Pokémon can still fight, how many they caught and how
many deaths their knock-outs caused. On top the run's name and counts (groups alive, graveyard, caught), at the bottom
the latest news (catches, deaths, badges, evolutions), and the usual pop-ups for deaths, catches and badges (optional,
with sound if you like).

1. Connect the TV to one of the players' computers: an HDMI cable (as a second screen), a browser tab cast to a
   Chromecast / Google TV, Windows' wireless display (Win + K) or AirPlay on a Mac.
2. On that computer, Stream › TV overview › **Open in browser**. Move the window onto the TV and press F11 (Mac: ⌃⌘F).
3. Keep souldew running there. Every app of a run has every player's data, so it doesn't matter whose computer it is.

The page is `/overlay?w=tv` (add `&p=p1,p3` for some players only, `&alerts=0` without pop-ups, `&sound=1` with
sound, `&lang=de` …). It is laid out for 16:9 at 1920 × 1080 and scaled to fill any window; the mouse pointer hides
after a few seconds. Like every overlay it is served on `127.0.0.1` only: a TV's own browser can't open it, the
computer has to send its picture.

## OBS overlays

Each widget has a live preview, its own URL and **Drag into OBS** (the browser source gets the right size via `layer-width`/`layer-height`).

**One set of links for every run.** By default the links follow the **current run** (`/overlay?run=current&w=…`): the
run open in souldew, else the one played last. Start a new run, join one or open another and every overlay switches
by itself within a moment – OBS keeps the same browser sources, nothing to re-import. The **Run** menu on the Stream
page can pin the links to one run instead (`?run=<id>`); links made before 2.3.1 carry their run ID and keep showing
that run.

**Fixed size.** Every widget fills exactly the size of its browser source, from the first catch to a full team: the
team strip and the team card keep six places (free ones wait as faint empty slots), the counters keep a place for the
badges, "You are here" keeps one plate per player, and long names are shortened instead of widening anything. So a
widget never grows or moves in your scene – place it once. The size comes from the link (`layer-width`/`-height`); a
run with more players than the source was made for is scaled down to fit inside it, and a browser source smaller than
that size (OBS's default 800 × 600) scales the widget down instead of cutting it off.

The widgets:

- **Team strip** – one column per linked group with level, HP, status, shiny sparkle; dead groups turn grey.
- **Team card** – one player in detail with HP numbers, badges and play time.
- **Counters** – alive, graveyard, caught, badges per player.
- **You are here** – each player's location and current battle.
- **Alerts** – death (with the whole linked group and the opponent), catch, badge, evolution, every 10th level, run over; optional chiptune sound.
- **Stats bar.**

**Coffee pop-up** – when someone meets a legendary or mythical Pokémon while live tracking runs, there's a 25 % chance
(once per species and run, at most every 20 minutes) that the Alerts overlay shows a toast with a joke about that very
Pokémon, the "Buy me a coffee" link and a QR code, for about 12 seconds. On by default; Settings › About switches it
off.

Options per widget (layout, players, nicknames/HP/area names) and for all (glass/solid/minimal look, 75–150 % size, language). Overlays get changes pushed instantly, show "reconnecting …" if the app goes away and keep the last picture. "Test alert" sends a sample to every open overlay, and the page shows which widgets are live in OBS right now. Old links (`/overlay?run=…`) keep working. Changing a widget's layout, players or nickname/HP options changes its size – drag it into OBS again (or set the size shown under it).

## Overlay API

The endpoints below feed souldew's own overlays. For your own layout use the versioned [open stream API](STREAM_API.md) (`/api/v1`) – it is documented, stable and has CORS.

Everything runs on this computer only (`127.0.0.1`), read-only, without room keys, file names, device IDs or spoilers. The app port is normally `47390`; if that's taken the app picks a free one (the Stream page shows the real addresses).

**Snapshot** – `GET /api/runs/<id>/overlay?lang=en` (run ID from the Stream page, or `current` for the current run – 404 while there is none; language `de|en|fr|es|it`):

```json
{ "v": 1, "id": "aaaa0004", "name": "Robin & Kim", "mode": "soullink", "gen": 4, "slots": ["p1", "p2"],
  "players": { "p1": { "name": "Robin" } },
  "doc": {
    "live:p1":  { "badges": 3, "playTime": { "h": 4, "m": 7 }, "party": [{ "key": "…", "area": "route-29", "species": 155, "nick": "EMBER",
                  "level": 20, "hp": 30, "maxHp": 34, "status": 0, "shiny": false }], "at": 1761000000000 },
    "party:p1": ["starter", "route-29"],
    "enc:route-29:p1": { "outcome": "caught", "species": 161, "level": 3, "nickname": "", "shiny": false },
    "pair:route-29": { "state": "alive" },
    "where:p1": { "gen": 4, "id": 177, "name": "Route 29", "fight": { "kind": "wild", "species": 16, "level": 3 } },
    "feed:…":   { "at": 1761000000000, "type": "catch", "slot": "p1", "area": "route-29", "species": 161 }
  },
  "species": { "155": "Cyndaquil" }, "areas": { "route-29": "Route 29" }, "at": 1761000000000 }
```

`status` is the game's status word (Gen 3/4: bits 0–2 sleep, 3 poison, 4 burn, 5 freeze, 6 paralysis, 7 toxic) or a short code; `hp` 0 means fainted, `pair:<area>.state` `dead` means in the graveyard. Field names and meaning: `shared/overlay.mjs`.

**Live** – `GET /api/runs/<id>/overlay/events?lang=en` is a Server-Sent Events stream: an `event: snapshot` with the same JSON right away, then a new one on every change (about 150 ms after it is saved); `event: test` for "Test alert", `event: gone` when the run was deleted. With `current` instead of an ID the stream follows the current run: when another run becomes current, the next `snapshot` is that run's (a different `id`), and `event: norun` says there is no run (yet). Pages of other websites get a 403 – an OBS browser source (no `Origin`) or a local script may read.

## Pokélink themes

Switch on the **Pokélink bridge** on the Stream page. souldew then also listens on `127.0.0.1:3000` (port configurable) and speaks the socket.io protocol the themes from [pokelink-web-sources](https://github.com/pokelinkapp/pokelink-web-sources) expect (socket.io-client 2.x, Engine.IO 3). Open a theme with the ending shown on the Stream page instead of its own `?user=…`, e.g. `index.html?user=Robin&server=http://127.0.0.1&port=3000`; `user` is the player's name or `p1`–`p5`. Like the overlays it follows the current run, unless a run is pinned in the Stream page's **Run** menu. Events:

- `client:players:list` on connect: `[{ id, username, party: [{ slotId: 1–6, pokemon | null }], trainer: { name, game: { id: "POKEMON HG", friendlyName, generation }, badges: [{ name: "Zephyr", value: 0|1 }] } }]`
- `client:party:updated` `{ id, username, update: { party } }` and `player:trainer:updated` `{ id, username, trainer }` when something changes for that player
- `player:party:death` `{ username, pokemon }` when a Pokémon goes to the graveyard
- `pokemon`: `pid, species, speciesName` (English – themes build the sprite name from it), `nickname, level, hp: { current, max }, isShiny, isEgg, isFemale, isGenderless` (0/1), `heldItem` (the game's item ID), `status: { psn, slp, par, frz, brn }`, `dead, types: [{ label }], move1`–`move4: { name, type }, locationMet` (area name). Values souldew doesn't read (EXP, nature, ability, IVs/EVs, Pokérus) come empty or 0.

Allowed are themes opened from disk (`file://`, or OBS's **Local file** – how OBS runs a downloaded or custom theme) and from Pokélink's own sites (`*.pokelink.xyz`, `pokelink.app`, `pokelinkapp.github.io`); other websites get no readable answer. A theme served by another web server on this computer (`http://localhost:<port>`, e.g. a theme you develop with a local dev server) needs the switch **Also themes from another web server on this computer** on the Stream page – off by default, so other programs' local web pages can't read your teams. If Pokélink itself is running, port 3000 is taken – close it or pick another port in souldew.

What the bridge hands out is meant for the stream: names, teams (in a randomized run that shows what each player got), levels, HP, moves, items, badges and deaths. Never room keys, invite codes, device IDs, file names or folders.
