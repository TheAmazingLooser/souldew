// Checkpoints – "save states" of a whole run (shared/checkpoints.mjs, server/lib/checkpoints.mjs, web/lib/checkpoints.mjs):
//  1. when a checkpoint is due: the first Poké Balls of every player (with the rule that marks them), then the badge
//     count every player has – never twice, never while the run is over, only with the rule on;
//  2. going back: the board's keys return to the checkpoint (a group that died since is alive again, a catch since is
//     gone, a run that ended goes on, lives come back), the rest stays (rules, log); two computers converge – also when
//     one of them wrote from its old game before it heard of the go-back;
//  3. this computer's copy on disk: battery save, "where you left off" and the run document – kept, listed, put back
//     (what it replaced kept aside), the newest two checkpoints only, a 3DS save folder with its timestamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import {
  reached, dueCheckpoint, latestOf, restoreWrites, staleOwnWrites, pendingReset, snapshotOf, restorable, rankOf, validId,
  RESET_KEY, atKey, doneKey, haveKey, copiesOf,
} from '../shared/checkpoints.mjs';
import { storeCheckpoint, listCheckpoints, checkpointDoc, restoreCheckpoint, KEEP } from '../server/lib/checkpoints.mjs';
import { AUTO_SLOT, statePath } from '../server/lib/statefiles.mjs';
import { rulesWithDefaults, NEW_RUN_RULES, DEFAULT_RULES } from '../shared/rules.mjs';
import { SOULLINK_RULE_KEYS, soulLinkDefaults } from '../shared/hostrules.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const FIVE = { id: 'run5', mode: 'soullink', game: { code: 'IPKE', system: 'nds' },
  players: { p1: { name: 'Ana' }, p2: { name: 'Ben' }, p3: { name: 'Cem' }, p4: { name: 'Dia' }, p5: { name: 'Eli' } } };
const SLOTS = ['p1', 'p2', 'p3', 'p4', 'p5'];

function mkDoc(by, rules) {
  const d = new RunDoc('t');
  d.by = by;
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const getter = (d) => (k) => d.get(k, null);
/** Every entry of `from` into `to` (the sync, both ways when called twice). */
const sync = (a, b) => {
  b.merge(a.entries);
  a.merge(b.entries);
};
const liveWith = (badges) => ({ source: 'live', badges, badgesRead: true, party: [{ species: 25, hp: 20, maxHp: 20, area: 'r1' }], at: Date.now() });
const catchAll = (d, area, species = 16) => {
  for (const s of SLOTS) R.setEncounter(d, FIVE, area, s, { outcome: 'caught', species, key: `${area}-${s}` }, { quiet: true });
};

test('the rule: off for runs from before, on for a new run, in the host-signed SoulLink rules', () => {
  assert.equal(DEFAULT_RULES.checkpoints, false);
  assert.equal(NEW_RUN_RULES.checkpoints, true);
  assert.ok(SOULLINK_RULE_KEYS.includes('checkpoints'));
  assert.equal(soulLinkDefaults().checkpoints, true);
  assert.equal(rulesWithDefaults({}, 'soullink').checkpoints, false);
  // Play together never has checkpoints – not even when a doc says so
  assert.equal(rulesWithDefaults({ checkpoints: true }, 'together').checkpoints, false);
});

test('ids, ranks and which keys go back', () => {
  assert.ok(validId('balls') && validId('badge1') && validId('badge16') && validId('badge24'));
  assert.ok(!validId('badge0') && !validId('badge25') && !validId('../x') && !validId('Badge1') && !validId(''));
  assert.deepEqual(['badge2', 'balls', 'badge10', 'badge1'].sort((a, b) => rankOf(a) - rankOf(b)), ['balls', 'badge1', 'badge2', 'badge10']);
  for (const k of ['pair:r1', 'enc:r1:p3', 'extra:p1:k', 'live:p2', 'party:p4', 'balls:p5', 'boss:falkner', 'held:p1:r2', 'run:status', 'run:resumed', 'area:custom-1']) assert.ok(restorable(k), k);
  for (const k of ['rules', 'feed:x', 'player:p1', 'where:p1', 'cp:at:balls', RESET_KEY, 'run:restart', 'run:host', 'game:p1', 'lb:s:p1']) assert.ok(!restorable(k), k);
});

test('due: the first Poké Balls of everyone (with the rule), then the fewest badges – each once, newer ones only', () => {
  const d = mkDoc('a', { checkpoints: true, startAtBalls: true });
  const r = () => R.rules(d, FIVE);
  const due = () => dueCheckpoint(getter(d), d.scan('cp:at:'), SLOTS, r());
  assert.equal(due(), null);
  for (const s of SLOTS.slice(0, 4)) d.set(`balls:${s}`, { at: 1, how: 'bag' });
  assert.equal(due(), null, 'four of five players have Poké Balls');
  d.set('balls:p5', { at: 2, how: 'catch' });
  assert.deepEqual(due(), { id: 'balls', kind: 'balls', n: 0, rank: 0 });
  d.set(atKey('balls'), { id: 'balls', kind: 'balls', n: 0, at: 3 });
  assert.equal(due(), null, 'recorded already');
  // badges: every player's game has to say how many it has
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(s === 'p3' ? 0 : 2));
  assert.equal(due(), null, 'Cem has none yet');
  d.set('live:p3', { ...liveWith(1), badgesRead: false });
  assert.equal(due(), null, 'a count the game didn’t read');
  d.set('live:p3', liveWith(1));
  assert.equal(due()?.id, 'badge1');
  d.set(atKey('badge1'), { id: 'badge1', kind: 'badge', n: 1, at: 4 });
  // a jump: everyone at 3 → straight to badge3
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(3));
  assert.equal(due()?.id, 'badge3');
  d.set(atKey('badge3'), { id: 'badge3', kind: 'badge', n: 3, at: 5 });
  assert.equal(latestOf(d.scan('cp:at:')).id, 'badge3');
  // an older game loaded (fewer badges): no checkpoint again for one that's older than the latest
  d.set('live:p2', liveWith(2));
  assert.equal(due(), null);
  // not while the run is over, not with the rule off
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(4));
  d.set('run:status', { state: 'failed', at: 6 });
  assert.equal(due(), null);
  d.set('run:status', null);
  assert.equal(due()?.id, 'badge4');
  assert.equal(dueCheckpoint(getter(d), d.scan('cp:at:'), SLOTS, { ...r(), checkpoints: false }), null);
  // without "Nothing counts before your first Poké Balls" there is no Poké Ball checkpoint – the badges still count
  const e = mkDoc('a', { checkpoints: true, startAtBalls: false });
  for (const s of SLOTS) e.set(`balls:${s}`, { at: 1 });
  assert.equal(reached(getter(e), SLOTS, R.rules(e, FIVE)), null);
  for (const s of SLOTS) e.set(`live:${s}`, liveWith(1));
  assert.equal(reached(getter(e), SLOTS, R.rules(e, FIVE)).id, 'badge1');
});

