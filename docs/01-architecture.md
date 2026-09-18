# Architecture

## Three layers

```
  ┌─────────────────────────────────────────────┐
  │ lf2.exe --remote-debugging-port=9222        │
  │   Electron 30 / Chromium 124 / PixiJS 7.4   │
  └───────────▲─────────────────────┬───────────┘
       CDP Input.dispatchKeyEvent   │ CDP Runtime.queryObjects
              (keys, isTrusted)     │ → the 400-slot entity pool
  ┌───────────┴─────────────────────▼───────────┐
  │ EXECUTOR — local, 30 Hz                     │
  │  • state reader        • frame-data lookup  │
  │  • reflexes (block, dodge, anti-whiff)      │
  │  • option builder      • macros             │
  │  • telemetry writer                         │
  └───────────▲─────────────────────┬───────────┘
      typed answers (~2 Hz)         │ semantic state + options
  ┌───────────┴─────────────────────▼───────────┐
  │ JEV — api.typesafe.ai/v1/systemone           │
  │  choice / noul / score, one request per tick │
  └─────────────────────────────────────────────┘
```

How the state is actually reached is in [05-live-state.md](05-live-state.md).

## Who decides what

The split is not "code thinks, Jev obeys". Code does the arithmetic and hands
Jev **every option that is genuinely available, described in words** — including
what each one hits for and what it risks. Which option to take is the judgement,
and judgement is Jev's.

That is the whole point of the tiers in `src/lf2data/profile.mjs`: a baseball
bat's dash swing arrives as *"the heaviest swing, and the slowest to recover
from — damage is huge, risk is high"*, not as `injury: 100`. Jev compares
descriptions, so it never has to subtract two numbers, and it still makes the
call about whether the bat beats the crossbow here.

**Code owns** — the measurements and the deadlines:

- distances, facing, which attacks currently reach
- frame lookups: is a hitbox live, how many ticks until one is
- pricing each option: damage tier, MP tier, reach, risk
- combo execution — `hit_*` chains are frame-timed input sequences
- reflexes that must fire inside 100 ms: block an incoming hit, avoid whiffing
- carrying out a decision: walk there, press attack, drink

**Jev owns** — every choice between competing options:

- which of the available attacks to use, including weapon versus bare hands
  versus a ranged move
- whether a weapon on the ground is worth crossing the stage for
- which enemy to focus
- commit now or reposition
- how aggressive to be given HP, MP, crowding and the phase
- when to disengage

**Jev is never asked** to compute. Not "how many units away is the enemy" or
"is 85 more than 60" — those are already answered before the request is built.
The reasons are in [02-jev-integration.md](02-jev-integration.md#known-issues-in-jev-113-that-hit-this-project).

## Character-aware strategy

An archer that walks into punching range is playing itself badly, so strategy
has to vary by character. None of it is hand-written: the differences are
already in the frame data, and `src/lf2data/profile.mjs` derives them.

A move is **ranged** when its opoint launches something that travels. Its
**reach** is how far its damaging itr extends past the fighter's own hurt box.
Its **damage** is its itr's injury, or for a projectile, the projectile's. The
archetype then follows from one fact — what the plain attack button does from
standing:

| archetype | rule | characters |
|---|---|---|
| `ranged` | the basic attack fires a projectile | Henry, Hunter |
| `mixed` | ranged moves exist but cost MP | Davis, John, Firen, Freeze, Louis, … |
| `melee` | no ranged move at all | Bandit, Deep, Knight, Jan, Mark, Firzen |

Henry's punch costs 12 MP and fires an arrow, so his profile gives him no
reason to close distance and the option builder never offers *close_distance*
as the obvious play. Bandit's punch is a punch. Both fall out of the same code.

Weapon damage is deliberately **not** in the profile. No character frame carries
it — a swing's frames hold no itr at all, and the hit comes from the weapon
object's own `<wsl>` table. So what a weapon is worth is only knowable once one
is in hand, and it is priced at run time from `build/_weapons.json`.

Phase 1 runs one character to keep the comparison clean. The profiles mean that
is a choice, not a limitation.

## State design

The state sent to Jev is **semantic, not numeric**. Every geometric fact becomes
a named bucket before it leaves the executor:

```jsonc
{
  "me":   { "character": "henry", "archetype": "ranged",
            "hp": "healthy", "mp": "full", "holding": "none",
            "stance": "standing", "facing": "right" },
  "threats": [
    { "id": "e1", "distance": "one_dash", "side": "front",
      "doing": "winding_up_attack", "hp": "low" },
    { "id": "e2", "distance": "far", "side": "behind",
      "doing": "approaching", "hp": "healthy" }
  ],
  "items": [ { "what": "baseball bat", "distance": "one_step", "contested": true } ],
  "phase": { "enemies_left": 4, "ally_status": "healthy" },
  "recent": { "last_action": "ranged_punch", "outcome": "hit" }
}
```

Rules:

- no raw coordinates, HP numbers, or millisecond values
- only the nearest 2–3 threats, never all eight
- `recent` carries short memory, because each request is independent and cannot
  see the previous answer
- inferred facts stay separate from observed facts

## Question set

One request per tick carrying several independent questions — they evaluate in
parallel and add little latency. Draft set, to be tuned by experiment:

| id | type | what it decides |
|---|---|---|
| `action` | choice | built live by `src/state/options.mjs` from what is actually available |
| `target` | choice | which threat id, built from the live list |
| `aggression` | score | how much risk to accept right now |
| `commit` | noul | is this the moment to commit to an attack |

Every choice question includes a no-match option. Confidence gates the risky
branches: spend MP on a special only above a threshold, otherwise fall through
to the executor's heuristic.

## Input path

Jev's character is an ordinary player slot bound to keys nobody presses — F13–F24
have no physical key on a normal keyboard, so there is no chance of interfering
with the humans on P1/P2. The executor sends `Input.dispatchKeyEvent` with those
codes and the game receives them as trusted key events.

Menu input needs a key held for about 150 ms; at 70 ms roughly half the presses
were dropped. In-fight input is sampled per frame and does not need that.

No patching of the game, no memory writing, no injected mods.

## Failure handling

The network is the fragile part, and it is slower than the first estimate:
measured round trips are **328 ms warm and up to 839 ms cold**, so the Jev layer
runs at roughly 2 Hz, not 3.

A live call gets one attempt and a hard deadline — no retries, because a retry
that lands 500 ms late answers a question about a fight that has moved on. On a
miss, a 429, a 529 or a timeout, the executor **keeps playing on reflexes** and
logs the gap with `source: "reflex"`. A dropped answer degrades the policy; it
never freezes the character.

Retries live only in the offline replay path, where nothing is waiting.
