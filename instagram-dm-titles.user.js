// ==UserScript==
// @name         Instagram — DM tab titles
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.1.0
// @description  Name an Instagram DM tab after the chat: "Name (@handle) • DM" instead of "Instagram • Messages", in plain letters so history search finds it.
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
// Why plain letters (Kris, 2026-11-15): some people write their display name in
// look-alike Unicode — 𝐊𝐚𝐦𝐢𝐧𝐢 (Mathematical Bold), ᴋᴀᴍɪɴɪ (small caps), Ｋａｍｉｎｉ
// (fullwidth), ⓚⓐⓜⓘⓝⓘ (circled). It reads as "Kamini" but is other characters, so
// typing "kamini" into Chrome's history finds nothing. plainText() folds the name
// to ordinary letters and drops emoji, invisible characters and strike/underline
// marks before the name goes into the title. Accented and non-Latin names
// (José, காமினி) are kept as they are.
//
// How: on /direct/t/<id>/ it reads the chat header, the H2 inside the main pane
// that is not in the "Thread list" sidebar. The handle comes from the header's
// "Open the profile page of <handle>" link; group chats have no link, so they
// get the name only. It reads no message text and makes no network calls.
// Markup checked 2026-11-02. Bump @version on every edit.
// Test: node test/test-instagram-dm-titles.mjs (sh test.sh runs it too).

const SUFFIX = ' • DM';

// Small capitals: NFKC leaves these alone. Mapped to lower case, so "Kᴀᴍɪɴɪ" → "Kamini".
const SMALL_CAPS = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i',
  'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ꞯ': 'q', 'ǫ': 'q',
  'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

// Enclosed letters NFKC leaves alone: negative circled 🅚 and negative squared 🅺 (A–Z),
// parenthesised ⒦ (NFKC would make it "(k)").
function enclosedLetter(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x1F150 && c <= 0x1F169) return String.fromCharCode(65 + c - 0x1F150);
  if (c >= 0x1F170 && c <= 0x1F189) return String.fromCharCode(65 + c - 0x1F170);
  if (c >= 0x249C && c <= 0x24B5) return String.fromCharCode(97 + c - 0x249C);
  return ch;
}

const RI = '[\\u{1F1E6}-\\u{1F1FF}]';

function plainText(s) {
  if (!s) return '';
  let t = String(s);
  // Two regional indicators side by side are a flag (🇲🇾): decoration. A lone one,
  // usually spaced out with zero-width characters, is a letter: 🇰​🇦​🇲 → KAM.
  t = t.replace(new RegExp(`${RI}${RI}`, 'gu'), '');
  t = t.replace(new RegExp(RI, 'gu'), ch => String.fromCharCode(65 + ch.codePointAt(0) - 0x1F1E6));
  t = t.replace(/[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}⒜-⒵]/gu, enclosedLetter);
  // NFKC: Mathematical Alphanumerics (bold, italic, script, fraktur, sans, mono,
  // double-struck), fullwidth, circled Ⓚ, squared 🄺, superscript ᴷ → plain letters.
  t = t.normalize('NFKC');
  t = t.replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯǫʀꜱᴛᴜᴠᴡʏᴢ]/gu, ch => SMALL_CAPS[ch]);
  // Combining marks still loose after NFKC sit on letters that have no accented form:
  // strikethrough K̶, underline K̲, stacked "zalgo" marks, enclosing circles and keycaps.
  t = t.replace(/[̀-ͯ҉᪰-᫿᷀-᷿⃐-⃿︠-︯]/gu, '');
  // Emoji, skin tones and other pictographic symbols (✨ ✿ ♡ ☆).
  t = t.replace(/[\p{Extended_Pictographic}\p{So}\u{1F3FB}-\u{1F3FF}]/gu, '');
  // Invisible characters: zero-width space, soft hyphen, bidi controls, variation
  // selectors, Hangul filler and Braille blank (both used for "blank" names). The
  // zero-width (non-)joiner stays only between two non-Latin letters, where scripts
  // such as Devanagari and Persian need it.
  t = t.replace(/(?<![\p{L}\p{M}])[‌‍]|[‌‍](?![\p{L}\p{M}])|(?<=\p{Script=Latin})[‌‍]|[‌‍](?=\p{Script=Latin})/gu, '');
  t = t.replace(/(?![‌‍])\p{Default_Ignorable_Code_Point}|⠀/gu, '');
  return t.replace(/\s+/gu, ' ').trim();
}

// "<Name> (@handle) • DM"; a group chat (no handle) or a name equal to the handle
// gets "<Name> • DM"; a name that folds to nothing falls back to the handle.
function dmTitle(rawName, rawHandle) {
  const handle = plainText(rawHandle).replace(/^@/, '');
  const name = plainText(rawName) || handle || String(rawName || '').trim();
  if (!name) return '';
  return handle && handle !== name ? `${name} (@${handle})${SUFFIX}` : `${name}${SUFFIX}`;
}

if (typeof document === 'undefined') {
  module.exports = { plainText, dmTitle }; // Node, for the tests
} else {
  (() => {
    function chatTitle() {
      if (!/^\/direct\/t\/[^/]+/.test(location.pathname)) return '';
      const h2 = [...document.querySelectorAll('[role="main"] h2')]
        .find(h => !h.closest('[aria-label="Thread list"]'));
      if (!h2) return '';
      const link = h2.closest('a[aria-label^="Open the profile page of "]');
      const handle = link?.getAttribute('aria-label').replace('Open the profile page of ', '');
      return dmTitle(h2.textContent, handle);
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
}
