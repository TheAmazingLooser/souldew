// Checkpoints in the app (shared/checkpoints.mjs): recording one when every player reached it, keeping this
// computer's copy of its player's game, going back to the latest one, and putting this player's game back when anyone
// went back. The copies are on the server (server/lib/checkpoints.mjs, /api/runs/:id/checkpoints).
import { useEffect, useRef } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { t } from './i18n.mjs';
import { feed, msg, rules as getRules, players as getPlayers, isTogether, runStateId } from './run.mjs';
import { slotsOf } from '/shared/slots.mjs';
import {
  RESET_KEY, atKey, haveKey, doneKey, dueCheckpoint, latestOf, pendingReset, snapshotOf, restoreWrites, staleOwnWrites,
  copiesOf, newResetId, LATE_MS,
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

/** Is the rule on for this run? (never in Play together) */
export const checkpointsOn = (doc, manifest) => !!doc && !!manifest && !isTogether(manifest) && !!getRules(doc, manifest).checkpoints;

/**
 * What the board shows: { latest: { id, kind, n, at } | null, copies: { slot: { at, late } | null }, pending (this
 * player's game still has to go back), reset (the last go-back) }.
 */
export function checkpointState(doc, manifest, me) {
  const latest = latestOf(doc.scan('cp:at:'));
  const slots = slotsOf(manifest);
  return {
    latest,
    copies: latest ? copiesOf(get(doc), latest.id, slots) : {},
    pending: pendingReset(get(doc), me),
    reset: doc.get(RESET_KEY, null),
  };
}

/** This computer's copy of `me`'s game for checkpoint `cp` – the running game written to disk first. */
async function takeCopy(doc, manifest, me, cp) {
  const stateId = runStateId(manifest, me);
  try {
    await games.get(stateId)?.flush?.();
  } catch {
    // copy what is on disk
  }
  const late = Date.now() - (Number(cp.at) || Date.now()) > LATE_MS;
  await api.post(`/api/runs/${manifest.id}/checkpoints/${cp.id}/${me}`, { doc: snapshotOf(doc.entries), meta: lsGet(autoKey(stateId)), late });
  doc.set(haveKey(cp.id, me), { at: Date.now(), ...(late ? { late: true } : {}) });
}

/**
 * Go back to the latest checkpoint – for everyone: the board's keys as they were (from this computer's copy of the run
 * document) and the "go back" every computer puts its own game back for. → { id } or throws (.code checkpointMissing:
 * no copy of it here).
 */
export async function goBack(doc, manifest, me) {
  const latest = latestOf(doc.scan('cp:at:'));
  if (!latest) throw Object.assign(new Error('No checkpoint yet'), { code: 'noCheckpoint' });
  const snap = await api.get(`/api/runs/${manifest.id}/checkpoints/${latest.id}/doc`);
  const writes = restoreWrites(snap.entries, doc.entries);
  const name = getPlayers(doc, manifest)[me]?.name || me.toUpperCase();
  doc.batch({ ...writes, [RESET_KEY]: { rid: newResetId(), id: latest.id, at: Date.now(), by: me } });
  feed(doc, { type: 'run', slot: me, msg: msg('feed.cpBack', '{name} went back to the checkpoint “{cp}” – every game returns to where it stood then', { name, cp: { key: latest.kind === 'balls' ? 'cp.balls' : 'cp.badge', def: latest.kind === 'balls' ? 'First Poké Balls' : 'Badge {n}', vars: { n: latest.n } } }),
    text: t('feed.cpBack', '{name} went back to the checkpoint “{cp}” – every game returns to where it stood then', { name, cp: checkpointName(latest) }) });
  return { id: latest.id };
}

/**
 * Put this player's game back for the "go back" `reset`: its saves are held, a running game of it closes, the server
 * puts the copy back, what this computer wrote meanwhile from the old game goes back too, then the game starts again
 * (if it was running). o: { session, endSession, startSession, toast }. → { ok, missing?, emulator? }
 */
async function applyReset(doc, manifest, me, reset, o) {
  const stateId = runStateId(manifest, me);
  const resetEntry = doc.entries[RESET_KEY];
  held.add(stateId);
  let restart = null;
  let out = { ok: false };
  try {
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
        res = await api.post(`/api/runs/${manifest.id}/checkpoints/${reset.id}/${me}/restore`);
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
    // what this computer's game wrote after the go-back (before it heard of it) is from after the checkpoint too
    try {
      const snap = await api.get(`/api/runs/${manifest.id}/checkpoints/${reset.id}/doc`);
      const stale = staleOwnWrites(snap.entries, doc.entries, doc.by, resetEntry?.t ?? reset.at);
      if (Object.keys(stale).length) doc.batch(stale);
    } catch {
      // (no copy of the document here: the go-back's own writes stand)
    }
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
 * The app's part (web/app.mjs): records a checkpoint when everyone reached it, keeps this computer's copy of it, and
 * puts this player's game back when anyone went back. o: { doc, manifest, me, session: () => session, startSession,
 * endSession, toast }.
 */
export function useCheckpoints(o) {
  const ref = useRef(o);
  ref.current = o;
  const busy = useRef({ copy: null, reset: null });
  const { doc, manifest, me } = o;
  useEffect(() => {
    if (!doc || !manifest || !me || isTogether(manifest)) return undefined;
    let gone = false;
    const check = () => {
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
          const cp = { id: reset.id, kind: reset.id === 'balls' ? 'balls' : 'badge', n: Number(String(reset.id).replace(/^badge/, '')) || 0 };
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
          if (!gone) setTimeout(check, 0);
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
      // 3. this computer keeps its copy of the latest checkpoint (once)
      const latest = latestOf(doc.scan('cp:at:'));
      if (latest && !doc.get(haveKey(latest.id, me), null) && busy.current.copy !== latest.id) {
        busy.current.copy = latest.id;
        takeCopy(doc, manifest, me, latest).catch((e) => console.warn('checkpoint copy', e)).finally(() => {
          busy.current.copy = null;
        });
      }
    };
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
