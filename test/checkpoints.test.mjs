// Checkpoints – "save states" of a whole run (shared/checkpoints.mjs, server/lib/checkpoints.mjs, web/lib/checkpoints.mjs):
//  1. each player's copy is taken the moment THEY reach a milestone (first Poké Balls, each new badge); a checkpoint is
//     complete once every player has reached it – never twice, never while the run is over, only with the rule on;
//  2. going back: every player returns to their own moment – a player who was ahead to just after their own badge. The
//     board follows: each player's own keys from their own moment, a group death undone when its Pokémon fell after
//     its player's moment and kept when it fell before; the run goes on, lives come back; rules and log stay; two
//     computers converge – also when one wrote from its old game before it heard of the go-back;
//  3. this computer's copy on disk: battery save, "where you left off" and the run document – kept, listed, put back
//     (what it replaced kept aside), the copies after it dropped, older checkpoints pruned, a 3DS save folder with its
//     timestamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import {
  reached, dueCheckpoint, latestOf, restoreWrites, staleOwnWrites, pendingReset, snapshotOf, restorable, rankOf, validId, ownerOf,
  ownMilestone, copyDue, copyFor, copiesFor, momentsOf, revivals, planReset, ownPlan, RESET_KEY, atKey, doneKey, haveKey,
} from '../shared/checkpoints.mjs';
import { storeCheckpoint, storeCheckpointDoc, listCheckpoints, checkpointDoc, restoreCheckpoint } from '../server/lib/checkpoints.mjs';
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
const PAIR = { ...FIVE, players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } } };

