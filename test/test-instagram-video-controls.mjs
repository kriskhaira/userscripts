// Offline test for instagram-video-controls.user.js: where the bar's foot sits (barFloor).
// Run: node test/test-instagram-video-controls.mjs · exit 0 = all passed
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { barFloor } = require('../instagram-video-controls.user.js');

const rect = (top, bottom, left, right) => ({ top, bottom, left, right });
// A Story frame like Kris's 25 Nov screenshot: the video fills 66–930 × 24–1560 and
// Instagram's reply box, heart and send icons sit in its last ~100 px.
const story = rect(24, 1560, 66, 930);
const reply = rect(1440, 1530, 98, 724);
const heart = rect(1460, 1510, 750, 810);
const send = rect(1460, 1510, 830, 890);
const muteTop = rect(100, 150, 700, 750);       // the mute / pause / … row at the top
const overlay = rect(24, 1560, 66, 930);        // a full-frame tap target, not a control
const nextArrow = rect(770, 820, 960, 990);     // the "next story" arrow, outside the frame

const cases = [
  ['no controls: the video foot', barFloor(story, [], 2000), 1560],
  ['video taller than the viewport: the viewport foot', barFloor(story, [], 1200), 1200],
  ['Story: above the reply box (25 Nov bug)', barFloor(story, [reply, heart, send], 2000), 1440 - 6],
  ['icons alone still lift it', barFloor(story, [heart, send], 2000), 1460 - 6],
  ['top-row buttons ignored', barFloor(story, [muteTop], 2000), 1560],
  ['full-frame overlay ignored', barFloor(story, [overlay], 2000), 1560],
  ['control beside the video ignored', barFloor(story, [nextArrow, rect(1500, 1540, 940, 990)], 2000), 1560],
  ['control below the video ignored', barFloor(story, [rect(1570, 1600, 100, 300)], 2000), 1560],
  ['zero-size element ignored', barFloor(story, [rect(1500, 1500, 100, 300)], 2000), 1560],
];

let failed = 0;
for (const [what, got, want] of cases) {
  try { assert.equal(got, want); console.log(`  ✓ ${what}`); }
  catch { failed++; console.log(`  ✗ ${what}: got ${got}, want ${want}`); }
}
console.log(`instagram-video-controls: ${cases.length - failed}/${cases.length} pass`);
process.exit(failed ? 1 : 0);
