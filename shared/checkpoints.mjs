// Checkpoints – "save states" of a whole run (rule `checkpoints`, off unless a run switches it on). Every computer keeps
// a copy of its own player's game – battery save and "where you left off" (server/lib/checkpoints.mjs) – and of the run
// document the moment THAT player reaches a milestone: their first Poké Balls (with "Nothing counts before your first
// Poké Balls"), then each new badge. Once every player has reached one, it is a checkpoint. Any player can take the run
// back to the latest checkpoint: every player's game goes back to the moment they themselves reached it – a player who
// was ahead returns to just after their own badge, not to where they were when the last of them got there.
//
// The board follows: what belongs to one player (their encounters, team, bonus Pokémon, badges, …: ownerOf) comes back
// from that player's own copy of the document; the rest from the document as it stood when the checkpoint was complete.
// A group's death is shared – it stands when the Pokémon that fell went down before its own player's moment (that
// player's game still has it fainted) and is undone when it went down after (their game goes back to before it fell).
//
// In the run document (web/lib/doc.mjs, a last-writer-wins map – every computer writes the same keys, so two writing
// at once is harmless):
//   cp:at:<id>          a checkpoint is complete (everyone reached it): { id, kind: 'balls' | 'badge', n, at }
//   cp:have:<id>:<slot> that player's computer keeps a copy of their game from the moment they reached `id`:
//                       { at, late? } – for checkpoint N a player's copy is their first one of N or later (copyFor: a
//                       player whose badges jumped from 1 to 3 has one of 3); late: taken only when N was complete
//   cp:reset            the last "go back": { rid, id, at, by } – the one who goes back writes the board (planReset) in
//                       the same change
//   cp:done:<slot>      that player's game went back for `rid`: { rid, at, ok } – their computer has also put their own
//                       part of the board back (ownPlan)
// Until a player's own computer has done that, nothing their game shows counts (pendingReset): it is the game from
// after the checkpoint, still running or not closed yet.
//
// Pure – the app (web/lib/checkpoints.mjs) and the tests use it.

export const RESET_KEY = 'cp:reset';
export const atKey = (id) => `cp:at:${id}`;
export const haveKey = (id, slot) => `cp:have:${id}:${slot}`;
export const doneKey = (slot) => `cp:done:${slot}`;

/** Checkpoint ids: 'balls', 'badge1' … 'badge24' (Gen 2 has 16 badges; hacks may have more). */
export const ID_RE = /^(balls|badge([1-9]|1\d|2[0-4]))$/;
export const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const SLOT_RE = /^p[1-5]$/;

