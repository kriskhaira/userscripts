// ==UserScript==
// @name         WhatsApp Web — pick a message and reply from the keyboard
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.0.0
// @description  ⌥↑ / ⌥↓ step a highlight through the open chat's messages, ⌥R replies to the highlighted one (or, with none, to their newest message), Esc clears. Never sends.
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/kriskhaira/userscripts/main/whatsapp-reply-keys.user.js
// @updateURL    https://raw.githubusercontent.com/kriskhaira/userscripts/main/whatsapp-reply-keys.user.js
// ==/UserScript==
//
// Why (Kris, 2026-11-25): "i need a kb shortcut to quickly select a message to reply to in
// WhatsApp chrome app". WhatsApp Web has none: its official shortcut list (15 rows, Help
// Center, checked 25 Nov 2026) has no reply or select-message key.
//
// How: ⌥R opens the message's own hover menu (the chevron) and clicks its "Reply" item, the
// same path as the mouse. It only fills the quote above the message box and puts the cursor
// there: it never types and never sends. Keys are read by e.code, so ⌥R works although macOS
// turns it into "®". Manual path without this script: hover the message → chevron → Reply.
// Installed in Violentmonkey from the raw URL above, in the Chrome profile that runs the
// WhatsApp Web app. Bump @version on every edit.

// ---------- pure parts, tested in Node ----------
// A message's data-id starts "false_" when it came IN, "true_" when Kris sent it.
const isIncoming = (dataId) => /^false_/.test(String(dataId || ''));

// Next highlight index for a step of dir (-1 = older, +1 = newer) over n messages.
// No highlight yet (-1): ⌥↑ starts at the newest, ⌥↓ does nothing. Clamped at both ends.
function stepIndex(cur, n, dir) {
  if (n <= 0) return -1;
  if (cur < 0 || cur >= n) return dir < 0 ? n - 1 : -1;
  return Math.max(0, Math.min(n - 1, cur + dir));
}

// Which message ⌥R replies to: the highlighted one, else the newest INCOMING one,
// else the newest of all. -1 when the chat is empty.
function replyIndex(cur, ids) {
  if (cur >= 0 && cur < ids.length) return cur;
  for (let i = ids.length - 1; i >= 0; i--) if (isIncoming(ids[i])) return i;
  return ids.length - 1;
}

if (typeof document === 'undefined') {
  module.exports = { isIncoming, stepIndex, replyIndex }; // Node, for the tests
} else (() => {
  'use strict';

  const MENU_BTN = '[data-icon="down-context"], [data-icon="ic-chevron-down-menu"], [aria-label="Context menu"], [aria-label="Message options"]';
  const MENU_ITEM = '[role="application"] li, [role="menu"] [role="menuitem"], li[role="button"], div[role="button"]';
  const COMPOSER = '#main footer [contenteditable="true"]';
  const HIGHLIGHT = '2px solid #25d366';
  let sel = null; // the highlighted message element

  // Top-level messages in the open chat, oldest first.
  function messages() {
    return [...document.querySelectorAll('#main [data-id]')]
      .filter((m) => !m.parentElement.closest('[data-id]') && m.getBoundingClientRect().height > 0);
  }

  function highlight(m) {
    if (sel) { sel.style.outline = ''; sel.style.outlineOffset = ''; }
    sel = m;
    if (!m) return;
    m.style.outline = HIGHLIGHT;
    m.style.outlineOffset = '-2px';
    m.scrollIntoView({ block: 'nearest' });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms = 1200) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(40)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  }

  const hover = (el) => {
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window }));
    }
  };

  async function reply(m) {
    hover(m.querySelector('.message-in, .message-out, [role="row"] > div') || m);
    const icon = await waitFor(() => m.querySelector(MENU_BTN) || m.closest('[role="row"]')?.querySelector(MENU_BTN));
    if (!icon) return console.warn('[wa-reply] no message menu found');
    (icon.closest('[role="button"], button') || icon).click();
    const item = await waitFor(() => [...document.querySelectorAll(MENU_ITEM)]
      .find((li) => /^reply$/i.test((li.getAttribute('aria-label') || li.textContent || '').trim())));
    if (!item) return console.warn('[wa-reply] no Reply item in the menu');
    item.click();
    highlight(null);
    (await waitFor(() => document.querySelector(COMPOSER)))?.focus();
  }

  addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) {
      if (e.key === 'Escape' && sel) highlight(null);
      return;
    }
    if (!document.querySelector('#main')) return;
    const list = messages();
    let cur = sel ? list.indexOf(sel) : -1;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      cur = stepIndex(cur, list.length, e.code === 'ArrowUp' ? -1 : 1);
      highlight(cur >= 0 ? list[cur] : null);
    } else if (e.code === 'KeyR') {
      const i = replyIndex(cur, list.map((m) => m.getAttribute('data-id')));
      if (i >= 0) reply(list[i]);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
})();
