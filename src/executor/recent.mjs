/**
 * What Jev is told about the fight so far, beyond where things stand now.
 *
 *   null       nothing
 *   'action'   the last action chosen
 *   'outcome'  that, plus the action before it and the hp dealt and taken while
 *              it held the keys
 *   'hurt'     the last three hits taken: what hit, how hard, what the fighter
 *              was doing, how long ago
 *   'attack'   what became of the last attack Jev chose: landed, blocked, out
 *              of reach, cut off, and so on
 *
 * 'outcome' reports the action before the last one: the next question goes out
 * in the tick the last answer lands, so that answer has had no time to do
 * anything yet (a first version reporting "since the last action" read 0 s on
 * every decision). Even so, 77% of its windows were empty (863 of 1120
 * decisions): 0.3 s rarely holds a hit. 'hurt' and 'attack' report the last
 * event of any age instead, which was there for 96-97% of the decisions in 30
 * games (2026-09-28).
 *
 * None of them made Jev deal more damage. At 350 ms, 10 games each, hp dealt per
 * game was 242 ± 48 with 'hurt' and 261 ± 42 with 'attack', against 326 ± 35 and
 * 292 ± 37 in two runs with nothing. With 'hurt' Jev rolled away more (11% of
 * answers against 7%) yet took more hits (11.6 per 1000 ticks against 9.6 and
 * 10.4); with 'attack' it chose the same attack again about as often whatever
 * the result (15% after it landed, 17% after the enemy stayed out of reach).
 */
import { GROUPS } from '../state/nest.mjs';
import { plainName } from '../state/options.mjs';
import { DAMAGE_TIERS } from '../lf2data/profile.mjs';

const ATTACK_KINDS = GROUPS.filter((g) => g.name === 'special_move' || g.name === 'melee_attack');
const isAttack = (a) => ATTACK_KINDS.some((g) => g.match(a));
const HIT = 5;               // hp lost in one tick that is a hit, not drift
const HURT_KEPT = 3;
const SWING_TICKS = 10;      // about 0.33 s; cut off sooner, an attack may never have gone off
const LATE_TICKS = 10;       // a swing's hit can land a few ticks after its keys change
const SHOT_LATE_TICKS = 45;  // a special's ball is still flying for a while
const OUT_OF_REACH = 120;
const OFF_LINE = 20;

const tier = (n) => DAMAGE_TIERS.find((t) => n <= t.max).name;
const ago = (ms) => `${(ms / 1000).toFixed(1)} s ago`;

export function createRecent({ mode = null, policyName }) {
  let recent = {};
  let since = null;        // the last answer's start, for 'outcome'
  let last = null;         // the previous live tick's reading
  const hurt = [];         // newest first
  let attack = null;       // a Jev attack holding the keys
  let ending = null;       // one whose keys have gone, still waiting to land
  let judged = null;       // the last attack with a known result

  /** An answer has just taken the keys. */
  function applied(arena, action) {
    if (mode !== 'action' && mode !== 'outcome') return;
    const now = Date.now();
    let before = null;
    if (mode === 'outcome' && since) {
      const dealt = arena.threats.reduce((sum, t) => sum + Math.max(0, (since.foes.get(t.slot) ?? t.hp) - t.hp), 0);
      before = { action: since.action, seconds: Number(((now - since.atMs) / 1000).toFixed(1)),
                 you_dealt: dealt, you_took: Math.max(0, since.me - arena.me.hp) };
    }
    if (mode === 'outcome') {
      since = { action, atMs: now, me: arena.me.hp, foes: new Map(arena.threats.map((t) => [t.slot, t.hp])) };
    }
    recent = { last_action: action, ...(before && { before_that: before }) };
  }

  const judge = (a) => {
    const result = a.dealt ? `landed for ${tier(a.dealt)} damage`
      : a.hurt ? 'you were hit before it landed'
      : a.blocked ? 'the enemy blocked it'
      : a.minGap > OUT_OF_REACH ? 'the enemy stayed out of reach'
      : a.down > a.n / 2 ? 'the enemy was on the floor'
      : a.minZ > OFF_LINE ? 'the enemy was off your line, nearer or further in depth'
      : a.air > a.n / 2 ? 'the enemy was in the air'
      : a.n <= SWING_TICKS ? `cut off after ${(a.n / 30).toFixed(1)} s when ${a.endedBy} took over`
      : 'it missed';
    judged = { action: a.action, atMs: a.endMs, result };
  };

  /**
   * Once per live tick, before this tick changes the action: `action` and
   * `source` are what held the keys since the previous tick.
   */
  function observe(arena, { action, source }) {
    if (mode !== 'hurt' && mode !== 'attack') return;
    const now = Date.now();
    const foe = arena.threats[0];
    if (last) {
      const took = last.hp - arena.me.hp;
      const dealt = arena.threats.reduce((sum, t) => sum + Math.max(0, (last.foes.get(t.slot) ?? t.hp) - t.hp), 0);
      if (mode === 'hurt' && took >= HIT) {
        hurt.unshift({ atMs: now, took, by: last.cause, during: action, auto: source !== policyName });
        hurt.length = Math.min(hurt.length, HURT_KEPT);
      }
      if (mode === 'attack') {
        if (ending) {
          if (dealt >= HIT) ending.dealt += dealt;
          if (ending.dealt || --ending.lateLeft <= 0) { judge(ending); ending = null; }
        }
        const mine = source === policyName && isAttack(action);
        if (attack && (!mine || attack.action !== action)) {
          attack.endedBy = source === policyName ? 'your next answer' : `the automatic ${action}`;
          attack.endMs = now;
          if (ending) judge(ending);
          ending = attack;
          attack = null;
        }
        if (mine) {
          attack ??= { action, n: 0, dealt: 0, hurt: false, blocked: false, minGap: Infinity, minZ: Infinity,
                       down: 0, air: 0, lateLeft: action.startsWith('special_') ? SHOT_LATE_TICKS : LATE_TICKS };
          attack.n++;
          if (dealt >= HIT) attack.dealt += dealt;
          if (took >= HIT) attack.hurt = true;
          if (foe) {
            attack.minGap = Math.min(attack.minGap, foe.gap);
            attack.minZ = Math.min(attack.minZ, foe.zGap);
            if (foe.doing === 'blocking') attack.blocked = true;
            if (foe.doing === 'knocked_down') attack.down++;
            if (foe.doing === 'in_the_air') attack.air++;
          }
        }
      }
    }
    // What would be to blame for a hit that shows on the next tick.
    const shot = arena.flying[0];
    last = { hp: arena.me.hp, foes: new Map(arena.threats.map((t) => [t.slot, t.hp])),
             cause: shot ? `its ${plainName(shot.name)}` : 'its close attack' };
  }

  /** What goes into the state for the question being asked now. */
  function told() {
    const now = Date.now();
    if (mode === 'hurt') {
      return hurt.length ? { hurt_by: hurt.map((h) => `${h.by} hit you for ${tier(h.took)} damage during your `
        + `${h.auto ? 'automatic ' : ''}${h.during}, ${ago(now - h.atMs)}`) } : {};
    }
    if (mode === 'attack') {
      return judged ? { last_attack: `${judged.action}, ${ago(now - judged.atMs)}: ${judged.result}` } : {};
    }
    return recent;
  }

  return { applied, observe, told };
}