/** Order of checkpoints: the first Poké Balls (0), then the badge count. */
export function rankOf(id) {
  if (id === 'balls') return 0;
  const m = /^badge(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : -1;
}
const idOfRank = (rank) => (rank === 0 ? 'balls' : `badge${rank}`);
const milestone = (rank) => ({ id: idOfRank(rank), kind: rank === 0 ? 'balls' : 'badge', n: rank, rank });

/** A copy taken this long after the checkpoint was complete counts as `late` (the board says so). */
export const LATE_MS = 2 * 60000;

/**
 * The run document's keys that go back with a checkpoint: what the games' progress decides – encounters and deaths,
 * bonus Pokémon, ignored and held ones, bosses, cap breaks, when the rules started, the live teams, Pokémon Center
 * visits, raid and Play-together marks, the areas made for catches, whether the run is over. The rest stays: the rules,
 * names, the log (it keeps what happened – and that the run went back), where everyone is, link battles.
 */
export const RESTORE_PREFIXES = ['pair:', 'enc:', 'extra:', 'ign:', 'held:', 'boss:', 'capbreak:', 'balls:', 'live:', 'party:', 'simport:', 'center:', 'raidspared:', 'tomb:', 'area:'];
export const RESTORE_KEYS = ['run:status', 'run:resumed'];
export const restorable = (key) => RESTORE_KEYS.includes(key) || RESTORE_PREFIXES.some((p) => key.startsWith(p));

// whose a key is: enc:<area>:<slot> – the others <prefix><slot>[:…]
const OWN_PREFIXES = ['extra:', 'ign:', 'held:', 'capbreak:', 'tomb:', 'live:', 'party:', 'balls:', 'center:', 'raidspared:', 'simport:'];
/** The player a restorable key belongs to (their encounter, team, bonus Pokémon …), or null for the run's own keys. */
export function ownerOf(key) {
  let s = null;
  if (key.startsWith('enc:')) s = key.slice(key.lastIndexOf(':') + 1);
  else {
    const p = OWN_PREFIXES.find((x) => key.startsWith(x));
    if (p) s = key.slice(p.length).split(':')[0];
  }
  return s && SLOT_RE.test(s) ? s : null;
}

/** The part of a document's entries ({ key: { v, t, by } }) a checkpoint keeps. */
export function snapshotOf(entries) {
  const out = {};
  for (const [k, e] of Object.entries(entries || {})) if (restorable(k) && e && typeof e === 'object') out[k] = { v: e.v ?? null, t: e.t, by: e.by };
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const valueOf = (e) => (e && typeof e === 'object' ? e.v ?? null : null);
const diff = (target, cur) => {
  const writes = {};
  for (const [k, v] of Object.entries(target)) if (!same(valueOf(cur?.[k]), v)) writes[k] = v;
  return writes;
};

/**
 * The writes that put the board back to the document `snap` (its entries – null where a key didn't exist then).
 * `cur`: the document's entries now. Keys that already hold it are left.
 */
export function restoreWrites(snap, cur) {
  const target = {};
  for (const k of new Set([...Object.keys(snap || {}), ...Object.keys(cur || {})])) if (restorable(k)) target[k] = valueOf(snap?.[k]);
  return diff(target, cur);
}

/**
 * Group deaths and bonus Pokémon deaths in `values` ({ key: value }) whose Pokémon fell after its player's moment
 * (`moments` { slot: at }): alive again – that player's game goes back to before it fell. A death that doesn't say whose
 * Pokémon fell, or whose player has no moment, stands. → the changed values.
 */
export function revivals(values, moments) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!v || typeof v !== 'object') continue;
    if (k.startsWith('pair:') && v.state === 'dead') {
      const at = moments?.[v.by];
      if (Number.isFinite(at) && (v.diedAt || 0) > at) out[k] = { ...v, state: 'alive', diedAt: null, cause: '' };
    } else if (k.startsWith('extra:') && v.dead) {
      const at = moments?.[ownerOf(k)];
      if (Number.isFinite(at) && (v.diedAt || 0) > at) out[k] = { ...v, dead: false, diedAt: null };
    }
  }
  return out;
}

/**
 * The board for going back (written by whoever goes back): the document as it stood when the checkpoint was complete
 * (`snap`), the deaths after their players' moments undone. Each player's own part is put back by their own computer
 * (ownPlan) – it has their copy from their moment.
 */
export function planReset(snap, cur, moments) {
  const target = {};
  for (const k of new Set([...Object.keys(snap || {}), ...Object.keys(cur || {})])) if (restorable(k)) target[k] = valueOf(snap?.[k]);
  Object.assign(target, revivals(target, moments));
  // (a checkpoint is only complete while the run goes on – also when this computer kept its board only later)
  target['run:status'] = null;
  return diff(target, cur);
}

/**
 * What this computer's own player writes when their game went back: their own keys as in their own copy of the
 * document (`own` – its entries, from their moment), their group deaths after that moment undone (`moment`), and what
 * this device wrote from the old game after the go-back (`since`: its timestamp) back to the completed checkpoint's
 * document (`snap`, null when this computer has none). cur: the document's entries now.
 */
export function ownPlan({ own, snap = null, cur, slot, device, since, moment }) {
  const target = {};
  if (snap) {
    for (const [k, e] of Object.entries(cur || {})) {
      if (restorable(k) && ownerOf(k) !== slot && e?.by === device && e.t >= since) target[k] = valueOf(snap[k]);
    }
  }
  for (const k of new Set([...Object.keys(own || {}), ...Object.keys(cur || {})])) if (ownerOf(k) === slot) target[k] = valueOf(own?.[k]);
  const now = { ...Object.fromEntries(Object.entries(cur || {}).map(([k, e]) => [k, valueOf(e)])), ...target };
  const pairs = Object.fromEntries(Object.entries(now).filter(([k, v]) => k.startsWith('pair:') && v?.by === slot));
  Object.assign(target, revivals(pairs, { [slot]: moment }));
  return diff(target, cur);
}

/**
 * This computer's own writes that came after the "go back" (`since`: its timestamp) – made by its game before it heard
 * of it, from after the checkpoint: back to `snap`. Only entries this device wrote (`device` = their `by`), so the
 * others' progress since they went back is never touched.
 */
