// Offline test for whatsapp-reply-keys.user.js: stepping the highlight and picking the reply target.
// Run: node test/test-whatsapp-reply-keys.mjs · exit 0 = all passed
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isIncoming, stepIndex, replyIndex } = require('../whatsapp-reply-keys.user.js');

const ids = ['false_601@c.us_A', 'true_601@c.us_B', 'false_601@c.us_C', 'true_601@c.us_D'];
const cases = [
  ['incoming id', isIncoming('false_601@c.us_A'), true],
  ['own id', isIncoming('true_601@c.us_B'), false],
  ['no id', isIncoming(undefined), false],
  ['⌥↑ with no highlight starts at the newest', stepIndex(-1, 4, -1), 3],
  ['⌥↓ with no highlight does nothing', stepIndex(-1, 4, 1), -1],
  ['⌥↑ steps older', stepIndex(3, 4, -1), 2],
  ['⌥↑ stops at the oldest', stepIndex(0, 4, -1), 0],
  ['⌥↓ stops at the newest', stepIndex(3, 4, 1), 3],
  ['empty chat', stepIndex(-1, 0, -1), -1],
  ['⌥R replies to the highlighted one', replyIndex(1, ids), 1],
  ['⌥R with none: their newest message, skipping mine', replyIndex(-1, ids), 2],
  ['⌥R with only my messages: the newest', replyIndex(-1, ['true_x', 'true_y']), 1],
  ['⌥R in an empty chat', replyIndex(-1, []), -1],
];

let failed = 0;
for (const [what, got, want] of cases) {
  try { assert.equal(got, want); console.log(`  ✓ ${what}`); }
  catch { failed++; console.log(`  ✗ ${what}: got ${got}, want ${want}`); }
}
console.log(`whatsapp-reply-keys: ${cases.length - failed}/${cases.length} pass`);
process.exit(failed ? 1 : 0);
