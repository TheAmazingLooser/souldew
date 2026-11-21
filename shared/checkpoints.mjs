// Checkpoints – "save states" of a whole run (rule `checkpoints`, off unless a run switches it on). When every player
// has reached a milestone – their first Poké Balls (with "Nothing counts before your first Poké Balls"), then each
// badge everyone has – the run has a checkpoint: every computer keeps a copy of its own player's game as it is at that
// moment (battery save and "where you left off" – server/lib/checkpoints.mjs) and of the run document. Any player can
// take the run back to the latest checkpoint: every game goes back to its copy, and the board to how it stood then –
// the groups that died since are alive again, the catches since are gone, a run that ended goes on.
//
// In the run document (web/lib/doc.mjs, a last-writer-wins map – every computer writes the same keys, so two writing
// at once is harmless):
//   cp:at:<id>          a checkpoint was reached: { id, kind: 'balls' | 'badge', n, at } – id 'balls' or 'badge<n>'
//   cp:have:<id>:<slot> that player's computer keeps its copy: { at, late? } (late: it saw the checkpoint only later –
//                       its copy is of the game as it was then, which is the same when nobody played in between)
//   cp:reset            the last "go back": { rid, id, at, by } – the one who goes back also writes the board's keys
//                       (restoreWrites) in the same change
//   cp:done:<slot>      that player's game went back for `rid`: { rid, at, ok }
// Until a player's own computer has put their game back (cp:done), nothing that game shows counts (pendingReset): it is
// the game from after the checkpoint, still running or not closed yet.
//
// Pure – the app (web/lib/checkpoints.mjs) and the tests use it.

export const RESET_KEY = 'cp:reset';
export const atKey = (id) => `cp:at:${id}`;
export const haveKey = (id, slot) => `cp:have:${id}:${slot}`;
export const doneKey = (slot) => `cp:done:${slot}`;

/** Checkpoint ids: 'balls', 'badge1' … 'badge24' (Gen 2 has 16 badges; hacks may have more). */
export const ID_RE = /^(balls|badge([1-9]|1\d|2[0-4]))$/;
export const validId = (id) => typeof id === 'string' && ID_RE.test(id);

/** Order of checkpoints: the first Poké Balls (0), then the badge count. */
export function rankOf(id) {
  if (id === 'balls') return 0;
  const m = /^badge(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : -1;
}

/** A copy taken this long after the checkpoint was reached counts as `late` (the board says so). */
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

/** The part of a document's entries ({ key: { v, t, by } }) a checkpoint keeps. */
export function snapshotOf(entries) {
  const out = {};
  for (const [k, e] of Object.entries(entries || {})) if (restorable(k) && e && typeof e === 'object') out[k] = { v: e.v ?? null, t: e.t, by: e.by };
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const valueOf = (e) => (e && typeof e === 'object' ? e.v ?? null : null);

/**
 * The writes that put the board back to the checkpoint: every restorable key gets the value it had in `snap` (its
 * entries – null where the key didn't exist then). `cur`: the document's entries now. Keys that already hold it are left.
 */
export function restoreWrites(snap, cur) {
  const writes = {};
  const keys = new Set([...Object.keys(snap || {}), ...Object.keys(cur || {})].filter(restorable));
  for (const k of keys) {
    const want = valueOf(snap?.[k]);
    if (!same(valueOf(cur?.[k]), want)) writes[k] = want;
  }
  return writes;
}

/**
 * This computer's own writes that came after the "go back" (`since`: its timestamp) – made by its game before it heard
 * of it, from after the checkpoint: they go back too. Only entries this device wrote (`device` = their `by`), so the
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
 * The checkpoint every player has reached by now, or null: { id, kind, n, rank }. The first Poké Balls only with the
 * rule that marks them (`balls:<slot>`, rules.startAtBalls); badges only where every player's game says how many it has
 * (`live:<slot>`.badgesRead) – the fewest of them is the checkpoint ("everyone has 2 badges" → badge2).
 * get(key): the document's value.
 */
export function reached(get, slots, rules) {
  if (!slots?.length) return null;
  let best = null;
  if (rules?.startAtBalls && slots.every((s) => get(`balls:${s}`))) best = { id: 'balls', kind: 'balls', n: 0, rank: 0 };
  const counts = slots.map((s) => {
    const l = get(`live:${s}`);
    return l && l.badgesRead && Number.isInteger(l.badges) && l.badges >= 0 ? l.badges : null;
  });
  if (counts.every((c) => c !== null)) {
    const n = Math.min(24, ...counts);
    if (n >= 1) best = { id: `badge${n}`, kind: 'badge', n, rank: n };
  }
  return best;
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

/** The "go back" that `slot`'s game still has to make, or null. get(key): the document's value. */
export function pendingReset(get, slot) {
  const r = get(RESET_KEY);
  if (!r || typeof r !== 'object' || typeof r.rid !== 'string' || !validId(r.id)) return null;
  return get(doneKey(slot))?.rid === r.rid ? null : r;
}

/** Which players' computers keep their copy of checkpoint `id`: { slot: { at, late } | null }. */
export function copiesOf(get, id, slots) {
  return Object.fromEntries(slots.map((s) => [s, get(haveKey(id, s)) || null]));
}

export const newResetId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
