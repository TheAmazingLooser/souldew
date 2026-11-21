// Checkpoints in the app (shared/checkpoints.mjs): this computer keeps a copy of its player's game the moment that
// player reaches a milestone (first Poké Balls, each new badge), records a checkpoint once everyone has, goes back to
// the latest one, and puts this player's game – and their part of the board – back when anyone went back. The copies
// are on the server (server/lib/checkpoints.mjs, /api/runs/:id/checkpoints).
import { useEffect, useRef } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { t } from './i18n.mjs';
import { feed, msg, rules as getRules, players as getPlayers, isTogether, runStateId } from './run.mjs';
import { slotsOf } from '/shared/slots.mjs';
import {
  RESET_KEY, atKey, haveKey, doneKey, dueCheckpoint, latestOf, pendingReset, snapshotOf, planReset, ownPlan, ownMilestone,
  copyDue, copyFor, copiesFor, copiesOfSlot, momentsOf, rankOf, newResetId, LATE_MS,
} from '/shared/checkpoints.mjs';

// ---- the running game (web/views/play.mjs) ------------------------------------------------------------------------
// The play view registers its game here while it runs: `flush()` writes the battery save and "where you left off" to
// disk now (for a copy), `settle()` waits for the uploads on their way. While a game's saves are held (going back)
// it writes nothing – not even when it closes: what it has is the game from after the checkpoint.
const games = new Map(); // stateId → { flush, settle }
const held = new Set();

export function registerGame(stateId, hooks) {
  games.set(stateId, hooks);
  return () => {
    if (games.get(stateId) === hooks) games.delete(stateId);
  };
}
export const savesHeld = (stateId) => held.has(stateId);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const autoKey = (stateId) => `sl-auto-${stateId}`;
const lsGet = (k) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? null : JSON.parse(v);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // private mode – the state isn't resumed, the save still is
  }
};

// ---- names ----------------------------------------------------------------------------------------------------------

/** "First Poké Balls", "Badge 3". */
export function checkpointName(cp) {
  if (!cp) return '';
  if (cp.id === 'balls' || cp.kind === 'balls') return t('cp.balls', 'First Poké Balls');
  const n = cp.n ?? Number(String(cp.id).replace(/^badge/, ''));
  return t('cp.badge', 'Badge {n}', { n });
}

/** The checkpoint log line's message (every computer writes the same, under one id). */
const reachedMsg = (cp, solo) => (cp.kind === 'balls'
  ? solo ? msg('feed.cpBallsSolo', 'Checkpoint: your first Poké Balls') : msg('feed.cpBalls', 'Checkpoint: everyone has their first Poké Balls')
  : solo ? msg('feed.cpBadgeSolo', 'Checkpoint: badge {n}', { n: cp.n })
    : msg('feed.cpBadge', 'Checkpoint: everyone has {n} badge|Checkpoint: everyone has {n} badges', { n: cp.n, count: cp.n }));

// ---- state of the run's checkpoints ------------------------------------------------------------------------------

const get = (doc) => (k) => doc.get(k, null);
const latestRankOf = (doc) => {
  const l = latestOf(doc.scan('cp:at:'));
  return l ? rankOf(l.id) : -1;
};

/** Is the rule on for this run? (never in Play together) */
export const checkpointsOn = (doc, manifest) => !!doc && !!manifest && !isTogether(manifest) && !!getRules(doc, manifest).checkpoints;

/**
 * What the board shows: { latest: { id, kind, n, at } | null, copies: { slot: { id, at, late } | null } (each player's
 * copy for it – from the moment they reached it), pending (this player's game still has to go back), reset }.
 */
export function checkpointState(doc, manifest, me) {
  const latest = latestOf(doc.scan('cp:at:'));
  const slots = slotsOf(manifest);
  return {
    latest,
    copies: latest ? copiesFor(doc.scan('cp:have:'), slots, rankOf(latest.id)) : {},
    pending: pendingReset(get(doc), me),
    reset: doc.get(RESET_KEY, null),
  };
}

/**
 * This computer's copy of `me`'s game for milestone `cp` – the running game written to disk first – with the run
 * document as it is now. Its time is the player's moment (the deaths after it are undone when going back).
 */
async function takeCopy(doc, manifest, me, cp, { late = false } = {}) {
  const stateId = runStateId(manifest, me);
  const at = Date.now();
  try {
    await games.get(stateId)?.flush?.();
  } catch {
    // copy what is on disk
  }
  await api.post(`/api/runs/${manifest.id}/checkpoints/${cp.id}/${me}`, { doc: snapshotOf(doc.entries), meta: lsGet(autoKey(stateId)), late, keepFrom: Math.max(0, latestRankOf(doc)) });
  doc.set(haveKey(cp.id, me), { at, ...(late ? { late: true } : {}) });
}