export function staleOwnWrites(snap, cur, device, since) {
  const writes = {};
  for (const [k, e] of Object.entries(cur || {})) {
    if (!restorable(k) || !e || e.by !== device || !(e.t >= since)) continue;
    const want = valueOf(snap?.[k]);
    if (!same(e.v, want)) writes[k] = want;
  }
  return writes;
}

/**
 * The milestone `slot` has reached by now, or null: { id, kind, n, rank } – their badge count where their game says it
 * (`live:<slot>`.badgesRead, at least 1), else their first Poké Balls (with the rule that marks them, `balls:<slot>`).
 */
export function ownMilestone(get, slot, rules) {
  const l = get(`live:${slot}`);
  if (l && l.badgesRead && Number.isInteger(l.badges) && l.badges >= 1) return milestone(Math.min(24, l.badges));
  return rules?.startAtBalls && get(`balls:${slot}`) ? milestone(0) : null;
}

/** The checkpoint every player has reached by now (the fewest of them – "everyone has 2 badges" → badge2), or null. */
export function reached(get, slots, rules) {
  if (!slots?.length) return null;
  let rank = Infinity;
  for (const s of slots) {
    const m = ownMilestone(get, s, rules);
    if (!m) return null;
    rank = Math.min(rank, m.rank);
  }
  return milestone(rank);
}

/** The checkpoints the document has: { id: { id, kind, n, at } }, from scan('cp:at:'). → the latest one, or null. */
export function latestOf(atScan) {
  let best = null;
  for (const [id, v] of Object.entries(atScan || {})) {
    if (!validId(id) || !v) continue;
    if (!best || rankOf(id) > rankOf(best.id)) best = { ...v, id };
  }
  return best;
}

/**
 * A new checkpoint to record now, or null: the rule is on, the run isn't over and every player has reached one past the
 * latest there is. (A run that switches the rule on later gets one at once – where everyone stands.)
 */
export function dueCheckpoint(get, atScan, slots, rules) {
  if (!rules?.checkpoints || get('run:status')) return null;
  const r = reached(get, slots, rules);
  if (!r) return null;
  const last = latestOf(atScan);
  return !last || r.rank > rankOf(last.id) ? r : null;
}

/** `slot`'s copies (scan('cp:have:') → { '<id>:<slot>': v }), lowest first: [{ id, rank, at, late }]. */
export function copiesOfSlot(haveScan, slot) {
  const out = [];
  for (const [k, v] of Object.entries(haveScan || {})) {
    const i = k.lastIndexOf(':');
    const id = k.slice(0, i);
    if (k.slice(i + 1) !== slot || !validId(id) || !v) continue;
    out.push({ id, rank: rankOf(id), at: Number(v.at) || 0, late: !!v.late });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** `slot`'s copy for a checkpoint of `rank`: their first one of that rank or later – or null. */
export const copyFor = (haveScan, slot, rank) => copiesOfSlot(haveScan, slot).find((c) => c.rank >= rank) || null;

/** Every player's copy for a checkpoint of `rank`: { slot: { id, rank, at, late } | null }. */
export const copiesFor = (haveScan, slots, rank) => Object.fromEntries(slots.map((s) => [s, copyFor(haveScan, s, rank)]));

/** Every player's moment for a checkpoint of `rank` (their copy's time): { slot: at } – those who have one. */
export function momentsOf(haveScan, slots, rank) {
  const out = {};
  for (const [s, c] of Object.entries(copiesFor(haveScan, slots, rank))) if (c) out[s] = c.at;
  return out;
}

/**
 * The copy `slot`'s computer should take now, or null: their milestone (`own`) is past every copy they have and not
 * below the latest checkpoint (`latestRank`, -1 for none) – a copy of that one is needed no more.
 */
export function copyDue(haveScan, slot, own, latestRank) {
  if (!own || own.rank < latestRank) return null;
  const mine = copiesOfSlot(haveScan, slot);
  return mine.length && mine.at(-1).rank >= own.rank ? null : own;
}

/** The "go back" that `slot`'s game still has to make, or null. get(key): the document's value. */
export function pendingReset(get, slot) {
  const r = get(RESET_KEY);
  if (!r || typeof r !== 'object' || typeof r.rid !== 'string' || !validId(r.id)) return null;
  return get(doneKey(slot))?.rid === r.rid ? null : r;
}

export const newResetId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
