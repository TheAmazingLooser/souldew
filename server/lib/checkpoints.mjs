// Checkpoints of a run (shared/checkpoints.mjs) on this computer: a copy of this computer's player's game at the moment
// that player reached a milestone (their first Poké Balls, each new badge), with the run document as it stood then, and
// the run document of each checkpoint once everyone reached it. Each computer keeps only its own player's games – the
// partners' are on their computers.
//
//   <run>/checkpoints/<id>/doc.json             the run document's restorable entries when everyone had reached it
//   <run>/checkpoints/<id>/<slot>/info.json     { id, slot, at, late, meta, save, state, archiveRel }
//   <run>/checkpoints/<id>/<slot>/doc.json      the run document's restorable entries at that player's moment
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

/**
 * Drop what no go-back can use any more: everything below the latest checkpoint (`keepFrom`, its rank – going back is to
 * that one, and a player's copy for it is one of it or later). Never `keep` (just written). No `keepFrom`: nothing goes.
 */
function prune(runDir, keepFrom, keep) {
  if (!Number.isInteger(keepFrom) || keepFrom < 0) return;
  for (const id of dirs(checkpointsDir(runDir)).filter(validId)) if (id !== keep && rankOf(id) < keepFrom) rmSync(cpDir(runDir, id), { recursive: true, force: true });
}

/** `slot`'s copies from after `rank` – from a future that a go-back to it undid. */
function dropAfter(runDir, slot, rank) {
  for (const id of dirs(checkpointsDir(runDir)).filter(validId)) {
    if (rankOf(id) <= rank) continue;
    rmSync(slotDir(runDir, id, slot), { recursive: true, force: true });
    if (!dirs(cpDir(runDir, id)).length && !existsSync(join(cpDir(runDir, id), 'doc.json'))) rmSync(cpDir(runDir, id), { recursive: true, force: true });
  }
}

/**
 * Keep this computer's copy of `slot`'s game for milestone `id`: the battery save at `savePath` – or, 3DS, the save
 * folder `archive` (under `saveRoot`) –, "where you left off" (`stateDir` / `stateKey`, slot 99) and the run document's
 * restorable entries `doc` as they are now. Copying again (the same milestone once more) replaces the copy. `keepFrom`:
 * the latest checkpoint's rank (prune). → the info written.
 */
export function storeCheckpoint({ runDir, id, slot, savePath = null, archive = null, saveRoot = null, stateDir, stateKey, doc = null, meta = null, late = false, keepFrom = null, now = Date.now() }) {
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
    // the run document at this player's moment – their own part of the board comes back from it
    if (doc && typeof doc === 'object') writeFileAtomic(join(fresh, 'doc.json'), JSON.stringify({ at: now, entries: doc }));
    rmSync(dir, { recursive: true, force: true });
    renameSync(fresh, dir);
    prune(runDir, keepFrom, id);
    return info;
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
}

/**
 * The run document's entries `doc` when checkpoint `id` was complete (everyone had reached it) – the first one this
 * computer saw is kept. → { at }.
 */
export function storeCheckpointDoc({ runDir, id, doc, keepFrom = null, now = Date.now() }) {
  check(id);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw httpError(400, 'Invalid checkpoint', 'badCheckpoint');
  const p = join(cpDir(runDir, id), 'doc.json');
  if (!existsSync(p)) {
    mkdirSync(cpDir(runDir, id), { recursive: true });
    writeFileAtomic(p, JSON.stringify({ at: now, entries: doc }));
  }
  prune(runDir, keepFrom, id);
  return { at: readJson(p)?.at ?? now };
}

/** The checkpoints kept here: [{ id, doc: { at } | null, slots: { slot: info + doc } }], the newest first. */
export function listCheckpoints(runDir) {
  const out = [];
  for (const id of dirs(checkpointsDir(runDir)).filter(validId)) {
    const slots = {};
    for (const s of dirs(cpDir(runDir, id)).filter((x) => SLOT_RE.test(x))) {
      const info = readJson(join(slotDir(runDir, id, s), 'info.json'));
      if (info) slots[s] = { ...info, doc: existsSync(join(slotDir(runDir, id, s), 'doc.json')) };
    }
    const doc = readJson(join(cpDir(runDir, id), 'doc.json'));
    out.push({ id, doc: doc ? { at: doc.at ?? null } : null, slots });
  }
  return out.sort((a, b) => rankOf(b.id) - rankOf(a.id));
}

/** The run document's entries kept with checkpoint `id` – when it was complete, or (`slot`) at that player's moment. */
export function checkpointDoc(runDir, id, slot = null) {
  check(id, slot ?? undefined);
  const d = readJson(join(slot ? slotDir(runDir, id, slot) : cpDir(runDir, id), 'doc.json'));
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
 * Put `slot`'s game back to its copy `id`: the battery save (or 3DS save folder) and "where you left off" – what is
 * there now is kept in `_before` first. A copy taken before the first in-game save has none: the save there now goes
 * too (into `_before`), so the state is resumed from a game without one, as it was taken. The player's copies from
 * after it go: that future is undone.
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
  dropAfter(runDir, slot, rankOf(id));
  return { save: !!info.save, state, meta: state ? info.meta || null : null, at: info.at, before: relative(runDir, before).split(sep).join('/') };
}
