// Offline test for instagram-dm-titles.user.js: the name folding and the title format.
// Run: node test/test-instagram-dm-titles.mjs · exit 0 = all passed
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { plainText, dmTitle } = require('../instagram-dm-titles.user.js');

const ZWSP = '​';
const cases = [
  // [what, got, want]
  ['Mathematical Bold name (Kamini, 2026-11-15)', plainText('𝐊𝐚𝐦𝐢𝐧𝐢 𝐒𝐢𝐥𝐯𝐚𝐫𝐚𝐣𝐚𝐧'), 'Kamini Silvarajan'],
  ['her DM title', dmTitle('𝐊𝐚𝐦𝐢𝐧𝐢 𝐒𝐢𝐥𝐯𝐚𝐫𝐚𝐣𝐚𝐧', 'notdaintyatalll'), 'Kamini Silvarajan (@notdaintyatalll) • DM'],
  ['plain name unchanged', plainText('Liani MK'), 'Liani MK'],
  ['plain DM title unchanged', dmTitle('Liani MK', 'lianimk.art'), 'Liani MK (@lianimk.art) • DM'],
  ['italic', plainText('𝐾𝑎𝑚𝑖𝑛𝑖'), 'Kamini'],
  ['bold italic', plainText('𝑲𝒂𝒎𝒊𝒏𝒊'), 'Kamini'],
  ['script', plainText('𝒦𝒶𝓂𝒾𝓃𝒾'), 'Kamini'],
  ['bold script', plainText('𝓚𝓪𝓶𝓲𝓷𝓲'), 'Kamini'],
  ['fraktur', plainText('𝔎𝔞𝔪𝔦𝔫𝔦'), 'Kamini'],
  ['double-struck', plainText('𝕂𝕒𝕞𝕚𝕟𝕚'), 'Kamini'],
  ['sans bold', plainText('𝗞𝗮𝗺𝗶𝗻𝗶'), 'Kamini'],
  ['monospace', plainText('𝙺𝚊𝚖𝚒𝚗𝚒'), 'Kamini'],
  ['fullwidth', plainText('Ｋａｍｉｎｉ'), 'Kamini'],
  ['superscript', plainText('ᴷᵃᵐⁱⁿⁱ'), 'Kamini'],
  ['small caps', plainText('ᴋᴀᴍɪɴɪ ꜱɪʟᴠᴀʀᴀᴊᴀɴ'), 'kamini silvarajan'],
  ['capital + small caps', plainText('Kᴀᴍɪɴɪ'), 'Kamini'],
  ['circled', plainText('ⓀⒶⓂⒾⓃⒾ ⓚⓐⓜⓘⓝⓘ'), 'KAMINI kamini'],
  ['squared', plainText('🄺🄰🄼🄸🄽🄸'), 'KAMINI'],
  ['negative circled', plainText('🅚🅐🅜🅘🅝🅘'), 'KAMINI'],
  ['negative squared (🅰 is an emoji too)', plainText('🅺🅰🅼🅸🅽🅸'), 'KAMINI'],
  ['parenthesised', plainText('⒦⒜⒨⒤⒩⒤'), 'kamini'],
  ['regional-indicator letters split by zero-width spaces', plainText(['🇰', '🇦', '🇲', '🇮', '🇳', '🇮'].join(ZWSP)), 'KAMINI'],
  ['flags are decoration', plainText('Kamini 🇲🇾🇮🇳'), 'Kamini'],
  ['strikethrough', plainText('K̶a̶m̶i̶n̶i̶'), 'Kamini'],
  ['underline', plainText('K̲a̲m̲i̲n̲i̲'), 'Kamini'],
  ['zero-width characters inside', plainText(`Ka${ZWSP}mi‍ni­`), 'Kamini'],
  ['bidi marks', plainText('‪Kamini‬‏'), 'Kamini'],
  ['emoji around', plainText('✨ Kamini ✨'), 'Kamini'],
  ['emoji after, ZWJ sequence and skin tone', plainText('Kamini 🌸🦋 👩🏽‍💻'), 'Kamini'],
  ['symbol decoration', plainText('✿ Kamini ♡ ☆'), 'Kamini'],
  ['whitespace collapsed', plainText('  Kamini   Silvarajan　 '), 'Kamini Silvarajan'],
  ['accents kept', plainText('José Zoë Ñúñez'), 'José Zoë Ñúñez'],
  ['decomposed accent composed', plainText('José'), 'José'],
  ['Tamil kept', plainText('காமினி சில்வராஜன்'), 'காமினி சில்வராஜன்'],
  ['Devanagari joiner between letters kept', plainText('क्‍ष'), 'क्‍ष'],
  ['Chinese kept', plainText('王小明'), '王小明'],
  ['Hangul-filler "blank" name falls back to the handle', dmTitle('ㅤ', 'someone'), 'someone • DM'],
  ['emoji-only name falls back to the handle', dmTitle('🌸🌸', 'someone'), 'someone • DM'],
  ['Braille-blank name falls back to the handle', dmTitle('⠀⠀', 'someone'), 'someone • DM'],
  ['group chat, no handle', dmTitle('Family 🏠 ', undefined), 'Family • DM'],
  ['emoji-only group name kept as written', dmTitle('🏠🏠', ''), '🏠🏠 • DM'],
  ['name equal to handle', dmTitle('lianimk.art', 'lianimk.art'), 'lianimk.art • DM'],
  ['nothing at all', dmTitle('', ''), ''],
];

let pass = 0;
let fail = 0;
for (const [what, got, want] of cases) {
  try {
    assert.equal(got, want);
    pass++;
  } catch {
    fail++;
    console.log(`  ✗ ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
console.log(`instagram-dm-titles: ${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
