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

The whole game runs in one script closure holding **973 variables**, enumerable live:

1. `Runtime.evaluate` any exposed global function (`globalQuitGame`, `resizeApp`,
   `clickNetworkMethod1` …) to get an `objectId`
2. `Runtime.getProperties` with `ownProperties: false` → `internalProperties` →
   `[[Scopes]]`
3. Scope 0 is `Script` with all 973 variables and their live values

At the main menu the scope holds 473 numbers, 414 strings, 60 functions, 2 arrays,
9 DOM nodes and `app` (the PIXI Application) — no fighter objects, because no match is
running. **Mapping the fighter state to variable names has to be done with a match live,
and is the main open task.**

Pre-load hooks also work: `Page.addScriptToEvaluateOnNewDocument` runs before `px.js`, and a
setter trap on `window.PIXI` successfully captured the `PIXI.Application` instance and its
stage (verified: 1 stage child, 8 nodes deep at the menu). This gives a second, cruder
state source — sprite positions from the display list — if closure mapping proves painful.

## VERIFIED — the game ships its complete frame data in plain text

`resources/app/_res_data/*.txt` are the classic LF2 data files, unencrypted. See
[04-lf2-data-format.md](04-lf2-data-format.md). This is why the reflex layer needs no
computer vision: every attack's hitbox, damage, knockback and timing is a table lookup
keyed on the opponent's current frame id.

## MEASURED — latency, 2026-09-18, from this machine

| Route | Measurement | Implication |
|---|---|---|
| `api.typesafe.ai` TCP connect | 199–205 ms | raw network RTT |
| `api.typesafe.ai` warm POST, auth-error path | 201–212 ms TTFB | ≈ pure RTT, no inference |
| Cloudflare edge TCP connect | 43 ms | for later comparison |
| Cloudflare control-plane API, warm | 245–400 ms TTFB | worse than direct |

Direct to TypeSafe costs **~200 ms of network before Jev thinks**. With their stated
70–500 ms inference that is **~270–700 ms per decision → 1.4–3.7 decisions/sec**. Their
Doom demo's ~10 decisions/sec was presumably run near the model.

**Design the loop for ~3 Hz.** Re-measure with a real key; the auth-error path may skip
work a real request performs.

## Third-party claims — NOT verified

From TypeSafe's own material: 70–500 ms end-to-end, ~10 decisions/sec in the Doom demo at
~$7/hour, $42 per billion input tokens with output free, 0.114 s on their benchmark task.
Their published evals cover security triage, invoice processing, support routing and agent
observability. **No spatial, geometric, game or real-time control benchmark exists.**
Whether Jev handles the spatial judgement in a fighting game is an open question this repo
is partly built to answer.
