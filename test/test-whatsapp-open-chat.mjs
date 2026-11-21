// Offline test for whatsapp-open-chat.user.js: name matching and which box counts as the chat-list search.
// Run: node test/test-whatsapp-open-chat.mjs · exit 0 = all passed
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clean, firstExact, pickSearchBox } = require('../whatsapp-open-chat.user.js');

const LRM = '‎';
const W = 1440;
const box = (o) => ({ label: 'Search input textbox', left: 80, top: 110, inMain: false, inFooter: false, ...o });

const cases = [
  // [what, got, want]
  ['bidi marks and spaces stripped', clean(`${LRM}General  [PHP3 MC]${LRM} `), 'General [PHP3 MC]'],
  ['decomposed accent composed', clean('Café'), 'Café'],
  ['exact title found', firstExact(['Tech [PHP3 MC]', 'General [PHP3 MC]'], 'General [PHP3 MC]'), 1],
  ['a longer name is not a match', firstExact(['General [PHP3 MC] archive'], 'General [PHP3 MC]'), -1],
  ['a shorter name is not a match', firstExact(['General'], 'General [PHP3 MC]'), -1],
  ['case matters', firstExact(['general [php3 mc]'], 'General [PHP3 MC]'), -1],
  ['first in DOM order wins (Chats come before Messages)', firstExact(['x', 'Su', 'Su'], 'Su'), 1],
  ['title with bidi marks matches', firstExact([`${LRM}Su${LRM}`], 'Su'), 0],
  ['the chat-list search box is picked', pickSearchBox([box()], W), 0],
  ['the message box is never picked', pickSearchBox([box({ label: 'Type a message', left: 700, top: 900, inMain: true, inFooter: true })], W), -1],
  ['a search box inside the open chat is never picked', pickSearchBox([box({ inMain: true, left: 700, top: 60 })], W), -1],
  ['a box on the right half is never picked', pickSearchBox([box({ left: 900 })], W), -1],
  ['a box low on the page is never picked', pickSearchBox([box({ top: 700 })], W), -1],
  ['an unlabelled box is never picked', pickSearchBox([box({ label: '' })], W), -1],
  ['among several, the labelled left one', pickSearchBox([box({ inFooter: true }), box({ label: 'Search or start a new chat' })], W), 1],
];

let pass = 0;
let fail = 0;
for (const [what, got, want] of cases) {
  try {
    assert.deepEqual(got, want);
    pass += 1;
  } catch (e) {
    fail += 1;
    console.log(`✗ ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
