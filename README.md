# jev-harness

A control harness that lets **Jev** (TypeSafe's System One model) play a character in
**Little Fighter 2 Remastered**, alongside human players and the game's own COM bots —
and a measurement rig to find out whether Jev plays better than the COM.

## Status

| | |
|---|---|
| Phase | 0 — live state reading works; input and telemetry next |
| Jev integration | not started (needs `TYPESAFE_API_KEY`) |
| Game route | direct TypeSafe API only. Cloudflare Workers AI deferred. |

Reading the arena out of a running match is done: fighters, weapons, projectiles,
their positions, their current frame and how far into it they are. See
[docs/05-live-state.md](docs/05-live-state.md).

## What this is

Three layers, deliberately separated:

1. **Executor (local, 30 Hz)** — reads game state, runs reflexes, presses keys with frame
   accuracy. Owns everything that is a calculation or a timing problem.
2. **Jev (remote, ~3 Hz)** — answers typed questions about the current situation. Owns
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
  state/    live entity reader
scripts/  tools — launcher, scope and entity probes, data extraction
build/    parsed frame tables (generated, not committed)
runs/     scope snapshots and telemetry (generated, not committed)
```

## Prerequisites

- Node 24+ (verified: v24.19.0)
- The game at `C:\LF2-Remastered\LF2-Remastered(The Game)\lf2.exe`
- `TYPESAFE_API_KEY` in `.env` (never committed)

## Start here

- [docs/00-findings.md](docs/00-findings.md) — what has actually been verified, with measurements
- [docs/01-architecture.md](docs/01-architecture.md) — the three layers and who decides what
- [docs/03-experiments.md](docs/03-experiments.md) — the phases and how Jev gets compared to the COM
