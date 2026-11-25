// Offline test for whatsapp-reply-keys.user.js: stepping the highlight, picking the reply target,
// and the guards from agy's 25 Nov 2026 review (menu scoping, pointer events, key guards).
// Run: node test/test-whatsapp-reply-keys.mjs · exit 0 = all passed
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isIncoming, stepIndex, replyIndex, MENU_ITEM, MENU_SCOPES, isReplyItem, HOVER_EVENTS, BUBBLE,
  arrowsFree, replyKeyOk, ownsKey,
} = require('../whatsapp-reply-keys.user.js');
const src = readFileSync(new URL('../whatsapp-reply-keys.user.js', import.meta.url), 'utf8');
const header = src.slice(0, src.indexOf('==/UserScript=='));

const ids = ['false_601@c.us_A', 'true_601@c.us_B', 'false_601@c.us_C', 'true_601@c.us_D'];
const parts = MENU_ITEM.split(',').map((p) => p.trim());
const composer = (text) => ({ tag: 'DIV', editable: true, inComposer: true, text });
const cases = [
  ['incoming id', isIncoming('false_601@c.us_A'), true],
  ['own id', isIncoming('true_601@c.us_B'), false],
  ['no id', isIncoming(undefined), false],
  ['⌥↑ with no highlight starts at the newest', stepIndex(-1, 4, -1), 3],
  // Kris, 26 Nov 2026: "geting ®®®®® with the reply shortcut" — ⌥R is always the script's, never "®"
  ['⌥R is the script\'s key', ownsKey('KeyR', true, false, false), true],
  ['plain R types an r', ownsKey('KeyR', false, false, false), false],
  ['⌘⌥R is left to the browser', ownsKey('KeyR', true, true, false), false],
  ['⌃⌥R is left alone', ownsKey('KeyR', true, false, true), false],
  ['⌥T is not ours', ownsKey('KeyT', true, false, false), false],
  ['⌥↓ with no highlight does nothing', stepIndex(-1, 4, 1), -1],
  ['⌥↑ steps older', stepIndex(3, 4, -1), 2],
  ['⌥↑ stops at the oldest', stepIndex(0, 4, -1), 0],
  ['⌥↓ stops at the newest', stepIndex(3, 4, 1), 3],
  ['empty chat', stepIndex(-1, 0, -1), -1],
  ['⌥R replies to the highlighted one', replyIndex(1, ids), 1],
  ['⌥R with none: their newest message, skipping mine', replyIndex(-1, ids), 2],
  ['⌥R with only my messages: the newest', replyIndex(-1, ['true_x', 'true_y']), 1],
  ['⌥R in an empty chat', replyIndex(-1, []), -1],
  // 🔴 Reply item must come from the open menu, visible, never a page button
  ['every Reply-item selector is scoped to an open menu', parts.every((p) => MENU_SCOPES.some((m) => p.startsWith(`${m} `))), true],
  ['no bare div[role="button"] selector', parts.includes('div[role="button"]'), false],
  ['visible Reply item matches', isReplyItem({ label: ' Reply ', height: 40 }), true],
  ['hidden Reply item (height 0) is skipped', isReplyItem({ label: 'Reply', height: 0 }), false],
  ['a message\'s own Reply button is skipped', isReplyItem({ label: 'Reply', height: 40, inMessage: true }), false],
  ['"Reply privately" is not Reply', isReplyItem({ label: 'Reply privately', height: 40 }), false],
  // 🔴 pointer events are PointerEvents; hover target found inside the message
  ['pointer* events are PointerEvent', HOVER_EVENTS.filter(([t]) => t.startsWith('pointer')).every(([, c]) => c === 'PointerEvent'), true],
  ['mouse* events are MouseEvent', HOVER_EVENTS.filter(([t]) => t.startsWith('mouse')).every(([, c]) => c === 'MouseEvent'), true],
  ['PointerEvent built with pointerType mouse', /pointerType: 'mouse'/.test(src), true],
  ['hover target never uses "[role=row] > div"', /\[role="row"\] > div/.test(BUBBLE + src), false],
  // 🟠 key guards
  ['held ⌥R (repeat) does not reply', replyKeyOk(true, false), false],
  ['⌥R while a reply is in flight does not reply', replyKeyOk(false, true), false],
  ['fresh ⌥R replies', replyKeyOk(false, false), true],
  ['⌥↑ free with focus on the page', arrowsFree(null), true],
  ['⌥↑ left alone in the search box', arrowsFree({ tag: 'INPUT', editable: false }), false],
  ['⌥↑ left alone in a textarea', arrowsFree({ tag: 'TEXTAREA', editable: false }), false],
  ['⌥↑ left alone in the search contenteditable', arrowsFree({ tag: 'DIV', editable: true, inComposer: false, text: '' }), false],
  ['⌥↑ left alone in a composer holding a draft', arrowsFree(composer('line one\nline two')), false],
  ['⌥↑ free in an empty composer', arrowsFree(composer('  ')), true],
  ['@inject-into content in the header', /^\/\/ @inject-into +content$/m.test(header), true],
];

let failed = 0;
for (const [what, got, want] of cases) {
  try { assert.equal(got, want); console.log(`  ✓ ${what}`); }
  catch { failed++; console.log(`  ✗ ${what}: got ${got}, want ${want}`); }
}
console.log(`whatsapp-reply-keys: ${cases.length - failed}/${cases.length} pass`);
process.exit(failed ? 1 : 0);
