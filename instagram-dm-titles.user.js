// ==UserScript==
// @name         Instagram — DM tab titles
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.0.0
// @description  Name an Instagram DM tab after the chat: "Name (@handle) • DM" instead of "Instagram • Messages".
// @match        https://www.instagram.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/kriskhaira/userscripts/main/instagram-dm-titles.user.js
// @updateURL    https://raw.githubusercontent.com/kriskhaira/userscripts/main/instagram-dm-titles.user.js
// ==/UserScript==
//
// Why (Kris, 2026-11-02): every Instagram DM tab is titled "Instagram • Messages",
// so open chats can't be told apart in the tab bar or history. Profile tabs are
// fixed by xaliber's "Instagram Better Tab Titles", which skips /direct/ pages
// because they carry no og:title. This fills that gap.
//
// How: on /direct/t/<id>/ it reads the chat header, the H2 inside the main pane
// that is not in the "Thread list" sidebar. The handle comes from the header's
// "Open the profile page of <handle>" link; group chats have no link, so they
// get the name only. It reads no message text and makes no network calls.
// Markup checked 2026-11-02. Bump @version on every edit.

(() => {
  const SUFFIX = ' • DM';

  function chatTitle() {
    if (!/^\/direct\/t\/[^/]+/.test(location.pathname)) return '';
    const h2 = [...document.querySelectorAll('[role="main"] h2')]
      .find(h => !h.closest('[aria-label="Thread list"]'));
    const name = h2?.textContent.trim();
    if (!name) return '';
    const link = h2.closest('a[aria-label^="Open the profile page of "]');
    const handle = link?.getAttribute('aria-label').replace('Open the profile page of ', '').trim();
    return handle && handle !== name ? `${name} (@${handle})${SUFFIX}` : `${name}${SUFFIX}`;
  }

  function apply() {
    const t = chatTitle();
    if (t && document.title !== t) document.title = t;
  }

  // Instagram rewrites the title on its own; re-apply when it does.
  new MutationObserver(apply).observe(document.head, { subtree: true, childList: true, characterData: true });
  setInterval(apply, 1500); // header renders late and changes on chat switch
  apply();
})();
