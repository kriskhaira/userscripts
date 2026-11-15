// Builds the two installable files from one source:
//   ../stremio-ratings.user.js   — Violentmonkey, web.stremio.com in Chrome
//   ../stremio-ratings.plugin.js — Stremio Enhanced (the community desktop client)
// Edit src/, bump VERSION here, run `node stremio-ratings/build.mjs`, commit all three.
// `--check` exits 1 if the built files are out of date (the test suite runs it).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.1.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = 'https://raw.githubusercontent.com/kriskhaira/userscripts/main/';
const DESC = 'One number per film or series on Stremio — poster tiles, Discover’s side panel and the title page: a critic-weighted blend of Metacritic, Rotten Tomatoes and IMDb (via a free OMDb key). Click it for the breakdown and links.';

const src = f => readFileSync(join(HERE, 'src', f), 'utf8').trimEnd() + '\n';
const NOTE = `// Built by stremio-ratings/build.mjs from stremio-ratings/src/ — edit those, not this file.\n`;

const USER_HEAD = `// ==UserScript==
// @name         Stremio — ratings on tiles and title pages
// @namespace    https://github.com/kriskhaira/userscripts
// @version      ${VERSION}
// @description  ${DESC}
// @author       Kris Khaira
// @match        https://web.stremio.com/*
// @match        https://web.strem.io/*
// @run-at       document-idle
// @inject-into  content
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @connect      www.omdbapi.com
// @downloadURL  ${RAW}stremio-ratings.user.js
// @updateURL    ${RAW}stremio-ratings.user.js
// ==/UserScript==
`;

// Stremio Enhanced reads the FIRST /** … */ block of the file: name, description, author and
// version are required, one line each.
const PLUGIN_HEAD = `/**
 * @name Stremio Ratings
 * @description ${DESC}
 * @updateUrl ${RAW}stremio-ratings.plugin.js
 * @version ${VERSION}
 * @author Kris Khaira
 * @source https://github.com/kriskhaira/userscripts
 */
`;

export function build() {
  const core = src('core.js');
  if (core.includes('/**')) throw new Error('core.js must not contain "/**": Stremio Enhanced takes the first /** block as the plugin header');
  const wrap = shell => `(function () {\n'use strict';\n\n${core}\n${src(shell)}})();\n`;
  const out = {
    'stremio-ratings.user.js': USER_HEAD + NOTE + '\n' + wrap('userscript.js'),
    'stremio-ratings.plugin.js': PLUGIN_HEAD + NOTE + '\n' + wrap('plugin.js'),
  };
  for (const [name, text] of Object.entries(out)) {
    if (/<\/script|<!--/i.test(text)) throw new Error(`${name}: "</script" or "<!--" would break Stremio Enhanced's inline <script> injection`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, text] of Object.entries(out)) {
    const path = join(ROOT, name);
    let old = ''; try { old = readFileSync(path, 'utf8'); } catch (_) { /* first build */ }
    if (old === text) { console.log(`= ${name} (${VERSION}) up to date`); continue; }
    if (check) { console.log(`✗ ${name} is out of date — run node stremio-ratings/build.mjs`); stale++; continue; }
    writeFileSync(path, text);
    console.log(`→ ${name} (${VERSION}) written, ${text.length} bytes`);
  }
  process.exit(stale ? 1 : 0);
}