test('going back: deaths and catches since are undone, the run goes on, lives come back – rules and log stay', () => {
  const d = mkDoc('a', { checkpoints: true, startAtBalls: true, lives: 3 });
  catchAll(d, 'r1');
  catchAll(d, 'r2', 19);
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(1));
  const snap = snapshotOf(d.entries);
  assert.ok(!('rules' in snap) && 'enc:r1:p1' in snap && 'live:p3' in snap);
  // after the checkpoint: a catch, two deaths (one life left), the run ends by hand
  catchAll(d, 'r3', 41);
  R.markDead(d, FIVE, 'r1', { slot: 'p2' });
  R.markDead(d, FIVE, 'r2', { slot: 'p4' });
  assert.equal(R.lives(d, FIVE).pools.all.left, 1);
  R.failRun(d, FIVE, 'p4', 'wipe');
  assert.equal(d.get('run:status').state, 'failed');
  d.set('rules', { ...d.get('rules'), lives: 5 }); // (a rule changed after the checkpoint stays changed)
  const feedBefore = R.feedList(d, 999).length;
  const w = restoreWrites(snap, d.entries);
  d.batch({ ...w, [RESET_KEY]: { rid: 'x1', id: 'badge1', at: Date.now(), by: 'p1' } });
  assert.equal(R.pairState(d, 'r1', SLOTS).state, 'linked');
  assert.equal(R.pairState(d, 'r2', SLOTS).state, 'linked');
  assert.equal(d.get('pair:r1', null), null, 'the group died after the checkpoint: as if it never had');
  assert.equal(R.encounter(d, 'r3', 'p1') ?? null, null, 'the catch since is gone');
  assert.equal(d.get('run:status', null), null, 'the run goes on');
  assert.equal(R.lives(d, FIVE).pools.all.left, 5);
  assert.equal(d.get('rules').lives, 5);
  assert.equal(R.feedList(d, 999).length, feedBefore, 'the log keeps what happened');
  assert.deepEqual(restoreWrites(snap, d.entries), {}, 'nothing left to put back');
});