function mkDoc(by, rules) {
  const d = new RunDoc('t');
  d.by = by;
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const getter = (d) => (k) => d.get(k, null);
/** Every entry of `a` into `b` and back (the sync). */
const sync = (a, b) => {
  b.merge(a.entries);
  a.merge(b.entries);
};
/** Run `fn` with the clock at `t` (Date.now – the doc's timestamps, deaths' diedAt). */
function at(t, fn) {
  const real = Date.now;
  Date.now = () => t;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}
const liveWith = (badges, party = [{ species: 25, hp: 20, maxHp: 20, area: 'r1' }]) => ({ source: 'live', badges, badgesRead: true, party, at: Date.now() });
const catchAll = (d, area, species = 16, slots = SLOTS, m = FIVE) => {
  for (const s of slots) R.setEncounter(d, m, area, s, { outcome: 'caught', species, key: `${area}-${s}` }, { quiet: true });
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

test('ids, ranks, which keys go back and whose they are', () => {
  assert.ok(validId('balls') && validId('badge1') && validId('badge16') && validId('badge24'));
  assert.ok(!validId('badge0') && !validId('badge25') && !validId('../x') && !validId('Badge1') && !validId(''));
  assert.deepEqual(['badge2', 'balls', 'badge10', 'badge1'].sort((a, b) => rankOf(a) - rankOf(b)), ['balls', 'badge1', 'badge2', 'badge10']);
  for (const k of ['pair:r1', 'enc:r1:p3', 'extra:p1:k', 'live:p2', 'party:p4', 'balls:p5', 'boss:falkner', 'held:p1:r2', 'run:status', 'run:resumed', 'area:custom-1']) assert.ok(restorable(k), k);
  for (const k of ['rules', 'feed:x', 'player:p1', 'where:p1', 'cp:at:balls', RESET_KEY, 'run:restart', 'run:host', 'game:p1', 'lb:s:p1']) assert.ok(!restorable(k), k);
  // a player's own keys – the rest is the run's
  const owners = { 'enc:route-30:p3': 'p3', 'enc:loc:4:12:p5': 'p5', 'extra:p2:abc': 'p2', 'ign:p1:k': 'p1', 'held:p4:r2': 'p4', 'capbreak:p1:3': 'p1',
    'tomb:p2:t1': 'p2', 'live:p5': 'p5', 'party:p3': 'p3', 'balls:p1': 'p1', 'center:p2': 'p2', 'raidspared:p4': 'p4', 'simport:p1': 'p1',
    'pair:r1': null, 'boss:falkner': null, 'area:custom-1': null, 'run:status': null, 'enc:r1:x9': null };
  for (const [k, s] of Object.entries(owners)) assert.equal(ownerOf(k), s, k);
});

test('each player’s milestone; a checkpoint once everyone has one – each once, newer ones only', () => {
  const d = mkDoc('a', { checkpoints: true, startAtBalls: true });
  const r = () => R.rules(d, FIVE);
  const due = () => dueCheckpoint(getter(d), d.scan('cp:at:'), SLOTS, r());
  assert.equal(ownMilestone(getter(d), 'p1', r()), null);
  for (const s of SLOTS.slice(0, 4)) d.set(`balls:${s}`, { at: 1, how: 'bag' });
  assert.equal(ownMilestone(getter(d), 'p1', r()).id, 'balls');
  assert.equal(due(), null, 'four of five players have Poké Balls');
  d.set('balls:p5', { at: 2, how: 'catch' });
  assert.deepEqual(due(), { id: 'balls', kind: 'balls', n: 0, rank: 0 });
  d.set(atKey('balls'), { id: 'balls', kind: 'balls', n: 0, at: 3 });
  assert.equal(due(), null, 'recorded already');
  // badges: Ana is ahead with 3, Cem has none yet – the checkpoint goes by the fewest
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(s === 'p1' ? 3 : s === 'p3' ? 0 : 2));
  assert.equal(ownMilestone(getter(d), 'p1', r()).id, 'badge3');
  assert.equal(ownMilestone(getter(d), 'p3', r()).id, 'balls', 'no badge yet: still their first Poké Balls');
  assert.equal(due(), null);
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
  d.set('live:p2', liveWith(2));
  assert.equal(due(), null, 'an older game loaded: nothing older than the latest');
  // not while the run is over, not with the rule off
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(4));
  d.set('run:status', { state: 'failed', at: 6 });
  assert.equal(due(), null);
  d.set('run:status', null);
  assert.equal(due()?.id, 'badge4');
  assert.equal(dueCheckpoint(getter(d), d.scan('cp:at:'), SLOTS, { ...r(), checkpoints: false }), null);
  // without "Nothing counts before your first Poké Balls" there is no Poké Ball milestone – the badges still count
  const e = mkDoc('a', { checkpoints: true, startAtBalls: false });
  for (const s of SLOTS) e.set(`balls:${s}`, { at: 1 });
  assert.equal(reached(getter(e), SLOTS, R.rules(e, FIVE)), null);
  for (const s of SLOTS) e.set(`live:${s}`, liveWith(1));
  assert.equal(reached(getter(e), SLOTS, R.rules(e, FIVE)).id, 'badge1');
});

test('copies: one at each new milestone of the player’s own; for checkpoint N their first one of N or later', () => {
  const haves = {};
  const own = (n) => ({ id: n ? `badge${n}` : 'balls', rank: n });
  assert.equal(copyDue(haves, 'p1', own(0), -1)?.id, 'balls');
  haves['balls:p1'] = { at: 100 };
  assert.equal(copyDue(haves, 'p1', own(0), -1), null, 'kept already');
  assert.equal(copyDue(haves, 'p1', own(1), 0)?.id, 'badge1');
  haves['badge1:p1'] = { at: 200 };
  // badges read only now, or two badges in one go: 1 → 3
  haves['badge3:p1'] = { at: 300 };
  assert.equal(copyDue(haves, 'p1', own(2), 0), null, 'a copy of a later one is there');
  assert.equal(copyDue(haves, 'p1', own(3), 4), null, 'below the latest checkpoint: not needed');
  haves['badge2:p2'] = { at: 250, late: true };
  const c = copiesFor(haves, ['p1', 'p2', 'p3'], 2);
  assert.equal(c.p1.id, 'badge3', 'Ana’s badge 2 came with badge 3');
  assert.equal(c.p2.id, 'badge2');
  assert.equal(c.p2.late, true);
  assert.equal(c.p3, null);
  assert.deepEqual(momentsOf(haves, ['p1', 'p2', 'p3'], 2), { p1: 300, p2: 250 });
  assert.equal(copyFor(haves, 'p1', 0).id, 'balls');
  // a malformed go-back (no valid id) is no go-back
  const d = mkDoc('a');
  d.set(RESET_KEY, { rid: 'q', id: '../etc' });
  assert.equal(pendingReset(getter(d), 'p1'), null);
});

