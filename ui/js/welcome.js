// The welcome pill, opened from the app menu. One pill in the mode bar's place,
// made of the same parts: a hint with keys, toggles, the white primary, close.
// It sets up the global shortcut (portal, or a config line to paste) and start
// on login.

import { native } from './native.js';
import { I } from './icons.js';
import { $, clamp, show, hide, isShown } from './dom.js';

/** syncInput(): tell the host the clickable parts changed. */
export function initWelcome({ syncInput }) {
  const pill = $('#welcome');
  const note = $('#wNote');
  const wBtn = (k) => $(`[data-wact="${k}"]`, pill);
  const KEY_NAMES = { LOGO: 'Super', SUPER: 'Super', SHIFT: 'Shift', CTRL: 'Ctrl', CONTROL: 'Ctrl', ALT: 'Alt' };
  const keysHtml = (t) => t.split('+').map((k) => k.trim()).filter(Boolean)
    .map((k) => `<kbd>${KEY_NAMES[k.toUpperCase()] || (k.length === 1 ? k.toUpperCase() : k)}</kbd>`).join('');
  let WEL = null;

  // Blur out, change, blur back in: the same swap the primary buttons use.
  function wSwap(el, html) {
    el.classList.add('swap');
    setTimeout(() => { el.innerHTML = html; el.classList.remove('swap'); }, 90);
  }
  function wShortcutLabel(state) {
    const b = wBtn('shortcut'), pl = $('.pl', b);
    // Label swaps (Copy → Copied) must not resize the pill.
    if (pl.innerHTML) b.style.minWidth = `${b.getBoundingClientRect().width}px`;
    const html = state === 'set' ? `${I.check}Shortcut set`
      : state === 'copied' ? `${I.check}Copied`
      : WEL.shortcutPortal ? `${I.keyboard}Set shortcut`
      : `${I.copy}${WEL.snippets.name ? `Copy for ${WEL.snippets.name}` : 'Copy command'}`;
    b.classList.toggle('on', state === 'set' || state === 'copied');
    if (pl.innerHTML) wSwap(pl, html); else pl.innerHTML = html;
  }

  function showWelcome(info) {
    WEL = info;
    $('#wHint').innerHTML = `Press ${keysHtml(info.shortcut || 'Super+Shift+S')} to capture`;
    const sc = wBtn('shortcut');
    $('.pl', sc).innerHTML = '';
    sc.style.minWidth = '';
    wShortcutLabel(info.shortcut ? 'set' : 'idle');
    hide(note, true);
    // Compositors configured by file start the app on the first press (D-Bus
    // activation): no login toggle to explain there.
    const login = wBtn('login');
    login.hidden = !info.shortcutPortal && !!info.snippets.file;
    login.classList.toggle('on', !!info.autostart);
    login.setAttribute('aria-pressed', String(!!info.autostart));
    show(pill);
    syncInput();
  }
  function hideWelcome(instant = false) {
    if (!isShown(pill)) return;
    hide(pill, instant);
    hide(note, instant);
    syncInput();
  }

  pill.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-wact]');
    if (!b || !WEL) return;
    const act = b.dataset.wact;
    if (act === 'close') return hideWelcome();
    if (act === 'try') { hideWelcome(true); return native.send('w-try'); }
    if (act === 'login') {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      const r = await native.call('w-login', { on }).catch(() => ({ on: !on }));
      b.classList.toggle('on', !!r.on);
      b.setAttribute('aria-pressed', String(!!r.on));
      return;
    }
    if (act === 'shortcut') {
      if (WEL.shortcutPortal) {
        b.disabled = true;
        const r = await native.call('w-bind').catch(() => ({ ok: false }));
        b.disabled = false;
        if (r.ok) {
          wShortcutLabel('set');
          wSwap($('#wHint'), `Press ${keysHtml(r.shortcut || 'Super+Shift+S')} to capture`);
          return;
        }
        WEL.shortcutPortal = false; // the desktop couldn't: fall back to the command
        wShortcutLabel('idle');
        return;
      }
      await native.call('w-copy', { text: WEL.snippets.bind });
      wShortcutLabel('copied');
      // Where to paste it: a note under the pill, like a tooltip from the button.
      const s = WEL.snippets;
      note.innerHTML = s.file
        ? `Paste it ${s.where ? `inside <b>${s.where}</b> in` : 'into'} <b>${s.file}</b>`
        : 'Bind the copied command to a key in your keyboard settings';
      // Hang it from the button that caused it (kept inside the screen).
      const r = b.getBoundingClientRect(), nw = note.offsetWidth;
      note.style.left = `${clamp(r.left + r.width / 2 - nw / 2, 8, innerWidth - nw - 8)}px`;
      note.style.top = `${r.bottom + 14}px`;
      show(note);
      syncInput();
    }
  });

  native.on('welcome', (m) => showWelcome(m.info));
  return {
    hide: hideWelcome,
    /** The parts on screen (they take clicks). */
    surfaces: () => [pill, note].filter(isShown),
  };
}