test('two computers converge – the old game’s writes made before the go-back arrived go back too', () => {
  const a = mkDoc('dev-a', { checkpoints: true, startAtBalls: true });
  const b = mkDoc('dev-b');
  catchAll(a, 'r1');
  catchAll(a, 'r2', 19);
  sync(a, b);
  const snapA = snapshotOf(a.entries);
  const snapB = snapshotOf(b.entries);
  // Ben's game (computer b) loses route 2's group after the checkpoint – everyone has it
  R.markDead(b, FIVE, 'r2', { slot: 'p2' });
  sync(a, b);
  assert.equal(a.get('pair:r2').state, 'dead');
  // Ana (computer a) goes back …
  a.batch({ ...restoreWrites(snapA, a.entries), [RESET_KEY]: { rid: 'r-1', id: 'balls', at: Date.now(), by: 'p1' } });
  const resetT = a.entries[RESET_KEY].t;
  // … while Ben's old game, not knowing yet, loses route 1's group (a write after the go-back's timestamp)
  b.clock = Math.max(b.clock, resetT);
  R.markDead(b, FIVE, 'r1', { slot: 'p2' });
  assert.ok(b.entries['pair:r1'].t > resetT);
  sync(a, b);
  assert.equal(a.get('pair:r1').state, 'dead', 'the late death won the merge …');
  assert.ok(pendingReset(getter(b), 'p2'), 'Ben’s game still has to go back');
  assert.equal(pendingReset(getter(b), 'p1')?.rid, 'r-1');
  // … until Ben's computer puts its game back: its own writes since the go-back return to its copy
  const stale = staleOwnWrites(snapB, b.entries, b.by, b.entries[RESET_KEY].t);
  assert.deepEqual(Object.keys(stale), ['pair:r1']);
  b.batch(stale);
  b.set(doneKey('p2'), { rid: 'r-1', at: Date.now(), ok: true });
  sync(a, b);
  for (const d of [a, b]) {
    assert.equal(d.get('pair:r1', null), null);
    assert.equal(d.get('pair:r2', null), null);
  }
  assert.equal(pendingReset(getter(a), 'p2'), null);
  // a write of the other computer is never touched by this one's fix-up
  assert.deepEqual(staleOwnWrites(snapB, b.entries, 'dev-a', 0), {}, 'dev-a wrote nothing restorable since');
});

test('copies: whose computers keep one', () => {
  const d = mkDoc('a');
  d.set(haveKey('badge1', 'p1'), { at: 1 });
  d.set(haveKey('badge1', 'p3'), { at: 2, late: true });
  const c = copiesOf(getter(d), 'badge1', SLOTS);
  assert.deepEqual(Object.keys(c).filter((s) => c[s]), ['p1', 'p3']);
  assert.equal(c.p3.late, true);
  // a malformed go-back (no id) is no go-back
  d.set(RESET_KEY, { rid: 'q', id: '../etc' });
  assert.equal(pendingReset(getter(d), 'p1'), null);
});

// ---- on disk -----------------------------------------------------------------------------------------------------

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'souldew-cp-'));
  const runDir = join(root, 'run');
  const stateDir = join(root, 'states');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, runDir, stateDir, savePath: join(runDir, 'game.sav'), stateKey: '0123456789abcdef' };
}
const writeState = (f, text) => {
  writeFileSync(statePath(f.stateDir, f.stateKey, AUTO_SLOT, 'state'), text);
  writeFileSync(statePath(f.stateDir, f.stateKey, AUTO_SLOT, 'json'), JSON.stringify({ core: 'melonds-native', text }));
};
const readState = (f) => readFileSync(statePath(f.stateDir, f.stateKey, AUTO_SLOT, 'state'), 'utf8');

