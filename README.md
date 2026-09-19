# jev-harness

A control harness that lets **Jev** (TypeSafe's System One model) play a character in
**Little Fighter 2 Remastered**, alongside human players and the game's own COM bots —
and a measurement rig to find out whether Jev plays better than the COM.

## Status

| | |
|---|---|
| Phase | 0 — the harness plays. Measurement and tuning next. |
| Jev integration | client written, verified live, and in the decision seat |
| Game route | direct TypeSafe API only. Cloudflare Workers AI deferred. |

Jev plays a character. The executor reads the arena 30 times a second, prices
every action that is genuinely available, asks Jev which one to take about twice
a second, and presses the keys — on a player slot bound to F13–F19, which no
physical keyboard can reach, so the humans' slots are untouchable. Every tick is
logged with the layer that produced it.

Still open: the heuristic control arm and Jev have not been compared over enough
matches to say anything, special moves are not executable yet, and the reflex
layer has not been validated.

## What this is

Three layers, deliberately separated:

1. **Executor (local, 30 Hz)** — reads game state, runs reflexes, presses keys with frame
   accuracy. Owns everything that is a calculation or a timing problem.
2. **Jev (remote, ~2 Hz)** — answers typed questions about the current situation. Owns
   everything that is a judgement call.
3. **Telemetry + experiments** — logs every tick so runs can be compared and so new
   question schemas can be replayed against recorded states without playing again.

The split exists because TypeSafe's own docs say Jev is unreliable at arithmetic, counting
and numeric comparison. Geometry never reaches the model; it reaches the model as words.

## Layout

```
docs/     findings, architecture, API notes, experiment protocol, data format,
          live state
src/      harness source
  lf2data/  parser for the game's plain-text frame data
  cdp/      DevTools protocol client for the shipped game
  state/    live entity reader, arena view, option builder, field names
  executor/ the loop, key state, action planner, reflexes, policies
  jev/      Jev client, scoped from the official SDK
  telemetry/  run logging
scripts/  tools — launcher, key binding, probes, data extraction, play, reports
bench/    measurements that settled a design decision
build/    parsed frame tables (generated, not committed)
runs/     scope snapshots and telemetry (generated, not committed)
```

## Prerequisites

- Node 24+ (verified: v24.19.0). No runtime dependencies.
- The game at `C:\LF2-Remastered\LF2-Remastered(The Game)\lf2.exe`
- `TYPESAFE_API_KEY` in `.env` (gitignored; `.env.example` shows the shape)
- **The game window has to be on screen.** Chromium stops the frame loop for a
  window it is not painting, and the game stops with it. A second monitor is
  fine.

## Try it

```
node scripts/build-move-tables.mjs          # parse the game data, build profiles
node scripts/launch-game.mjs                # start the game with the CDP port open
node scripts/bind-keys.mjs --assign P4 --from F13 --reload   # give the harness a slot
node scripts/entity-dump.mjs                # every entity in a live match
node scripts/ask-jev.mjs --character henry  # build the options and let Jev choose
```

Then start a VS match with P4 joined (its attack key is now `F17`) and some
computer players, and hand the slot over:

```
node scripts/play.mjs --name Deep --policy heuristic --seconds 90 --fresh
node scripts/play.mjs --name Deep --policy jev       --seconds 90 --fresh
node scripts/report-run.mjs runs/<a> runs/<b>
```

`scripts/bind-keys.mjs --restore --reload` puts the original keys back.

## Start here

- [docs/00-findings.md](docs/00-findings.md) — what has actually been verified, with measurements
- [docs/01-architecture.md](docs/01-architecture.md) — the three layers, who decides what, per-character strategy
- [docs/05-live-state.md](docs/05-live-state.md) — how the arena is read out of a running match
- [docs/06-executor.md](docs/06-executor.md) — how the loop plays without ever waiting on the network
- [docs/03-experiments.md](docs/03-experiments.md) — the phases, the metrics and what gets logged
