// ==UserScript==
// @name         WhatsApp Web — pick a message and reply from the keyboard
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.1.1
// @description  ⌥↑ / ⌥↓ step a highlight through the open chat's messages, ⌥R replies to the highlighted one (or, with none, to their newest message), Esc clears. Never sends.
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @inject-into  content
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

// The Reply item lives in the menu that just opened, never anywhere else on the page: a
// business message's own "Reply" button, a hover icon or a hidden leftover must not match
// (agy review, 25 Nov 2026). Every selector is scoped to an open menu container.
const MENU_SCOPES = ['[role="application"]', '[role="menu"]'];
const MENU_ITEM = MENU_SCOPES.map((m) => `${m} li, ${m} [role="menuitem"], ${m} [role="button"]`).join(', ');
// item = {label, height, inMessage}: label is aria-label or text, height from
// getBoundingClientRect(), inMessage = it sits inside a message ([data-id]), like a business
// message's own quick-reply button, so it is never the menu's item.
const isReplyItem = (item) => !!item && item.height > 0 && !item.inMessage
  && /^reply$/i.test(String(item.label || '').trim());

// React listens for pointer events as PointerEvent; a MouseEvent named "pointerover" can be
// ignored. [type, constructor name, extra init] in dispatch order.
const HOVER_EVENTS = [
  ['pointerover', 'PointerEvent'], ['pointerenter', 'PointerEvent'],
  ['mouseover', 'MouseEvent'], ['mouseenter', 'MouseEvent'],
  ['pointermove', 'PointerEvent'], ['mousemove', 'MouseEvent'],
];
// The bubble to hover, searched INSIDE the message element (its row is an ancestor, so a
// "[role=row] > div" selector can never match from here).
const BUBBLE = '.message-in, .message-out';

// May ⌥↑ / ⌥↓ move the highlight while focus is on this target? Not inside a text field or
// search box (macOS uses ⌥↑/⌥↓ to jump paragraphs there), nor in the message box once it
// holds a draft. An empty message box is fine: that is where a reply leaves the cursor.
// t = {tag, editable, inComposer, text}
function arrowsFree(t) {
  if (!t) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tag || '').toUpperCase())) return false;
  if (!t.editable) return true;
  return !!t.inComposer && !String(t.text || '').trim();
}

// ⌥R starts a reply only on a fresh press with none in flight: a held key repeats, and a
// second click on the chevron would close the menu the first one opened.
const replyKeyOk = (repeat, busy) => !repeat && !busy;

// ⌥R is this script's key on WhatsApp Web, so it never falls through to macOS, which types "®"
// (Kris, 26 Nov 2026: "geting ®®®®® with the reply shortcut"). True for ⌥R and ⌥⇧R alone.
const ownsKey = (code, alt, meta, ctrl) => code === 'KeyR' && !!alt && !meta && !ctrl;

if (typeof document === 'undefined') {
  module.exports = { isIncoming, stepIndex, replyIndex, MENU_ITEM, MENU_SCOPES, isReplyItem, HOVER_EVENTS, BUBBLE, arrowsFree, replyKeyOk, ownsKey }; // Node, for the tests
} else (() => {
  'use strict';

  const MENU_BTN = '[data-icon="down-context"], [data-icon="ic-chevron-down-menu"], [aria-label="Context menu"], [aria-label="Message options"]';
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
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 20) };
    for (const [t, ctor] of HOVER_EVENTS) {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, ...at };
      el.dispatchEvent(ctor === 'PointerEvent' && typeof PointerEvent === 'function'
        ? new PointerEvent(t, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(t, init));
    }
  };

  let busy = false; // a reply() is in flight
  async function reply(m) {
    busy = true;
    try {
      hover(m.querySelector(BUBBLE) || m);
      const icon = await waitFor(() => m.querySelector(MENU_BTN) || m.closest('[role="row"]')?.querySelector(MENU_BTN));
      if (!icon) return console.warn('[wa-reply] no message menu found');
      (icon.closest('[role="button"], button') || icon).click();
      const item = await waitFor(() => [...document.querySelectorAll(MENU_ITEM)].find((li) => isReplyItem({
        label: li.getAttribute('aria-label') || li.textContent,
        height: li.getBoundingClientRect().height,
        inMessage: !!li.closest('[data-id]'),
      })));
      if (!item) return console.warn('[wa-reply] no Reply item in the menu');
      item.click();
      highlight(null);
      (await waitFor(() => document.querySelector(COMPOSER)))?.focus();
    } finally { busy = false; }
  }

  const focusInfo = (t) => {
    if (!t || t === document.body) return null;
    const composer = t.closest?.(COMPOSER) || (t.matches?.(COMPOSER) ? t : null);
    return { tag: t.tagName, editable: !!t.isContentEditable, inComposer: !!composer, text: composer ? composer.textContent : t.textContent };
  };

  // A short note in the corner when a key can't act, instead of nothing happening.
  let tip = null;
  function toast(text) {
    if (!tip) {
      tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;right:16px;bottom:88px;z-index:99999;padding:8px 12px;border-radius:8px;' +
        'background:#25d366;color:#111;font:500 13px system-ui;box-shadow:0 2px 8px #0006;pointer-events:none';
      document.body.appendChild(tip);
    }
    tip.textContent = 'Reply keys: ' + text;
    tip.style.display = 'block';
    clearTimeout(tip.t);
    tip.t = setTimeout(() => { tip.style.display = 'none'; }, 2500);
  }

  addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) {
      if (e.key === 'Escape' && sel) highlight(null);
      return;
    }
    // ⌥R never types "®", whatever happens next
    if (ownsKey(e.code, e.altKey, e.metaKey, e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); }
    if (!document.querySelector('#main')) {
      if (e.code === 'KeyR') toast('open a chat first');
      return;
    }
    const list = messages();
    let cur = sel ? list.indexOf(sel) : -1;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      if (!arrowsFree(focusInfo(e.target))) return; // leave ⌥↑/⌥↓ to the text field
      cur = stepIndex(cur, list.length, e.code === 'ArrowUp' ? -1 : 1);
      highlight(cur >= 0 ? list[cur] : null);
    } else if (e.code === 'KeyR') {
      if (!replyKeyOk(e.repeat, busy)) { e.preventDefault(); e.stopPropagation(); return; }
      const i = replyIndex(cur, list.map((m) => m.getAttribute('data-id')));
      if (i >= 0) reply(list[i]);
      else toast(list.length ? 'no message of theirs to reply to — pick one with ⌥↑' : 'no messages found in this chat');
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
})();
