# Architecture

## Three layers

```
  ┌─────────────────────────────────────────────┐
  │ lf2.exe --remote-debugging-port=9222        │
  │   Electron 30 / Chromium 124 / PixiJS 7.4   │
  └───────────▲─────────────────────┬───────────┘
       CDP Input.dispatchKeyEvent   │ CDP Runtime.getProperties
              (keys, isTrusted)     │ ([[Scopes]] → 973 vars)
  ┌───────────┴─────────────────────▼───────────┐
  │ EXECUTOR — local, 30 Hz                     │
  │  • state reader        • frame-data lookup  │
  │  • reflexes (block, dodge, anti-whiff)      │
  │  • macros (combos, dash attacks, throws)    │
  │  • telemetry writer                         │
  └───────────▲─────────────────────┬───────────┘
      typed answers (~3 Hz)         │ semantic state, ~600 tokens
  ┌───────────┴─────────────────────▼───────────┐
  │ JEV — api.typesafe.ai/v1/systemone           │
  │  choice / noul / score, one request per tick │
  └─────────────────────────────────────────────┘
```

## Who decides what

The division is not a style preference. TypeSafe's own known-issues page for Jev 1.13 says
the model is unreliable at math and counting, poor with raw numeric representations and
numeric comparison, cannot interpolate scores into real magnitudes, and is distracted by
large irrelevant state. So:

**Code owns** — anything that is a calculation or a deadline:

- distances, facing, whether a target is inside an attack's reach
- frame lookups: is a hitbox live, how many ticks until one is
- damage arithmetic, MP costs, cooldowns
- combo execution (`hit_Fa` chains are frame-timed input sequences)
- reflexes that must fire inside 100 ms: block an incoming hit, avoid whiffing
- item routing once a decision is made: walk there, press attack, drink

**Jev owns** — anything that needs judgement across competing considerations:

- which enemy to focus
- commit to an attack now or reposition
- is it worth breaking off to grab that weapon or drink that milk
- how aggressive to be given HP, MP, crowding and the phase
- when to disengage

**Jev is never asked** — "how far is the enemy", "which weapon does more damage", "do I have
enough MP". Code already knows, exactly.

## State design

The state sent to Jev is **semantic, not numeric**. Every geometric fact is converted to a
named bucket before it leaves the executor:

```jsonc
{
  "me":   { "character": "davis", "hp": "healthy", "mp": "full",
            "holding": "none", "stance": "standing", "facing": "right" },
  "threats": [
    { "id": "e1", "distance": "in_range", "side": "front",
      "doing": "winding_up_attack", "hp": "low" },
    { "id": "e2", "distance": "one_dash", "side": "behind",
      "doing": "approaching", "hp": "healthy" }
  ],
  "items": [ { "what": "milk", "distance": "one_dash", "contested": true } ],
  "phase": { "enemies_left": 4, "ally_status": "healthy" },
  "recent": { "last_action": "dash_attack", "outcome": "hit" }
}
```

Rules that follow from the known-issues page:

- no raw coordinates, HP numbers, or millisecond values
- only the nearest 2–3 threats, never all eight (large irrelevant state distracts)
- `recent` carries short memory, because each Jev request is independent and cannot see
  the previous answer
- inferred facts stay separate from observed facts

## Question set

One request per tick carrying several independent questions — the skill's guidance is to ask
independent questions together, since they evaluate in parallel and add little latency.
Draft set, to be tuned by experiment:

| id | type | what it decides |
|---|---|---|
| `action` | choice | advance / retreat / attack / jump_attack / dash_attack / special_ranged / special_close / defend / grab_item / disengage |
| `target` | choice | which threat id, built dynamically from the live list |
| `aggression` | score | how much risk to accept this second |
| `break_off` | noul | worth leaving the fight for the item |

Every choice question includes a no-match option. Confidence gates the risky branches:
commit MP to a special only above a threshold, otherwise fall through to the executor's
heuristic.

## Input path

Jev's character is an ordinary player slot bound to keys nobody presses — F13–F24 have no
physical key on a normal keyboard, which removes any chance of interfering with the humans
playing on P1/P2. The executor sends `Input.dispatchKeyEvent` with those codes; the game
receives them as trusted key events.

No patching of the game, no memory writing, no injected mods.

## Failure handling

The network is the fragile part. On 429, 529, timeout, or anything slower than one tick
budget, the executor **keeps playing on reflexes alone** and logs the gap. A dropped Jev
answer degrades the policy; it never freezes the character.
