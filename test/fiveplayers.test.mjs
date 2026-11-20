// A fifth player (p5): the slot list, the run pack format older apps refuse, the build request, raids, link sessions
// (still at most four games), the colours every theme needs – and the TV overview (?w=tv) that shows all five at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const DATA = mkdtempSync(join(tmpdir(), 'sls-five-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// web/lib/*.mjs import browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

const S = await import('../shared/slots.mjs');
const P = await import('../shared/runpack.mjs');
const O = await import('../shared/overlay.mjs');
const { newRaid, cleanRaid, RAID, RAID_VERSION } = await import('../shared/raid.mjs');
const { PLAYER_COLORS } = await import('../shared/streamapi.mjs');
const { MAX_LINK_SEATS } = await import('../shared/link.mjs');
const { runPlayers, checkPack } = await import('../server/lib/build.mjs');
const { PACK_FORMATS: CODE_FORMATS } = await import('../web/lib/invitecode.mjs');

const FIVE = { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Kim' }, p4: { name: 'Alex' }, p5: { name: 'Sky' } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('slots: five of them, every helper derived from the one list', () => {
  assert.deepEqual(S.ALL_SLOTS, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(S.MAX_PLAYERS, 5);
  assert.deepEqual(S.PLAYER_COUNTS, [2, 3, 4, 5], 'the wizards offer 2 to 5 players');
  assert.ok(S.isSlot('p5') && !S.isSlot('p6') && !S.isSlot('P5') && !S.isSlot(''));
  assert.deepEqual(S.slotsOf({ mode: 'soullink', players: FIVE }), S.ALL_SLOTS);
  assert.deepEqual(S.slotsOf({ mode: 'nuzlocke', players: FIVE }), ['p1'], 'a Nuzlocke stays one player');
  assert.equal(S.defaultRunName(FIVE), 'Lou, Robin, Kim, Alex & Sky');
});

test('run pack: a run with p5 travels as @6, which every app that only knows p1–p4 refuses', () => {
  assert.deepEqual(P.packFormatOf({ mode: 'soullink', players: FIVE }), { format: P.PACK_FORMAT_FIVE, minVersion: P.FIVE_PLAYERS_MIN_VERSION });
  assert.equal(P.packFormatOf({ mode: 'together', players: FIVE }).format, P.PACK_FORMAT_FIVE, 'Play together with five, too');
  assert.equal(P.packFormatOf({ mode: 'soullink', players: FIVE, rules: { startAtBalls: true } }).format, P.PACK_FORMAT_FIVE, '@6 covers every older need');
  const four = { mode: 'soullink', players: { ...FIVE, p5: undefined } };
  assert.equal(P.packFormatOf(four).format, P.PACK_FORMAT, 'four players keep the format older apps read');
  assert.equal(P.packFormatOf({ mode: 'nuzlocke', players: FIVE }).format, P.PACK_FORMAT, 'a Nuzlocke has no fifth player');
  assert.ok(P.PACK_FORMATS.includes(P.PACK_FORMAT_FIVE));
  assert.equal(P.packFormatState({ format: P.PACK_FORMAT_FIVE }), 'ok');
  assert.deepEqual(CODE_FORMATS, P.PACK_FORMATS, 'code invites read the same formats as the import route');
  // the 3.0.0 app's list: @6 is "newer" there – it asks to update instead of dropping p5
  const old = P.PACK_FORMATS.filter((f) => f !== P.PACK_FORMAT_FIVE);
  assert.ok(!old.includes(P.PACK_FORMAT_FIVE) && /@6$/.test(P.PACK_FORMAT_FIVE));
});

test('build request and invite pack keep the fifth player', () => {
  const r = runPlayers({ mode: 'soullink', players: FIVE });
  assert.deepEqual(r.slots, S.ALL_SLOTS);
  assert.equal(r.players.p5.name, 'Sky');
  assert.throws(() => runPlayers({ mode: 'soullink', players: { p1: {}, p2: {}, p5: {} } }), /p1 to p5 without gaps/);
  const pack = checkPack({ room: 'glurak-evoli-1234', secret: 'secret-secret', players: FIVE, mode: 'soullink' });
  assert.deepEqual(Object.keys(pack.players), S.ALL_SLOTS);
});

test('raids: every player of a five-player run can join', () => {
  assert.equal(RAID.maxPlayers, 5);
  const raid = newRaid({ id: 'abcdef12', host: 'p5', players: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], at: 1 });
  assert.deepEqual(raid.players, ['p5', 'p1', 'p2', 'p3', 'p4'], 'the host first, nothing that is no slot');
  assert.deepEqual(cleanRaid({ ...raid, v: RAID_VERSION }, 'abcdef12')?.players, raid.players);
});

test('link sessions stay at four games – the consoles\' limit, not the run\'s', () => {
  assert.equal(MAX_LINK_SEATS, 4);
  const src = read('web/lib/linksession.mjs');
  assert.ok(!/seats\.length > 4/.test(src), 'the seat limit is MAX_LINK_SEATS, not a literal');
  assert.match(src, /seats\.length > MAX_LINK_SEATS\) throw/, 'an invite for more seats fails at once instead of waiting for answers');
  assert.match(read('web/views/linkplay.mjs'), /\.slice\(0, MAX_LINK_SEATS - 1\)/, '"Link all of us" takes three partners at most');
});

