// ==UserScript==
// @name         WhatsApp Web — open the chat a draft link names
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.0.0
// @description  A 💬 open chat link under a vault draft (http://localhost:7337/wa/<chat name>) brings this app forward; this script then opens that chat by its EXACT name. It never types into a message box and never sends.
// @match        https://web.whatsapp.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @downloadURL  http://localhost:7337/userscript/whatsapp-open-chat.user.js
// @updateURL    http://localhost:7337/userscript/whatsapp-open-chat.user.js
// ==/UserScript==
//
// Why (Kris, 2026-11-21): "for all draft replies, always show link to the actual WhatsApp chat so i can do
// one-click copy, one-click URL to open the right WhatsApp group, then paste". A group has no URL of its own
// (wa.me and web.whatsapp.com/send work for a phone number only), so the click goes to the local link server
// (~/bin/obsidian-link, chezmoi), which leaves the chat name at /wa-pending and raises this app. When this
// window gains focus, the script asks for that name once and opens the chat:
//   1. the chat is already open → just put the cursor in its message box;
//   2. else a row in the chat list whose title is EXACTLY the name → click it;
//   3. else type the name into the CHAT-LIST search box (left side, labelled "search", never inside #main
//      or a footer) and click the first result whose title is exactly the name.
// Then it checks the open chat's header shows that name, clears the search and focuses the message box, so
// ⌘V pastes the draft. Kris presses Return himself.
//
// ⛔ It never types into, or presses a key in, the message box: in WhatsApp, Return there SENDS. The only text
// it writes is the chat name, into a box it has positively identified as the chat-list search. No exact
// match → a toast says so and the search is left showing for Kris to pick.
// Network: one GM_xmlhttpRequest to http://127.0.0.1:7337/wa-pending per focus; nothing leaves the Mac.
// Installed in Violentmonkey (Chrome Default profile, which runs the WhatsApp Web app) from
// http://localhost:7337/userscript/whatsapp-open-chat.user.js. Bump @version on every edit.
// Procedure: ~/ObsidianSync/Notes/Tools/draft-links/PROCEDURE.md
// Manual path without this script: the link still raises WhatsApp Web; search the chat's name yourself.

