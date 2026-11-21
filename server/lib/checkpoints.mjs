// Checkpoints of a run (shared/checkpoints.mjs) on this computer: a copy of this computer's player's game at the moment
// every player reached a milestone, and of the run document as it stood then. Each computer keeps only its own
// player's copy – the partners' games are on their computers.
//
//   <run>/checkpoints/<id>/doc.json             the run document's restorable entries (the first copy taken here)
//   <run>/checkpoints/<id>/<slot>/info.json     { id, slot, at, late, meta, save, state, archiveRel }
//   <run>/checkpoints/<id>/<slot>/save.sav      the battery save (none: the game had never been saved in-game)
//   <run>/checkpoints/<id>/<slot>/save3ds/      3DS: the game's save folder (data/00000001), timestamps kept
//   <run>/checkpoints/<id>/<slot>/state.*       "where you left off" (the play view's state, slot 99) with picture and info
//   <run>/checkpoints/_before/<stamp>-<slot>/   what a "go back" replaced (the last few, per player)
//
// `meta` is the play view's note of that state ({ at, save, core } – web/views/play.mjs): it resumes the state only
// while the save on disk is the one it was taken with, so the save and the state go back together.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { AUTO_SLOT, STATE_EXT, statePath, rotateAutoState } from './statefiles.mjs';
import { validId, rankOf } from '../../shared/checkpoints.mjs';

/** Checkpoints kept per run (the newest): going back is to the latest – one more for a copy taken a moment late. */
export const KEEP = 2;
/** What "go back" replaced, kept per player. */
export const BEFORE_KEEP = 3;
const BEFORE = '_before';
const SLOT_RE = /^p[1-5]$/;

export const checkpointsDir = (runDir) => join(runDir, 'checkpoints');
const cpDir = (runDir, id) => join(checkpointsDir(runDir), id);
const slotDir = (runDir, id, slot) => join(cpDir(runDir, id), slot);
const stampNow = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');

function check(id, slot) {
  if (!validId(id)) throw httpError(400, 'Invalid checkpoint', 'badCheckpoint');
  if (slot !== undefined && !SLOT_RE.test(String(slot))) throw httpError(400, 'Invalid player', 'badPlayer');
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const dirs = (p) => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Copy "where you left off" (its state, picture and info) from `fromDir`/`fromKey`/`fromSlot` naming to `to(ext)`. */
function copyState(from, to) {
  let any = false;
  for (const ext of STATE_EXT) {
    const src = from(ext);
    if (isFile(src)) {
      copyFileSync(src, to(ext));
      if (ext === 'state') any = true;
    }
  }
  return any;
}

/** Keep the newest KEEP checkpoints (by rank – later milestones are newer); never the one just written (`keep`). */
function prune(runDir, keep) {
  const ids = dirs(checkpointsDir(runDir)).filter(validId).sort((a, b) => rankOf(b) - rankOf(a));
  const stay = new Set([keep, ...ids.slice(0, KEEP)]);
  for (const id of ids) if (!stay.has(id)) rmSync(cpDir(runDir, id), { recursive: true, force: true });
}

/**
 * Keep this computer's copy of `slot`'s game for checkpoint `id`: the battery save at `savePath` – or, 3DS, the save
 * folder `archive` (under `saveRoot`) –, "where you left off" (`stateDir` / `stateKey`, slot 99) and, the first time,
 * the run document's restorable entries `doc`. Copying again (the same checkpoint once more) replaces the copy.
 * → the info written.
 */
export function storeCheckpoint({ runDir, id, slot, savePath = null, archive = null, saveRoot = null, stateDir, stateKey, doc = null, meta = null, late = false, now = Date.now() }) {
  check(id, slot);
  const dir = slotDir(runDir, id, slot);
  const fresh = `${dir}.new-${randomBytes(4).toString('hex')}`;
  mkdirSync(fresh, { recursive: true });
  let save = false;
  let archiveRel = null;
  try {
    if (archive) {
      if (existsSync(archive)) {
        cpSync(archive, join(fresh, 'save3ds'), { recursive: true, preserveTimestamps: true });
        save = true;
      }
      if (saveRoot) archiveRel = relative(saveRoot, archive).split(sep).join('/');
    } else if (savePath && isFile(savePath)) {
      copyFileSync(savePath, join(fresh, 'save.sav'));
      save = true;
    }
    const state = copyState((ext) => statePath(stateDir, stateKey, AUTO_SLOT, ext), (ext) => join(fresh, `state.${ext}`));
    const info = { id, slot, at: now, late: !!late, meta: meta && typeof meta === 'object' ? meta : null, save, state, ...(archiveRel ? { archiveRel } : {}) };
    writeFileAtomic(join(fresh, 'info.json'), JSON.stringify(info));
    rmSync(dir, { recursive: true, force: true });
    renameSync(fresh, dir);
    // the run document as it stood then: the first copy taken on this computer is the one nearest the moment
    const docPath = join(cpDir(runDir, id), 'doc.json');
    if (doc && typeof doc === 'object' && !existsSync(docPath)) writeFileAtomic(docPath, JSON.stringify({ at: now, entries: doc }));
    prune(runDir, id);
    return info;
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
}

/** The checkpoints kept here: [{ id, doc: { at } | null, slots: { slot: info } }], the newest first. */
export function listCheckpoints(runDir) {
  const out = [];
  for (const id of dirs(checkpointsDir(runDir)).filter(validId)) {
    const slots = {};
    for (const s of dirs(cpDir(runDir, id)).filter((x) => SLOT_RE.test(x))) {
      const info = readJson(join(slotDir(runDir, id, s), 'info.json'));
      if (info) slots[s] = info;
    }
    const doc = readJson(join(cpDir(runDir, id), 'doc.json'));
    out.push({ id, doc: doc ? { at: doc.at ?? null } : null, slots });
  }
  return out.sort((a, b) => rankOf(b.id) - rankOf(a.id));
}

/** The run document's entries kept with checkpoint `id`, or null. */
export function checkpointDoc(runDir, id) {
  check(id);
  const d = readJson(join(cpDir(runDir, id), 'doc.json'));
  return d && d.entries && typeof d.entries === 'object' ? d : null;
}

/** Keep what a "go back" is about to replace – the last BEFORE_KEEP per player. */
function keepBefore(runDir, slot, { savePath, archive, stateDir, stateKey, now }) {
  const root = join(checkpointsDir(runDir), BEFORE);
  const dir = join(root, `${stampNow(now)}-${slot}`);
  mkdirSync(dir, { recursive: true });
  if (archive && existsSync(archive)) cpSync(archive, join(dir, 'save3ds'), { recursive: true, preserveTimestamps: true });
  else if (savePath && isFile(savePath)) copyFileSync(savePath, join(dir, 'save.sav'));
  copyState((ext) => statePath(stateDir, stateKey, AUTO_SLOT, ext), (ext) => join(dir, `state.${ext}`));
  const mine = dirs(root).filter((n) => n.endsWith(`-${slot}`)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BEFORE_KEEP))) rmSync(join(root, old), { recursive: true, force: true });
  return dir;
}