test('revivals: a death stands when its Pokémon fell before its player’s moment, is undone after it', () => {
  const v = {
    'pair:a': { state: 'dead', by: 'p1', diedAt: 150, cause: 'x', level: 12 },
    'pair:b': { state: 'dead', by: 'p1', diedAt: 50 },
    'pair:c': { state: 'dead', by: 'p2', diedAt: 150 },
    'pair:d': { state: 'dead', diedAt: 999 }, // (whose Pokémon fell isn't known: it stands)
    'pair:e': { state: 'alive' },
    'extra:p1:shiny': { dead: true, diedAt: 180, species: 7 },
    'extra:p2:gift': { dead: true, diedAt: 180 },
  };
  const r = revivals(v, { p1: 100, p2: 200 });
  assert.deepEqual(Object.keys(r).sort(), ['extra:p1:shiny', 'pair:a']);
  assert.deepEqual(r['pair:a'], { state: 'alive', by: 'p1', diedAt: null, cause: '', level: 12 });
  assert.deepEqual(r['extra:p1:shiny'], { dead: false, diedAt: null, species: 7 });
});

test('going back (all at one moment): deaths and catches since are undone, the run goes on, lives come back – rules and log stay', () => {
  const d = mkDoc('a', { checkpoints: true, startAtBalls: true, lives: 3 });
  catchAll(d, 'r1');
  catchAll(d, 'r2', 19);
  for (const s of SLOTS) d.set(`live:${s}`, liveWith(1));
  const snap = snapshotOf(d.entries);
  assert.ok(!('rules' in snap) && 'enc:r1:p1' in snap && 'live:p3' in snap);
  const moment = Date.now();
  catchAll(d, 'r3', 41);
  R.markDead(d, FIVE, 'r1', { slot: 'p2' });
  R.markDead(d, FIVE, 'r2', { slot: 'p4' });
  assert.equal(R.lives(d, FIVE).pools.all.left, 1);
  R.failRun(d, FIVE, 'p4', 'wipe');
  d.set('rules', { ...d.get('rules'), lives: 5 }); // (a rule changed after the checkpoint stays changed)
  const feedBefore = R.feedList(d, 999).length;
  const w = planReset(snap, d.entries, Object.fromEntries(SLOTS.map((s) => [s, moment])));
  d.batch({ ...w, [RESET_KEY]: { rid: 'x1', id: 'badge1', at: Date.now(), by: 'p1' } });
  assert.equal(R.pairState(d, 'r1', SLOTS).state, 'linked');
  assert.equal(R.pairState(d, 'r2', SLOTS).state, 'linked');
  assert.equal(R.encounter(d, 'r3', 'p1') ?? null, null, 'the catch since is gone');
  assert.equal(d.get('run:status', null), null, 'the run goes on');
  assert.equal(R.lives(d, FIVE).pools.all.left, 5);
  assert.equal(d.get('rules').lives, 5);
  assert.equal(R.feedList(d, 999).length, feedBefore, 'the log keeps what happened');
  assert.deepEqual(restoreWrites(snap, d.entries), {}, 'nothing left to put back');
  // a board kept only later (it says the run was over): going back still reopens it
  d.set('run:status', { state: 'failed', at: 1 });
  assert.equal(planReset({ ...snap, 'run:status': { v: { state: 'failed' }, t: 1, by: 'a' } }, d.entries, {})['run:status'], null);
});

