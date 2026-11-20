// Who plays a run: 1–5 player slots (p1..pN) and the run mode. Shared by the server (builds, summaries)
// and the browser (web/lib/run.mjs re-exports it), so both read a manifest the same way.

/**
 * Every player slot a run can have, in order. A fifth player (p5) arrived after 3.0: a run with p5 travels as its own
 * run-pack format (shared/runpack.mjs), so an app that only knows p1–p4 refuses it instead of dropping that player.
 */
export const ALL_SLOTS = ['p1', 'p2', 'p3', 'p4', 'p5'];

/** The most players a run can have (a SoulLink or Play together; a Nuzlocke is always one). */
export const MAX_PLAYERS = ALL_SLOTS.length;

/** The player counts a new SoulLink or Play together can be set up with: 2 … MAX_PLAYERS. */
export const PLAYER_COUNTS = ALL_SLOTS.slice(1).map((_, i) => i + 2);

/** Is `slot` one of the run slots (p1 … p5)? */
export const isSlot = (slot) => ALL_SLOTS.includes(slot);
export const MODES = ['soullink', 'nuzlocke', 'together'];

/**
 * 'soullink' (2–5 players), 'nuzlocke' (solo) or 'together' (3.0, "Play together": 2–5 players in their own normal
 * games – trades, battles, Shared World, raids – without any challenge rules; shared/playtogether.mjs). Runs from
 * before modes existed are SoulLinks.
 */
export function runMode(manifest) {
  const m = manifest?.mode;
  return m === 'nuzlocke' || m === 'together' ? m : 'soullink';
}

/** A solo Nuzlocke (one player, no partner) rather than a SoulLink. */
export const isNuzlocke = (manifest) => runMode(manifest) === 'nuzlocke';

/** "Play together": the players' own games, no challenge – no encounters, deaths, caps or a run that can fail. */
export const isTogether = (manifest) => runMode(manifest) === 'together';

/** A challenge run (SoulLink or Nuzlocke) – the rules, the tracker's encounters and deaths apply. */
export const isChallenge = (manifest) => runMode(manifest) !== 'together';

/**
 * A run's mode as the souldew accounts service takes it (friend presence, friend invites, recent runs):
 * 'soullink' | 'nuzlocke' | 'together' (the service takes 'together' since 19 Nov 2026).
 */
export const wireMode = (manifest) => runMode(manifest);

/** The app section a run lives in (its route): Play together runs are in the SoulLink section, next to the SoulLinks. */
export const runSection = (manifest) => (runMode(manifest) === 'nuzlocke' ? 'nuzlocke' : 'soullink');

/**
 * The run's slots in order. Players are contiguous (p1..pN); a SoulLink has at least two – older manifests
 * (and packs) always had p1+p2, and a missing p2 there still means "the partner who hasn't joined yet".
 */
export function slotsOf(manifest) {
  if (runMode(manifest) === 'nuzlocke') return ['p1'];
  const players = manifest?.players && typeof manifest.players === 'object' ? manifest.players : {};
  const slots = [];
  for (const s of ALL_SLOTS) {
    if (!players[s]) break;
    slots.push(s);
  }
  return slots.length >= 2 ? slots : ['p1', 'p2'];
}

/**
 * A new run's name when none is given: "Lou & Noa", "Lou, Noa & Robin" – or "Lou – Nuzlocke" solo, "Lou & Noa –
 * together" for Play together (the mode shows in places that only carry the name, like a friend invite).
 */
export function defaultRunName(players, mode) {
  const names = ALL_SLOTS.filter((s) => players?.[s]).map((s) => players[s].name || s.toUpperCase());
  if (mode === 'nuzlocke') return `${names[0]} – Nuzlocke`;
  const all = names.length > 2 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names.join(' & ');
  return mode === 'together' ? `${all} – together` : all;
}

/** The other players of the run (empty in a solo Nuzlocke). */
export function othersOf(slot, manifest) {
  return slotsOf(manifest).filter((s) => s !== slot);
}