/**
 * Go back to the latest checkpoint – for everyone: the board as it stood when it was complete (this computer's copy of
 * it), the deaths after their players' own moments undone, and the "go back" every computer puts its own player's game
 * and part of the board back for. → { id } or throws (.code checkpointMissing: no copy of it here).
 */
export async function goBack(doc, manifest, me) {
  const latest = latestOf(doc.scan('cp:at:'));
  if (!latest) throw Object.assign(new Error('No checkpoint yet'), { code: 'noCheckpoint' });
  const snap = await api.get(`/api/runs/${manifest.id}/checkpoints/${latest.id}/doc`);
  const moments = momentsOf(doc.scan('cp:have:'), slotsOf(manifest), rankOf(latest.id));
  const writes = planReset(snap.entries, doc.entries, moments);
  const name = getPlayers(doc, manifest)[me]?.name || me.toUpperCase();
  doc.batch({ ...writes, [RESET_KEY]: { rid: newResetId(), id: latest.id, at: Date.now(), by: me } });
  feed(doc, { type: 'run', slot: me, msg: msg('feed.cpBack', '{name} went back to the checkpoint “{cp}” – every game returns to where it stood then', { name, cp: { key: latest.kind === 'balls' ? 'cp.balls' : 'cp.badge', def: latest.kind === 'balls' ? 'First Poké Balls' : 'Badge {n}', vars: { n: latest.n } } }),
    text: t('feed.cpBack', '{name} went back to the checkpoint “{cp}” – every game returns to where it stood then', { name, cp: checkpointName(latest) }) });
  return { id: latest.id };
}

/** The run document kept here with a copy (`slot`) or with the completed checkpoint – null when there is none. */
const docOf = (manifest, id, slot = null) => api.get(`/api/runs/${manifest.id}/checkpoints/${id}${slot ? `/${slot}` : ''}/doc`).then((d) => d?.entries || null, () => null);

/**
 * Put this player's game back for the "go back" `reset`: its saves are held, a running game of it closes, the server
 * puts their copy back (their first one of the checkpoint or later – the moment they reached it), their part of the
 * board goes back to that moment, what this computer wrote meanwhile from the old game goes back too, the copies from
 * after it are forgotten, then the game starts again (if it was running). o: { session, endSession, startSession }.
 * → { ok, missing?, emulator? }
 */
async function applyReset(doc, manifest, me, reset, o) {
  const stateId = runStateId(manifest, me);
  const resetT = doc.entries[RESET_KEY]?.t ?? reset.at;
  const copy = copyFor(doc.scan('cp:have:'), me, rankOf(reset.id));
  held.add(stateId);
  let restart = null;
  let out = { ok: false };
  try {
    if (!copy) throw Object.assign(new Error('no copy'), { code: 'checkpointMissing' });
    await games.get(stateId)?.settle?.();
    const s = o.session?.();
    if (s?.target?.runId === manifest.id && s.target.kind === 'run') {
      restart = s.target;
      o.endSession();
      for (let i = 0; i < 100 && games.has(stateId); i++) await sleep(100);
    }
    // (the fast and 3DS players let go of the save a moment after the game closed)
    let res = null;
    for (let i = 0; ; i++) {
      try {
        res = await api.post(`/api/runs/${manifest.id}/checkpoints/${copy.id}/${me}/restore`);
        break;
      } catch (e) {
        if (e.code === 'saveGameRunning' && i < 40) {
          await sleep(500);
          continue;
        }
        throw e;
      }
    }
    lsSet(autoKey(stateId), res.meta || null);
    // this player's part of the board as it stood at their moment (a copy from the first checkpoints version kept only
    // the checkpoint's board)
    const snap = await docOf(manifest, reset.id);
    const own = (await docOf(manifest, copy.id, me)) || snap;
    const writes = own ? ownPlan({ own, snap, cur: doc.entries, slot: me, device: doc.by, since: resetT, moment: copy.at }) : {};
    // the copies from after it: a future that is undone (the server dropped them)
    for (const c of copiesOfSlot(doc.scan('cp:have:'), me)) if (c.rank > copy.rank) writes[haveKey(c.id, me)] = null;
    if (Object.keys(writes).length) doc.batch(writes);
    out = { ok: true, emulator: !!res.emulator };
  } catch (e) {
    out = { ok: false, missing: e.code === 'checkpointMissing', error: e.message };
  } finally {
    doc.set(doneKey(me), { rid: reset.rid, at: Date.now(), ok: out.ok });
    held.delete(stateId);
  }
  if (restart) o.startSession(restart);
  return out;
}

/**
 * The app's part (web/app.mjs): keeps this computer's copy of its player's game at each milestone they reach, records
 * a checkpoint when everyone reached it (and keeps the board of that moment), and puts this player's game back when
 * anyone went back. o: { doc, manifest, me, session: () => session, startSession, endSession, toast }.
 */