/**
 * Put `slot`'s game back to its copy of checkpoint `id`: the battery save (or 3DS save folder) and "where you left off"
 * – what is there now is kept in `_before` first. A checkpoint taken before the first in-game save has none: the save
 * there now goes too (into `_before`), so the state is resumed from a game without one, as it was taken.
 * savePath / archive (3DS: the save folder now, or null) / saveRoot (3DS: where its folders are), stateDir / stateKey.
 * → { save, state, meta } – `meta` for the play view's note of the state (null: none to resume).
 */
export function restoreCheckpoint({ runDir, id, slot, savePath = null, archive = null, saveRoot = null, stateDir, stateKey, now = Date.now() }) {
  check(id, slot);
  const src = slotDir(runDir, id, slot);
  const info = readJson(join(src, 'info.json'));
  if (!info) throw httpError(404, 'This computer has no copy of that checkpoint', 'checkpointMissing');
  const before = keepBefore(runDir, slot, { savePath, archive, stateDir, stateKey, now });
  // the save
  if (saveRoot !== null) {
    const target = archive || (info.archiveRel ? join(saveRoot, ...info.archiveRel.split('/')) : null);
    if (target) {
      const aside = `${target}.old-${randomBytes(4).toString('hex')}`;
      if (existsSync(target)) renameSync(target, aside);
      try {
        if (info.save && existsSync(join(src, 'save3ds'))) {
          mkdirSync(join(target, '..'), { recursive: true });
          cpSync(join(src, 'save3ds'), target, { recursive: true, preserveTimestamps: true });
        }
      } catch (e) {
        rmSync(target, { recursive: true, force: true });
        if (existsSync(aside)) renameSync(aside, target);
        throw e;
      }
      rmSync(aside, { recursive: true, force: true });
    }
  } else if (savePath) {
    if (info.save && isFile(join(src, 'save.sav'))) writeFileAtomic(savePath, readFileSync(join(src, 'save.sav')));
    else rmSync(savePath, { force: true });
  }
  // "where you left off"
  let state = false;
  if (info.state && isFile(join(src, 'state.state'))) {
    mkdirSync(stateDir, { recursive: true });
    rotateAutoState(stateDir, stateKey);
    for (const ext of STATE_EXT) rmSync(statePath(stateDir, stateKey, AUTO_SLOT, ext), { force: true });
    state = copyState((ext) => join(src, `state.${ext}`), (ext) => statePath(stateDir, stateKey, AUTO_SLOT, ext));
  } else {
    // (a state from after the checkpoint must not be resumed – it is in `_before`)
    for (const ext of STATE_EXT) rmSync(statePath(stateDir, stateKey, AUTO_SLOT, ext), { force: true });
  }
  return { save: !!info.save, state, meta: state ? info.meta || null : null, before: relative(runDir, before).split(sep).join('/') };
}
