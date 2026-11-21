// Checkpoints on the board (shared/checkpoints.mjs, web/lib/checkpoints.mjs): where the run stands – the latest
// checkpoint and whose computers keep their copy of it – and "go back", from the Rules tab and the "run is over" notice.
import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { players as getPlayers, rules as getRules, slotsOf } from '../lib/run.mjs';
import { checkpointState, checkpointsOn, checkpointName, goBack } from '../lib/checkpoints.mjs';

/** "Go back to the checkpoint …" – a button that opens the dialog; nothing while there is no checkpoint to go back to. */
export function GoBackButton({ primary = false, onDone = null }) {
  const { doc, manifest, me } = useApp();
  const [open, setOpen] = useState(false);
  if (!checkpointsOn(doc, manifest)) return null;
  const st = checkpointState(doc, manifest, me);
  if (!st.latest) return null;
  return html`<button class=${`btn ${primary ? 'primary' : 'ghost'}`} disabled=${!!st.pending} onClick=${() => setOpen(true)}
      title=${t('cp.goBackHint', 'Every game goes back to “{cp}”', { cp: checkpointName(st.latest) })}>
      <${Icon} name="reset" size=${14} />${t('cp.goBackTo', 'Back to “{cp}” …', { cp: checkpointName(st.latest) })}</button>
    ${open && html`<${GoBackModal} onClose=${() => setOpen(false)} onDone=${() => { setOpen(false); onDone?.(); }} />`}`;
}

/** The confirmation: what going back does, and whose copies there are. */
export function GoBackModal({ onClose, onDone }) {
  const { doc, manifest, me } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const st = checkpointState(doc, manifest, me);
  const cp = st.latest;
  if (!cp) return null;
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const n = slots.length;
  const name = checkpointName(cp);
  const missing = slots.filter((s) => !st.copies[s]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await goBack(doc, manifest, me);
      onDone?.();
    } catch (e) {
      setError(e.code === 'checkpointMissing'
        ? t('cp.noDocHere', 'This computer has no copy of “{cp}” – go back from the computer of a player who has one.', { cp: name })
        : e.message);
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} onClose=${() => !busy && onClose()} title=${t('cp.goBackTitle', 'Back to “{cp}”?', { cp: name })}
    footer=${html`<button class="btn ghost" disabled=${busy} onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn primary" disabled=${busy} onClick=${go}><${Icon} name="reset" size=${14} />${busy ? t('cp.goingBack', 'Going back …') : t('cp.goBack', 'Go back')}</button>`}>
    <p>${n > 1
      ? t('cp.goBackText', 'Each player’s game goes back to the moment that player reached “{cp}” (the last of you {when}). Linked Pokémon that fell after their player’s moment are alive again – one that fell before stays dead –, the catches since are undone, and a run that ended goes on.', { cp: name, when: ago(cp.at) })
      : t('cp.goBackTextSolo', 'Your game goes back to “{cp}” ({when}). The Pokémon that died since are alive again, the catches since are undone, and a run that ended goes on.', { cp: name, when: ago(cp.at) })}</p>
    <p class="small muted">${t('cp.goBackRunning', 'A game that is running closes and starts again from there by itself. Play in an external emulator? Close it without saving first.')}</p>
    ${n > 1 && html`<ul class="small muted">${slots.map((s) => html`<li key=${s}>${copyLine(s, st.copies[s], names[s]?.name || s.toUpperCase(), s === me)}</li>`)}</ul>`}
    ${missing.length > 0 && html`<p class="warning info small">${t('cp.missingCopies', 'A computer without a copy can’t take its player’s game back – that game stays as it is.')}</p>`}
    <p class="small faint">${t('cp.goBackKept', 'The log keeps what happened. Each computer keeps the game as it is now as well (the run folder’s checkpoints).')}</p>
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
  <//>`;
}

function copyLine(slot, copy, name, mine) {
  if (!copy) return mine ? t('cp.copyWaitingMine', 'You: no copy yet') : t('cp.copyWaiting', '{name}: no copy yet (their computer saves it once souldew is open)', { name });
  const when = copy.late ? ` · ${t('cp.copyLate', 'taken later')}` : '';
  return (mine ? t('cp.copyMine', 'You: copy kept') : t('cp.copyKept', '{name}: copy kept', { name })) + when;
}

/** The Rules tab's status: the latest checkpoint, whose copies there are, and "go back". */
export function CheckpointStatus() {
  const { doc, manifest, me } = useApp();
  if (!checkpointsOn(doc, manifest)) return null;
  const st = checkpointState(doc, manifest, me);
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const n = slots.length;
  const balls = !!getRules(doc, manifest).startAtBalls;
  if (st.pending) {
    return html`<p class="small muted" role="status"><${Led} on color="amber" blink />${t('cp.pending', 'Your game is going back to the checkpoint …')}</p>`;
  }
  if (!st.latest) {
    return html`<p class="small muted">${n > 1
      ? balls ? t('cp.noneYet', 'No checkpoint yet – the first one comes when all of you have your first Poké Balls.') : t('cp.noneYetBadge', 'No checkpoint yet – the first one comes when all of you have your first badge.')
      : balls ? t('cp.noneYetSolo', 'No checkpoint yet – the first one comes with your first Poké Balls.') : t('cp.noneYetSoloBadge', 'No checkpoint yet – the first one comes with your first badge.')}</p>`;
  }
  return html`<div class="stack-s">
    <p class="small"><b>${t('cp.latest', 'Latest checkpoint: {cp}', { cp: checkpointName(st.latest) })}</b> <span class="faint">· ${ago(st.latest.at)}</span></p>
    ${n > 1 && html`<ul class="small muted">${slots.map((s) => html`<li key=${s}>${copyLine(s, st.copies[s], names[s]?.name || s.toUpperCase(), s === me)}</li>`)}</ul>`}
    <p class="tiny faint">${n > 1 ? t('cp.nextHint', 'The next one comes when all of you have one more badge.') : t('cp.nextHintSolo', 'The next one comes with your next badge.')}</p>
    <div class="row"><${GoBackButton} /></div>
  </div>`;
}