test('disk: keep a copy, list it, put it back – what it replaced kept aside', () => {
  const f = fixture();
  try {
    writeFileSync(f.savePath, 'SAVE@BADGE1');
    writeState(f, 'STATE@BADGE1');
    const doc = { 'pair:r1': { v: { state: 'alive' }, t: 1, by: 'a' } };
    const info = storeCheckpoint({ ...f, id: 'badge1', slot: 'p2', doc, meta: { save: 'h1', core: 'melonds-native' } });
    assert.equal(info.save, true);
    assert.equal(info.state, true);
    // the game goes on – and is lost
    writeFileSync(f.savePath, 'SAVE@LATER');
    writeState(f, 'STATE@LATER');
    const list = listCheckpoints(f.runDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'badge1');
    assert.ok(list[0].doc && list[0].slots.p2.save);
    assert.deepEqual(checkpointDoc(f.runDir, 'badge1').entries, doc);
    const r = restoreCheckpoint({ ...f, id: 'badge1', slot: 'p2' });
    assert.equal(readFileSync(f.savePath, 'utf8'), 'SAVE@BADGE1');
    assert.equal(readState(f), 'STATE@BADGE1');
    assert.deepEqual(r.meta, { save: 'h1', core: 'melonds-native' });
    // what was there before the go-back is kept
    const before = join(f.runDir, r.before);
    assert.equal(readFileSync(join(before, 'save.sav'), 'utf8'), 'SAVE@LATER');
    assert.equal(readFileSync(join(before, 'state.state'), 'utf8'), 'STATE@LATER');
    // a player without a copy here
    assert.throws(() => restoreCheckpoint({ ...f, id: 'badge1', slot: 'p3' }), { code: 'checkpointMissing' });
    assert.throws(() => restoreCheckpoint({ ...f, id: '../../x', slot: 'p2' }), { code: 'badCheckpoint' });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('disk: a checkpoint before the first in-game save takes the save there now away (the state is resumed without one)', () => {
  const f = fixture();
  try {
    writeState(f, 'STATE@BALLS');
    const info = storeCheckpoint({ ...f, id: 'balls', slot: 'p1', meta: { save: null } });
    assert.equal(info.save, false);
    writeFileSync(f.savePath, 'SAVED LATER');
    writeState(f, 'STATE@LATER');
    const r = restoreCheckpoint({ ...f, id: 'balls', slot: 'p1' });
    assert.equal(existsSync(f.savePath), false);
    assert.equal(readState(f), 'STATE@BALLS');
    assert.equal(r.save, false);
    // no state in a copy: the state from after it is not resumed either
    rmSync(statePath(f.stateDir, f.stateKey, AUTO_SLOT, 'state'));
    writeFileSync(f.savePath, 'S1');
    storeCheckpoint({ ...f, id: 'badge1', slot: 'p1' });
    writeState(f, 'STATE@LATER');
    const r2 = restoreCheckpoint({ ...f, id: 'badge1', slot: 'p1' });
    assert.equal(r2.state, false);
    assert.equal(r2.meta, null);
    assert.equal(existsSync(statePath(f.stateDir, f.stateKey, AUTO_SLOT, 'state')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('disk: only the newest checkpoints stay; the first document copy is the one kept', () => {
  const f = fixture();
  try {
    writeFileSync(f.savePath, 'x');
    storeCheckpoint({ ...f, id: 'balls', slot: 'p1', doc: { a: { v: 1, t: 1 } } });
    storeCheckpoint({ ...f, id: 'balls', slot: 'p1', doc: { a: { v: 2, t: 2 } } });
    assert.equal(checkpointDoc(f.runDir, 'balls').entries.a.v, 1);
    storeCheckpoint({ ...f, id: 'badge1', slot: 'p1' });
    storeCheckpoint({ ...f, id: 'badge2', slot: 'p1' });
    assert.equal(KEEP, 2);
    assert.deepEqual(listCheckpoints(f.runDir).map((c) => c.id), ['badge2', 'badge1']);
    // several "go back"s: the last few replaced games per player
    for (let i = 0; i < 5; i++) restoreCheckpoint({ ...f, id: 'badge2', slot: 'p1', now: Date.now() + i * 1000 });
    assert.equal(readdirSync(join(f.runDir, 'checkpoints', '_before')).length, 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('disk: a 3DS save folder goes along with its timestamps (the play view knows the save by them)', () => {
  const f = fixture();
  try {
    const saveRoot = join(f.root, 'sd', 'Nintendo 3DS');
    const archive = join(saveRoot, 'id0', 'id1', 'title', '00040000', '00055d00', 'data', '00000001');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'main'), 'MAIN@BADGE1');
    const when = new Date('2026-11-01T10:00:00Z');
    utimesSync(join(archive, 'main'), when, when);
    storeCheckpoint({ ...f, savePath: null, archive, saveRoot, id: 'badge1', slot: 'p1' });
    writeFileSync(join(archive, 'main'), 'MAIN@LATER');
    writeFileSync(join(archive, 'extra'), 'NEW FILE');
    restoreCheckpoint({ ...f, savePath: null, archive, saveRoot, id: 'badge1', slot: 'p1' });
    assert.equal(readFileSync(join(archive, 'main'), 'utf8'), 'MAIN@BADGE1');
    assert.equal(existsSync(join(archive, 'extra')), false);
    assert.equal(Math.round(statSync(join(archive, 'main')).mtimeMs), when.getTime());
    // the folder gone meanwhile: it comes back where it was
    rmSync(join(saveRoot, 'id0'), { recursive: true, force: true });
    restoreCheckpoint({ ...f, savePath: null, archive: null, saveRoot, id: 'badge1', slot: 'p1' });
    assert.equal(readFileSync(join(archive, 'main'), 'utf8'), 'MAIN@BADGE1');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