test('the player who was ahead goes back to just after their own badge – the slow one’s earlier deaths stand', () => {
  const T0 = Date.now() - 7 * 86400000; // (in the past: the doc clamps timestamps from the future)
  const rules = { checkpoints: true, startAtBalls: true };
  const a = at(T0, () => mkDoc('dev-ana', rules)); // Ana's computer – she is ahead
  const b = at(T0, () => mkDoc('dev-ben')); // Ben's
  at(T0 + 1000, () => {
    catchAll(a, 'r1', 16, ['p1', 'p2'], PAIR);
    catchAll(a, 'r2', 19, ['p1', 'p2'], PAIR);
    a.set('live:p1', liveWith(0));
    a.set('live:p2', liveWith(0));
  });
  sync(a, b);
  // 18:00 – Ana gets badge 1: her computer keeps her copy, with the board as it is now
  const T1 = T0 + 60_000;
  at(T1, () => a.set('live:p1', liveWith(1, [{ species: 16, hp: 30, maxHp: 30, area: 'r1' }])));
  const ownAna = snapshotOf(a.entries);
  at(T1, () => a.set(haveKey('badge1', 'p1'), { at: T1 }));
  sync(a, b);
  // after it: Ana catches on route 3 and loses route 1's pair; Ben, still before his badge, loses route 2's pair
  at(T1 + 10_000, () => R.setEncounter(a, PAIR, 'r3', 'p1', { outcome: 'caught', species: 41, key: 'r3-p1' }, { quiet: true }));
  at(T1 + 20_000, () => R.markDead(a, PAIR, 'r1', { slot: 'p1' }));
  at(T1 + 30_000, () => R.markDead(b, PAIR, 'r2', { slot: 'p2' }));
  at(T1 + 40_000, () => R.setEncounter(b, PAIR, 'r4', 'p2', { outcome: 'caught', species: 52, key: 'r4-p2' }, { quiet: true }));
  sync(a, b);
  // 19:00 – Ben gets badge 1: his copy, and the checkpoint is complete (each computer keeps the board of that moment)
  const T2 = T1 + 3_600_000;
  at(T2, () => b.set('live:p2', liveWith(1)));
  const ownBen = snapshotOf(b.entries);
  at(T2, () => {
    b.set(haveKey('badge1', 'p2'), { at: T2 });
    b.set(atKey('badge1'), { id: 'badge1', kind: 'badge', n: 1, at: T2 });
  });
  sync(a, b);
  assert.equal(dueCheckpoint(getter(a), a.scan('cp:at:'), ['p1', 'p2'], R.rules(a, PAIR)), null);
  const compA = snapshotOf(a.entries);
  const compB = snapshotOf(b.entries);
  // after it: Ben catches on route 5, Ana's team wipes – the run is over
  at(T2 + 10_000, () => R.setEncounter(b, PAIR, 'r5', 'p2', { outcome: 'caught', species: 60, key: 'r5-p2' }, { quiet: true }));
  at(T2 + 20_000, () => R.failRun(a, PAIR, 'p1', 'wipe'));
  sync(a, b);
  // Ben goes back
  const moments = momentsOf(b.scan('cp:have:'), ['p1', 'p2'], 1);
  assert.deepEqual(moments, { p1: T1, p2: T2 });
  const T3 = T2 + 60_000;
  at(T3, () => b.batch({ ...planReset(compB, b.entries, moments), [RESET_KEY]: { rid: 'g1', id: 'badge1', at: T3, by: 'p2' } }));
  sync(a, b);
  // each computer puts its own player's part back (as web/lib/checkpoints.mjs applyReset does)
  const since = b.entries[RESET_KEY].t;
  at(T3 + 1000, () => b.batch(ownPlan({ own: ownBen, snap: compB, cur: b.entries, slot: 'p2', device: b.by, since, moment: T2 })));
  at(T3 + 2000, () => a.batch(ownPlan({ own: ownAna, snap: compA, cur: a.entries, slot: 'p1', device: a.by, since, moment: T1 })));
  sync(a, b);
  for (const d of [a, b]) {
    assert.equal(d.get('run:status', null), null, 'the run goes on');
    assert.equal(d.get('pair:r1').state, 'alive', 'Ana’s Pokémon fell after her badge: her game goes back to before – the pair lives');
    assert.equal(d.get('pair:r2').state, 'dead', 'Ben’s fell before his badge: his game still has it fainted – it stays dead');
    assert.equal(R.encounter(d, 'r3', 'p1') ?? null, null, 'Ana’s catch after her badge is undone');
    assert.equal(R.encounter(d, 'r4', 'p2')?.species, 52, 'Ben’s catch before his badge stays');
    assert.equal(R.encounter(d, 'r5', 'p2') ?? null, null, 'Ben’s catch after the checkpoint is undone');
    assert.equal(d.get('live:p1').party[0].hp, 30, 'Ana’s team as it was at her badge');
    assert.equal(d.get('live:p2').badges, 1);
  }
});