(function () {
  'use strict';

  const TAG = '[wa-open-chat]';
  const PENDING = 'http://127.0.0.1:7337/wa-pending';
  const LIST = '#pane-side, [aria-label="Chat list"], [aria-label^="Search results"]';
  const ROW = '[role="listitem"], [role="row"], [role="gridcell"]';
  const COMPOSER = '#main footer [contenteditable="true"][role="textbox"], #main footer [contenteditable="true"]';
  const WAIT_MS = 4000;
  const STEP_MS = 100;

  // WhatsApp wraps text in bidi marks (U+200E …): strip them, unify the Unicode form, collapse spaces.
  function clean(s) {
    return (s || '').normalize('NFC').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  // The first title (DOM order: Chats come before Contacts and Messages in search results) that is EXACTLY
  // the name. Ambiguity between two chats of the same name is caught earlier, by the link helper, which
  // refuses a name two chats share.
  function firstExact(titles, name) {
    const want = clean(name);
    return titles.findIndex((t) => clean(t) === want);
  }

  // Which of the candidate boxes is the chat-list search: on the LEFT, near the TOP, labelled search;
  // never in the open chat (#main) or a footer (the message box). Each candidate is
  // { label, left, top, inMain, inFooter }; returns its index or -1.
  function pickSearchBox(cands, width) {
    const ok = cands.map((c, i) => [c, i]).filter(([c]) => !c.inMain && !c.inFooter && c.left < width * 0.5 && c.top < 260);
    const labelled = ok.filter(([c]) => /search/i.test(c.label || ''));
    return labelled.length ? labelled[0][1] : -1;
  }

  if (typeof module !== 'undefined') { // Node, for the tests
    module.exports = { clean, firstExact, pickSearchBox };
    return;
  }

  const log = (...a) => console.log(TAG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;'
      + 'background:#222;color:#fff;padding:8px 14px;border-radius:8px;font:13px -apple-system,sans-serif;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:70vw';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  function labelOf(el) {
    return ['aria-label', 'placeholder', 'title', 'data-placeholder', 'aria-placeholder']
      .map((a) => el.getAttribute(a) || '').join(' ');
  }

  function searchBox() {
    const els = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]), [contenteditable="true"]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
    const i = pickSearchBox(els.map((el) => {
      const r = el.getBoundingClientRect();
      return { label: labelOf(el), left: r.left, top: r.top, inMain: !!el.closest('#main'), inFooter: !!el.closest('footer') };
    }), innerWidth);
    return i >= 0 ? els[i] : null;
  }

  function openTitle() {
    const header = document.querySelector('#main header');
    if (!header) return '';
    const t = header.querySelector('span[title]');
    return clean(t ? t.getAttribute('title') : header.textContent);
  }

  function listRows() {
    const rows = [];
    for (const list of document.querySelectorAll(LIST)) {
      for (const span of list.querySelectorAll('span[title]')) {
        const row = span.closest(ROW);
        if (row && !row.closest('#main')) rows.push([span.getAttribute('title'), span]);
      }
    }
    return rows;
  }

  // Click the chat's NAME, as a person would: the event bubbles to the row. Never a button inside the row,
  // which may be its avatar (opens the photo) or its ⌄ menu (Archive, Delete chat).
  function clickRow(target) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  async function until(fn) {
    const end = Date.now() + WAIT_MS;
    for (;;) {
      const v = fn();
      if (v || Date.now() > end) return v;
      await sleep(STEP_MS);
    }
  }

  function setSearch(box, text) {
    box.focus();
    if (box.tagName === 'INPUT') {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      if (text) document.execCommand('insertText', false, text);
      else document.execCommand('delete', false, null);
    }
    return clean(box.tagName === 'INPUT' ? box.value : box.textContent) === clean(text);
  }

  function focusComposer() {
    const c = document.querySelector(COMPOSER);
    if (c) c.focus();
  }

  async function openChat(name) {
    const want = clean(name);
    log('opening', want);
    if (openTitle() === want) { focusComposer(); log('already open'); return; }

    let hit = listRows();
    let i = firstExact(hit.map(([t]) => t), want);
    let box = null;
    if (i < 0) {
      box = await until(searchBox);
      if (!box) { toast(`💬 Couldn't find WhatsApp's chat search. Search for "${want}" yourself.`); return; }
      if (!setSearch(box, want)) { toast(`💬 Couldn't type into the chat search. Search for "${want}" yourself.`); return; }
      i = await until(() => {
        hit = listRows();
        const k = firstExact(hit.map(([t]) => t), want);
        return k >= 0 ? k + 1 : 0;
      }) - 1;
      if (i < 0) { toast(`💬 No chat named exactly "${want}". Pick it from the search.`); return; }
    }
    clickRow(hit[i][1]);
    const opened = await until(() => openTitle() === want);
    if (!opened) { toast(`💬 Clicked "${want}" but the open chat shows "${openTitle()}". Check before pasting.`); return; }
    if (box) { const b = searchBox(); if (b) setSearch(b, ''); }
    focusComposer();
    log('opened', want);
  }

  let busy = false;
  function poll() {
    if (busy || !document.hasFocus()) return;
    busy = true;
    GM_xmlhttpRequest({
      method: 'GET',
      url: PENDING,
      timeout: 2000,
      onload: (r) => {
        let name = null;
        try { name = JSON.parse(r.responseText).name; } catch (e) { /* server down or old: nothing to do */ }
        (name ? openChat(name) : Promise.resolve()).catch((e) => log('failed', e)).finally(() => { busy = false; });
      },
      onerror: () => { busy = false; },
      ontimeout: () => { busy = false; },
    });
  }

  // The server raises this window AFTER it has left the name, so the focus event always finds it. Two retries
  // cover a page that is still loading when the window comes forward.
  window.addEventListener('focus', () => { poll(); setTimeout(poll, 700); setTimeout(poll, 1500); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setTimeout(poll, 1500);
})();
