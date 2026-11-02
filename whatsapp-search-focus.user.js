// ==UserScript==
// @name         WhatsApp Web — focus the search box after Cmd+F
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.0.1
// @description  When "Search messages" opens (⌘⇧F, which Hammerspoon sends for ⌘F), put the cursor in its search box.
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/kriskhaira/userscripts/main/whatsapp-search-focus.user.js
// @updateURL    https://raw.githubusercontent.com/kriskhaira/userscripts/main/whatsapp-search-focus.user.js
// ==/UserScript==
//
// Why (Kris, 2026-11-01): ~/.hammerspoon/whatsapp_web.lua turns ⌘F into
// WhatsApp Web's own ⌘⇧F. That opens the "Search messages" panel but leaves
// the cursor outside its box. Hammerspoon cannot focus it, because reading
// Chrome's accessibility tree is banned (it killed Hammerspoon on 2026-10-18).
// So the page focuses the box itself.
//
// Installed in Violentmonkey from the raw URL above, in the Chrome Default
// profile, which runs the WhatsApp Web app. Bump @version on every edit.
// Manual path without this script: click the search box once.

(function () {
  'use strict';

  const POLL_MS = 50;
  const GIVE_UP_MS = 1500;

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 10 && r.bottom > 0 && r.top < innerHeight;
  }

  function label(el) {
    return [el.getAttribute('aria-label'), el.getAttribute('placeholder'),
      el.getAttribute('title'), el.getAttribute('data-placeholder'),
      el.getAttribute('aria-placeholder')].join(' ');
  }

  // The panel's box sits in the RIGHT half, near the TOP. That position rules
  // out the chat-list search (left) and the message composer (bottom).
  function panelSearchBox() {
    const boxes = [...document.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]), [contenteditable="true"]')]
      .filter(el => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left > innerWidth * 0.4 && r.top < 260;
      });
    // Prefer a box labelled "search"; else the top-most box in that corner,
    // since WhatsApp's editor may draw its placeholder in a separate element.
    return boxes.find(el => /search/i.test(label(el)))
      || boxes.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
      || null;
  }

  let timer = null;

  function focusWhenReady() {
    clearInterval(timer);
    const start = Date.now();
    timer = setInterval(() => {
      const box = panelSearchBox();
      if (box) {
        clearInterval(timer);
        if (document.activeElement !== box) box.focus();
        console.log('[wa-search-focus] focused', box.tagName, label(box).trim());
        return;
      }
      if (Date.now() - start > GIVE_UP_MS) {
        clearInterval(timer);
        console.log('[wa-search-focus] no search box found in the top-right');
      }
    }, POLL_MS);
  }

  // ⌘⇧F is the in-chat search chord; ⌘F is caught too in case Hammerspoon is
  // not running and the page sees it first.
  // Match the LETTER (e.key), not the physical key (e.code): Kris types
  // Colemak, where F sits on the physical E key, so e.code is 'KeyE' (1.0.0 bug).
  document.addEventListener('keydown', e => {
    if ((e.key || '').toLowerCase() === 'f' && e.metaKey && !e.altKey && !e.ctrlKey) {
      console.log('[wa-search-focus] Cmd+F seen, looking for the box');
      focusWhenReady();
    }
  }, true);
})();