export function useCheckpoints(o) {
  const ref = useRef(o);
  ref.current = o;
  const busy = useRef({ copy: null, reset: null, docs: new Set() });
  const { doc, manifest, me } = o;
  useEffect(() => {
    if (!doc || !manifest || !me || isTogether(manifest)) return undefined;
    let gone = false;
    const again = () => !gone && setTimeout(check, 0);
    function check() {
      if (gone) return;
      const g = get(doc);
      const slots = slotsOf(manifest);
      const r = getRules(doc, manifest);
      // 1. someone went back: this player's game goes back too (before anything else – it is from after the checkpoint)
      const reset = pendingReset(g, me);
      if (reset) {
        if (busy.current.reset === reset.rid) return;
        busy.current.reset = reset.rid;
        const cur = ref.current;
        applyReset(doc, manifest, me, reset, cur).then((res) => {
          const cp = { id: reset.id, kind: reset.id === 'balls' ? 'balls' : 'badge', n: rankOf(reset.id) };
          const who = getPlayers(doc, manifest)[reset.by]?.name || '';
          if (res.ok) {
            cur.toast?.({ kind: 'ok', ttl: 12000, title: t('cp.backTitle', 'Back to “{cp}”', { cp: checkpointName(cp) }),
              text: res.emulator ? t('cp.backEmulator', 'Your save went back. Close your emulator without saving and open the game again.')
                : reset.by === me ? t('cp.backMine', 'Your game is back where it stood then – the others’ games follow.') : t('cp.backOther', '{name} went back – your game is back where it stood then.', { name: who }) });
          } else {
            cur.toast?.({ kind: 'death', ttl: 20000, title: t('cp.backFailed', 'Your game couldn’t go back'),
              text: res.missing ? t('cp.backMissing', 'This computer has no copy of “{cp}” – your game stays as it is.', { cp: checkpointName(cp) }) : res.error || '' });
          }
        }).finally(() => {
          busy.current.reset = null;
          again();
        });
        return;
      }
      if (!r.checkpoints) return;
      // 2. everyone reached a new checkpoint: record it (every computer writes the same, so one of them wins)
      const due = dueCheckpoint(g, doc.scan('cp:at:'), slots, r);
      if (due && !doc.get(atKey(due.id), null)) {
        const cp = { id: due.id, kind: due.kind, n: due.n, at: Date.now() };
        doc.set(atKey(due.id), cp);
        const m = reachedMsg(cp, slots.length === 1);
        feed(doc, { type: 'run', slot: me, msg: m, text: t(m.key, m.def, m.vars) }, `cp-${due.id}`);
      }
      const latest = latestOf(doc.scan('cp:at:'));
      const latestRank = latest ? rankOf(latest.id) : -1;
      // 3. the board when it was complete – kept on every computer (whoever goes back takes it from their own)
      if (latest && !busy.current.docs.has(latest.id)) {
        busy.current.docs.add(latest.id);
        api.post(`/api/runs/${manifest.id}/checkpoints/${latest.id}/doc`, { doc: snapshotOf(doc.entries), keepFrom: latestRank })
          .catch((e) => {
            busy.current.docs.delete(latest.id);
            console.warn('checkpoint board', e);
          });
      }
      // 4. this player reached a new milestone: their copy, now – it is where they go back to (one at a time; after a
      // failed one the next try waits a little)
      if (busy.current.copy || Date.now() - (busy.current.failedAt || 0) < 30000) return;
      const haves = doc.scan('cp:have:');
      const mine = copyDue(haves, me, ownMilestone(g, me, r), latestRank);
      // (no copy for the latest checkpoint at all – souldew wasn't open when this player got there: one now, late)
      const want = mine ? { cp: mine, late: false }
        : latest && !copyFor(haves, me, latestRank) ? { cp: latest, late: Date.now() - (Number(latest.at) || 0) > LATE_MS } : null;
      if (!want) return;
      busy.current.copy = want.cp.id;
      takeCopy(doc, manifest, me, want.cp, { late: want.late }).catch((e) => {
        busy.current.failedAt = Date.now();
        console.warn('checkpoint copy', e);
      }).finally(() => {
        busy.current.copy = null;
        again();
      });
    }
    const unsub = doc.subscribe((keys) => {
      if (keys.some((k) => k.startsWith('cp:') || k === 'rules' || k.startsWith('balls:') || k.startsWith('live:') || k === 'run:status')) check();
    });
    check();
    return () => {
      gone = true;
      unsub();
    };
  }, [doc, manifest, me]);
}

/** Is this player's game waiting to go back? Then nothing it shows counts (web/app.mjs applySnap). */
export const resetPending = (doc, me) => !!doc && !!me && !!pendingReset(get(doc), me);