test('colours: p5 in the app\'s four schemes, the overlays, the stream API and the share cards', () => {
  const css = read('web/styles.css');
  assert.match(css, /:root[^}]*--p5: #/s, 'classic');
  for (const theme of ['contrast', 'deutan', 'tritan']) {
    const block = css.match(new RegExp(`html\\[data-theme='${theme}'\\] \\{([^}]*)\\}`))?.[1] || '';
    assert.match(block, /--p5: #[0-9a-f]{6}/, theme);
  }
  assert.match(css, /\.who-p5 \{ color: var\(--p5\)/);
  assert.match(read('web/overlay.html'), /--p5: #[0-9a-f]{6}/);
  assert.match(PLAYER_COLORS.p5, /^#[0-9a-f]{6}$/);
  assert.equal(new Set(Object.values(PLAYER_COLORS)).size, 5, 'five different colours');
});

// ---- the TV overview ----------------------------------------------------------------------------------------------

const NOW = 1_762_790_000_000;
/** An overlay snapshot of a five-player SoulLink: p1 and p5 have a team, p5 knocked out Route 30's group. */
function snapshot() {
  const manifest = { id: 'abcdef12', name: 'Five', mode: 'soullink', game: { system: 'nds' }, players: FIVE };
  const e = (v) => ({ v, t: 1, by: 'p1' });
  const doc = {
    'live:p1': e({ badges: 3, playTime: { h: 4, m: 7 }, at: NOW - 1000, party: [
      { key: 'a', area: 'route-29', species: 155, nick: 'EMBER', level: 20, hp: 30, maxHp: 34, status: 0 },
      { key: 'b', area: 'route-30', species: 16, nick: '', level: 12, hp: 0, maxHp: 30, status: 0 },
    ] }),
    'live:p5': e({ badges: 1, playTime: { h: 1, m: 2 }, at: NOW - 3_600_000, party: [{ key: 'c', area: 'route-29', species: 158, level: 18, hp: 40, maxHp: 40, status: 8 }] }),
    'enc:route-29:p1': e({ outcome: 'caught', species: 155 }),
    'enc:route-29:p5': e({ outcome: 'caught', species: 158 }),
    'enc:route-30:p1': e({ outcome: 'caught', species: 16 }),
    'enc:route-30:p5': e({ outcome: 'missed' }),
    'pair:route-30': e({ state: 'dead', diedAt: NOW - 5000, level: 12, by: 'p5', killer: { species: 241, level: 19, kind: 'trainer' } }),
    'where:p5': e({ gen: 4, id: 177, name: 'Route 30', fight: { kind: 'wild', species: 19, level: 4 } }),
    'feed:1': e({ at: NOW - 9000, type: 'catch', slot: 'p5', area: 'route-29', species: 158 }),
    'feed:2': e({ at: NOW - 5000, type: 'death', slot: 'p5', area: 'route-30' }),
    'feed:3': e({ at: NOW - 4000, type: 'chat', slot: 'p2' }),
    'feed:4': e({ at: NOW - 3000, type: 'badge', slot: 'p1', msg: { vars: { n: 3 } } }),
  };
  return O.overlaySnapshot(manifest, doc, { speciesName: (id) => `#${id}`, tables: {} });
}

test('TV overview: one column per player with team, fitness, own results, deaths caused and place', () => {
  const snap = snapshot();
  assert.deepEqual(snap.slots, S.ALL_SLOTS);
  assert.equal(snap.doc['pair:route-30'].by, 'p5', 'the snapshot keeps who caused a death');
  const p1 = O.tvPlayerOf(snap, 'p1', NOW);
  assert.equal(p1.team.length, O.TEAM_SLOTS, 'six places, free ones null');
  assert.deepEqual(p1.team.map((m) => m?.species ?? null), [155, 16, null, null, null, null]);
  assert.deepEqual([p1.fit, p1.members, p1.caught, p1.deaths, p1.badges, p1.playTime, p1.live], [1, 2, 2, 0, 3, '4:07', true]);
  assert.equal(p1.team[1].dead, true, 'its group is in the graveyard');
  const p5 = O.tvPlayerOf(snap, 'p5', NOW);
  assert.deepEqual([p5.name, p5.fit, p5.caught, p5.missed, p5.deaths, p5.live], ['Sky', 1, 1, 1, 1, false]);
  assert.equal(p5.team[0].status, 'psn');
  assert.equal(p5.where.name, 'Route 30');
  assert.equal(p5.where.fight.species, 19);
  const p3 = O.tvPlayerOf(snap, 'p3', NOW);
  assert.deepEqual([p3.members, p3.badges, p3.playTime, p3.where, p3.live], [0, null, '', null, false], 'nobody played yet');
});

test('TV overview: the news line – deaths, catches, badges and evolutions, newest first, nothing else', () => {
  const news = O.tvNewsOf(snapshot(), 6);
  assert.deepEqual(news.map((n) => n.type), ['badge', 'death', 'catch'], 'the chat line is no news');
  assert.equal(news[0].n, 3);
  assert.deepEqual([news[1].slot, news[1].area], ['p5', 'route-30']);
  assert.equal(news[2].species, 158);
  assert.equal(O.tvNewsOf(snapshot(), 1).length, 1);
  assert.deepEqual(O.tvNewsOf({ doc: {} }), []);
});

test('TV overview: a widget of the overlay page, offered on the Stream page and opened only through the guard', () => {
  assert.ok(O.WIDGETS.includes('tv'));
  const page = read('web/overlay.html');
  assert.match(page, /else if \(opt\.w === 'tv'\) renderTv\(/);
  assert.match(page, /flag\('alerts', opt\.w === 'tv'\)/, 'its alerts are on unless the link switches them off');
  assert.match(read('web/views/stream.mjs'), /<\$\{TvCard\}/);
  assert.match(read('electron/preload.cjs'), /openOverlay: \(url\) => ipcRenderer\.invoke\('open-overlay', url\)/);
  assert.match(read('electron/main.mjs'), /appOverlayUrl\(url, serverUrl\)/);
});
