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