test('two computers converge – the old game’s writes made before the go-back arrived go back too', () => {
  const a = mkDoc('dev-a', { checkpoints: true, startAtBalls: true });
  const b = mkDoc('dev-b');
  catchAll(a, 'r1');
  catchAll(a, 'r2', 19);
  sync(a, b);
  const snapA = snapshotOf(a.entries);
  const snapB = snapshotOf(b.entries);
  const moment = Date.now();
  R.markDead(b, FIVE, 'r2', { slot: 'p2' });
  sync(a, b);
  a.batch({ ...planReset(snapA, a.entries, Object.fromEntries(SLOTS.map((s) => [s, moment]))), [RESET_KEY]: { rid: 'r-1', id: 'balls', at: Date.now(), by: 'p1' } });
  const resetT = a.entries[RESET_KEY].t;
  // Ben's old game, not knowing yet, loses route 1's group – his Pokémon (a write after the go-back's timestamp)
  b.clock = Math.max(b.clock, resetT);
  R.markDead(b, FIVE, 'r1', { slot: 'p2' });
  assert.ok(b.entries['pair:r1'].t > resetT);
  sync(a, b);
  assert.equal(a.get('pair:r1').state, 'dead', 'the late death won the merge …');
  assert.ok(pendingReset(getter(b), 'p2'), 'Ben’s game still has to go back');
  // … until Ben's computer puts its game back
  assert.deepEqual(Object.keys(staleOwnWrites(snapB, b.entries, b.by, b.entries[RESET_KEY].t)), ['pair:r1']);
  b.batch(ownPlan({ own: snapB, snap: snapB, cur: b.entries, slot: 'p2', device: b.by, since: b.entries[RESET_KEY].t, moment }));
  b.set(doneKey('p2'), { rid: 'r-1', at: Date.now(), ok: true });
  sync(a, b);
  for (const d of [a, b]) {
    assert.equal(R.pairState(d, 'r1', SLOTS).state, 'linked');
    assert.equal(d.get('pair:r1', null), null, 'as before the late death');
    assert.equal(d.get('pair:r2', null), null);
  }
  assert.equal(pendingReset(getter(a), 'p2'), null);
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

test('disk: keep a copy with its board, list it, put it back – what it replaced kept aside', () => {
  const f = fixture();
  try {
    writeFileSync(f.savePath, 'SAVE@BADGE1');
    writeState(f, 'STATE@BADGE1');
    const doc = { 'pair:r1': { v: { state: 'alive' }, t: 1, by: 'a' } };
    const info = storeCheckpoint({ ...f, id: 'badge1', slot: 'p2', doc, meta: { save: 'h1', core: 'melonds-native' } });
    assert.equal(info.save, true);
    assert.equal(info.state, true);
    writeFileSync(f.savePath, 'SAVE@LATER');
    writeState(f, 'STATE@LATER');
    const list = listCheckpoints(f.runDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'badge1');
    assert.ok(list[0].slots.p2.save && list[0].slots.p2.doc);
    assert.equal(list[0].doc, null, 'the completed checkpoint’s board comes separately');
    assert.deepEqual(checkpointDoc(f.runDir, 'badge1', 'p2').entries, doc);
    // the board when everyone had it: the first one kept here stays
    storeCheckpointDoc({ ...f, id: 'badge1', doc: { a: { v: 1, t: 1 } } });
    storeCheckpointDoc({ ...f, id: 'badge1', doc: { a: { v: 2, t: 2 } } });
    assert.equal(checkpointDoc(f.runDir, 'badge1').entries.a.v, 1);
    const r = restoreCheckpoint({ ...f, id: 'badge1', slot: 'p2' });
    assert.equal(readFileSync(f.savePath, 'utf8'), 'SAVE@BADGE1');
    assert.equal(readState(f), 'STATE@BADGE1');
    assert.deepEqual(r.meta, { save: 'h1', core: 'melonds-native' });
    const before = join(f.runDir, r.before);
    assert.equal(readFileSync(join(before, 'save.sav'), 'utf8'), 'SAVE@LATER');
    assert.equal(readFileSync(join(before, 'state.state'), 'utf8'), 'STATE@LATER');
    assert.throws(() => restoreCheckpoint({ ...f, id: 'badge1', slot: 'p3' }), { code: 'checkpointMissing' });
    assert.throws(() => restoreCheckpoint({ ...f, id: '../../x', slot: 'p2' }), { code: 'badCheckpoint' });
    assert.throws(() => checkpointDoc(f.runDir, 'badge1', '../p1'), { code: 'badPlayer' });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('disk: a copy before the first in-game save takes the save there now away (the state is resumed without one)', () => {
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

test('disk: going back drops the player’s copies after it; older checkpoints go once a newer one is complete', () => {
  const f = fixture();
  try {
    writeFileSync(f.savePath, 'x');
    for (const id of ['balls', 'badge1', 'badge2', 'badge3']) storeCheckpoint({ ...f, id, slot: 'p1' });
    storeCheckpoint({ ...f, id: 'badge2', slot: 'p2' });
    storeCheckpointDoc({ ...f, id: 'badge1', doc: {} });
    assert.deepEqual(listCheckpoints(f.runDir).map((c) => c.id), ['badge3', 'badge2', 'badge1', 'balls'], 'nothing is dropped without keepFrom');
    // back to badge 1: Ana's badge 2 and 3 are from a future that is undone – Ben's copy is his
    restoreCheckpoint({ ...f, id: 'badge1', slot: 'p1' });
    const after = Object.fromEntries(listCheckpoints(f.runDir).map((c) => [c.id, Object.keys(c.slots)]));
    assert.deepEqual(after, { badge2: ['p2'], badge1: ['p1'], balls: ['p1'] });
    // badge 2 complete: what is older can't be gone back to any more
    storeCheckpointDoc({ ...f, id: 'badge2', doc: {}, keepFrom: 2 });
    assert.deepEqual(listCheckpoints(f.runDir).map((c) => c.id), ['badge2']);
    for (let i = 0; i < 5; i++) restoreCheckpoint({ ...f, id: 'badge2', slot: 'p2', now: Date.now() + i * 1000 });
    assert.equal(readdirSync(join(f.runDir, 'checkpoints', '_before')).filter((n) => n.endsWith('-p2')).length, 3, 'the last few replaced games per player');
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
