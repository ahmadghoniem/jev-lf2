# Findings

Everything here was verified on this machine unless marked otherwise. Measurements are
dated because both the game build and the TypeSafe service can change.

## The game is an Electron app

`lf2.exe` is Electron 30.5.1 / Chromium 124 with a PixiJS 7.4.0 renderer. Game logic lives
in `resources/app/g.js`, obfuscated with an encrypted string table and loaded by a custom
loader in `px.js` (PixiJS bundle + loader). Static analysis of `g.js` is impractical;
runtime introspection is easy.

Game path (renamed 2026-09-18): `C:\LF2-Remastered\LF2-Remastered(The Game)\`

## VERIFIED — the remote debugging port works

```
lf2.exe --remote-debugging-port=9222
```

`http://127.0.0.1:9222/json/list` returns the page target. The obfuscator's
debugger-protection only triggers when the CDP **Debugger** domain is enabled or DevTools is
opened. Using only **Runtime**, **Page** and **Input** avoids it entirely.

## VERIFIED — synthetic key injection reaches the game

`Input.dispatchKeyEvent` with `code: "Numpad4"` was received by the page's own `keydown`
listener as `["Numpad4", true]` — `isTrusted: true`. The game cannot distinguish it from a
real key press.

The main process appends `disable-background-timer-throttling`,
`disable-renderer-backgrounding` and `disable-backgrounding-occluded-windows`, so the game
keeps running at full speed while its window is in the background.

## VERIFIED — player slots are just key sets

`localStorage["PoeS*z@y"]`, `©`-separated, 4 slots × 10 `KeyboardEvent.code` values:

| Slot | up | down | left | right | attack | jump | defend | +3 unused |
|---|---|---|---|---|---|---|---|---|
| P1 | ArrowUp | ArrowDown | ArrowLeft | ArrowRight | Enter | ShiftRight | Quote | None ×3 |
| P2 | KeyW | KeyX | KeyA | KeyD | KeyS | Tab | Backquote | None ×3 |
| P3 | Numpad8 | Numpad2 | Numpad4 | Numpad6 | Numpad5 | Numpad0 | NumpadAdd | None ×3 |
| P4 | KeyI | Comma | KeyJ | KeyL | KeyK | Space | Period | None ×3 |

Column order is inferred from the classic LF2 layout and should be confirmed in the key
config screen before relying on it.

**Consequence:** Jev's character is an ordinary human slot. Bind it to codes nobody
touches (F13–F24 are ideal — no physical key produces them) and the game needs no
modification at all.

## VERIFIED — game state is reachable

Two routes, both without enabling the Debugger domain:

1. The **script scope** — 972 variables reachable through the `[[Scopes]]` of any
   function the page defined. It holds every class constructor, `app` and
   `pixiGameScene`, but no fighters.
2. The **entity pool** — 400 slots found by `Runtime.queryObjects` on a class
   prototype. This is where the fighters, weapons and projectiles live.

Full method, the class map and the field meanings are in
[05-live-state.md](05-live-state.md).

A pre-load hook also works — `Page.addScriptToEvaluateOnNewDocument` runs before
`px.js`, and a setter trap on `window.PIXI` captured the `PIXI.Application` and
its stage. It turned out to be unnecessary: the display list is rendering only,
with no game state attached.

## VERIFIED — the game ships its complete frame data in plain text

`resources/app/_res_data/*.txt` are the classic LF2 data files, unencrypted. See
[04-lf2-data-format.md](04-lf2-data-format.md). This is why the reflex layer needs no
computer vision: every attack's hitbox, damage, knockback and timing is a table lookup
keyed on the opponent's current frame id.

## MEASURED — latency and cost

Network round trips, 2026-09-18:

| Route | Measurement |
|---|---|
| `api.typesafe.ai` TCP connect | 199–205 ms |
| Cloudflare edge TCP connect | 43 ms |
| Cloudflare control-plane API, warm | 245–400 ms TTFB |

