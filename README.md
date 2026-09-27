# jev-harness

Lets **Jev** (TypeSafe's System One model) play a fighter in **Little Fighter 2
Remastered** against the game's CPU, and logs every tick so games can be compared.
The code is the documentation: each module and script explains itself in its
header comment.

## Prerequisites

- Node 24+. No runtime dependencies.
- The game at `C:\LF2-Remastered\LF2-Remastered(The Game)\lf2.exe`
- `TYPESAFE_API_KEY` in `.env` (gitignored; `.env.example` shows the shape)
- **The game window has to be on screen.** Chromium stops the frame loop for a
  window it is not painting, and the game stops with it. A second monitor is
  fine.

## Run

```
node scripts/build-move-tables.mjs    # parse the game data into build/
node scripts/launch-game.mjs          # start the game with the CDP port open
node scripts/series.mjs --fighter Henry --vs Rudolf --games 2 --difficulty difficult
```

Only one `play.mjs` may drive the game at a time; a second one exits at once.