End-to-end with a real key, 2026-09-19: **328 ms warm, 723–839 ms cold**, 574
input tokens for a small state with two questions. Numbers and their consequences
are in [02-jev-integration.md](02-jev-integration.md#measured-behaviour).

**The Jev layer runs at about 2 Hz.** Everything time-critical is local.

## Third-party claims — NOT verified

TypeSafe publish evals for security triage, invoice processing, support routing
and agent observability. **No spatial, geometric, game or real-time control
benchmark exists.** Whether Jev handles the spatial judgement in a fighting game
is an open question this repo is partly built to answer.

## MEASURED — the damage that lands comes from thrown weapons, not swings

Attributing every HP loss in the recorded runs to the enemy's stance said the enemy
was `recovering` for 44-47 of the hits in a loss, which cannot be true of a swing.
It is true of a throw: the weapon is already travelling while the fighter recovers,
and nothing in the entity says so. LF2 keeps projectiles in the same entity pool as
the weapons lying on the ground ([05-live-state.md](05-live-state.md)), so an
incoming knife read as a pickup to walk over.

The distance to the nearest item at the moment damage lands separates the two
explanations cleanly:

| Run | min item range at hits (p50 / p25) | min item range at all other ticks (p50 / p25) |
|---|---|---|
| 21-35-34 | 32 / 18 | 61 / 35 |
| 21-54-41 | 18 / 9 | 65 / 34 |
| 22-10-04 | 21 / 10 | 56 / 33 |

A weapon is essentially on top of us when we take damage, and far away when we do
not. `rudolf_weapon` is in the read at 54/54, 50/50 and 60/61 of the hits.

Flight is read from motion — an item whose position changed since the previous read
is in the air — because no field marks it. Replaying the logs with that rule (from
range deltas, and only the three items the log records), a closing weapon was within
110 units in the ten ticks before 44/54, 51/61 and 34/50 of the hits taken. See
`createItemMotion` in `src/state/arena.mjs`, `inboundWeapon` in
`src/executor/reflex.mjs`, and `scripts/check-dodge.mjs` for its behaviour.

## FIXED — a weapon in flight was being claimed as one in our hands

`held` is inferred from motion, and the inference was drawn from every read. It
needs two things to line up: the weapon is close in `x`, and its offset to us has
not changed. Standing still, a weapon on the ground has exactly the offset a
carried one has, so the second test passes for free. One loss run records Jev
`holding rudolf_weapon` for 203 ticks with 152 changes of mind, and the moment
that reads is the moment a thrown knife arrives:

```
tick 144  holding null             rudolf_weapon#51 r47
tick 145  holding null             rudolf_weapon#51 r23     <- arriving
tick 146  holding rudolf_weapon    (weapon gone from the ground list)
```

So Jev was told he was armed with the knife the enemy had just thrown at him, and
the ground list — and with it the projectile alert — lost the weapon at exactly
the range where blocking happens. `createHeldTracker` now revises its verdict only
when our own displacement makes carried and ground distinguishable, and keeps the
last verdict otherwise. The tick log records `dx`/`dz`/`inFlight`/`closing` per
item so the next run can be checked on this directly.

Also worth recording: the first coverage figure printed for this was wrong. The
script advanced each item's previous range *before* measuring the delta, so every
thrown weapon read as stationary and the projectile count came out as 0/54. The
numbers above are from the corrected pass.

The same data says the punish option was lying about its window. Across the loss
runs, `rush_attack` was offered on 844 / 1059 / 583 ticks, but only 111 / 270 / 128
of those were against a genuinely locked enemy — the other 75-87% were a
`recovering` fighter, which is exactly the frame after a throw. Of the offered
windows, 200 / 218 / 160 had a weapon closing within 110 units. `rush_attack` now
requires a window nothing is arriving into, and says which of the two it is.

**Unverified in play:** the game was closed before these changes could be run.
The two numbers to calibrate on the first run are `FLIGHT_SLACK` (how far an item
must move between reads to count as thrown) and `PROJECTILE_BLOCK_RANGE` (where
blocking beats stepping aside) — both in `src/state/arena.mjs`.
