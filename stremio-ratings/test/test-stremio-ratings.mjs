// End-to-end test for both builds on the live web.stremio.com, in a throwaway headless Chrome.
// OMDb is MOCKED through the DevTools Fetch domain, so no real key or quota is used; the mock
// numbers are not real ratings. Run: node stremio-ratings/test/test-stremio-ratings.mjs [--out DIR]
// Exit 0 = every check passed. Screenshots go to --out (default $TMPDIR/stremio-ratings-test).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitFor, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(tmpdir(), 'stremio-ratings-test');
mkdirSync(OUT, { recursive: true });
const KEY = 'zz9test9'; // a fake key: it only has to look like one
const SITE = 'https://web.stremio.com/';

let failed = 0, passed = 0;
const ok = (cond, what, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${what}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${what}${detail ? ' — ' + detail : ''}`); }
};

// ---------- the mock OMDb ----------
// Deterministic numbers per IMDb ID. Series come back IMDb-only, the shape OMDb gives series
// (omdbapi/OMDb-API issues #147, #290). One ID is unknown to OMDb.
const SERIES_IDS = new Set(['tt0903747', 'tt0944947']);
const UNKNOWN_ID = 'tt0077651'; // Halloween (1978): mocked as missing to test a miss
// Picked per run from Discover's first visible tiles (its catalogue changes daily):
// UNKNOWN = OMDb has no entry; UNRATED = OMDb has the title but no ratings, as it answered for six
// 2026 releases on 15 Nov 2026 that IMDb already rated (Resident Evil: IMDb 7.4 from 166k votes).
const UNKNOWN = new Set([UNKNOWN_ID]), UNRATED = new Set();
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function mockFor(id, type) {
  if (UNKNOWN.has(id)) return { Response: 'False', Error: 'Incorrect IMDb ID.' };
  if (UNRATED.has(id)) return { Title: 'New film ' + id, Year: '2026', Type: 'movie', imdbID: id, imdbRating: 'N/A', imdbVotes: 'N/A', Metascore: 'N/A', Ratings: [], Response: 'True' };
  if (id === 'tt0118694') return { Title: 'In the Mood for Love', Year: '2000', Type: 'movie', imdbID: id, imdbRating: '8.0', imdbVotes: '192,000', Metascore: '87', Ratings: [{ Source: 'Internet Movie Database', Value: '8.0/10' }, { Source: 'Rotten Tomatoes', Value: '92%' }, { Source: 'Metacritic', Value: '87/100' }], Response: 'True' };
  const h = hash(id);
  const imdb = (5.2 + (h % 34) / 10).toFixed(1), votes = 500 + (h % 400000);
  if (SERIES_IDS.has(id) || type === 'series') return { Title: 'Series ' + id, Year: '2008–2013', Type: 'series', imdbID: id, imdbRating: imdb, imdbVotes: votes.toLocaleString('en-US'), Metascore: 'N/A', Ratings: [{ Source: 'Internet Movie Database', Value: imdb + '/10' }], Response: 'True' };
  const rt = 20 + (h >>> 7) % 80, mc = 30 + (h >>> 13) % 60;
  return { Title: 'Film ' + id, Year: '2026', Type: 'movie', imdbID: id, imdbRating: imdb, imdbVotes: votes.toLocaleString('en-US'), Metascore: String(mc), Ratings: [{ Source: 'Internet Movie Database', Value: imdb + '/10' }, { Source: 'Rotten Tomatoes', Value: rt + '%' }, { Source: 'Metacritic', Value: mc + '/100' }], Response: 'True' };
}
// The same blend, written again from the spec, to check the script's arithmetic.
function expected(d) {
  if (d.Response !== 'True') return null;
  const n = v => { const x = parseFloat(String(v || '').replace(/[,%]/g, '')); return Number.isFinite(x) ? x : null; };
  const rt = (d.Ratings || []).find(r => r.Source === 'Rotten Tomatoes');
  const parts = [
    [n(d.Metascore), 0.42, 58, 17],
    [rt ? n(rt.Value) : null, 0.23, 62, 28],
    [n(d.imdbRating), 0.35 * (n(d.imdbVotes) / (n(d.imdbVotes) + 1000)), 6.4, 1.0],
  ];
  let wz = 0, w = 0;
  for (const [v, we, m, sd] of parts) if (v != null) { wz += we * (v - m) / sd; w += we; }
  return w ? Math.max(1, Math.min(99, Math.round(60 + 16 * wz / (w + 0.08)))) : null;
}

async function setUp({ mode = 'mock' } = {}) {
  const b = await launch({ width: 1500, height: 900 });
  const calls = [], leaks = [];
  b.mode = mode;
  b.on('Network.requestWillBeSent', p => {
    const u = p.request.url, body = p.request.postData || '';
    if ((u.includes(KEY) || body.includes(KEY)) && !u.startsWith('https://www.omdbapi.com/')) leaks.push(u.split('?')[0]);
  });
  await b.send('Network.enable');
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*omdbapi.com*', requestStage: 'Request' }] });
  b.on('Fetch.requestPaused', async p => {
    const u = new URL(p.request.url);
    calls.push({ i: u.searchParams.get('i'), key: u.searchParams.get('apikey'), host: u.host });
    const body = b.mode === 'limit' ? { Response: 'False', Error: 'Request limit reached!' } : mockFor(u.searchParams.get('i'), null);
    await b.send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: b.mode === 'limit' ? 401 : 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    }).catch(() => {});
  });
  b.calls = calls; b.leaks = leaks;
  return b;
}

const shot = async (b, name) => {
  const s = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
};
const click = async (b, x, y) => {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const esc = async b => {
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
};
const centre = (b, sel) => b.evaluate(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const go = async (b, hash) => { await b.evaluate(`location.hash = ${JSON.stringify(hash)}`); await sleep(400); };

// ---------- how each build gets into the page ----------
// Stremio Enhanced 1.2.0 (src/preload/ui/mod/modController.ts, loadPlugin): the file is pasted into
// this wrapper and appended as an inline <script>. The API here is an in-memory stand-in for SE's
// IPC-backed one, with the same quirks (getSetting rejects before a config exists).
async function injectPlugin(b, { key = KEY, seed = [] } = {}) {
  const content = readFileSync(join(ROOT, 'stremio-ratings.plugin.js'), 'utf8');
  await b.evaluate(`(() => {
    for (const [k, v] of ${JSON.stringify(seed)}) localStorage.setItem('stremio-ratings:' + k, JSON.stringify(v));
    if (!window.StremioEnhancedAPI) {
      const cfg = {}, cbs = {}, reg = {}; let made = false;
      window.__seCfg = cfg; window.__seReg = reg;
      window.StremioEnhancedAPI = {
        info() {}, warn() {}, error() {},
        getSetting: async (p, k) => { if (!made) throw new Error('No config found'); return cfg[k] ?? null; },
        saveSetting: async (p, k, v) => { made = true; cfg[k] = v; cbs[p] && cbs[p]({ ...cfg }); return true; },
        registerSettings: async (p, s) => { made = true; if (reg[p]) throw 'already registered'; reg[p] = s; return true; },
        onSettingsSaved: (p, cb) => { cbs[p] = cb; },
        showAlert: async () => 0, showPrompt: async () => null,
      };
      if (${JSON.stringify(key)}) window.__seCfg.omdb_key = ${JSON.stringify(key)};
    }
  })()`);
  const scoped = `
        (function() {
            const StremioEnhancedAPI = {
                logger: { info: (m) => window.StremioEnhancedAPI.info('stremio-ratings', m), warn: (m) => window.StremioEnhancedAPI.warn('stremio-ratings', m), error: (m) => window.StremioEnhancedAPI.error('stremio-ratings', m) },
                getSetting: (key) => window.StremioEnhancedAPI.getSetting('stremio-ratings', key),
                saveSetting: (key, value) => window.StremioEnhancedAPI.saveSetting('stremio-ratings', key, value),
                registerSettings: (schema) => window.StremioEnhancedAPI.registerSettings('stremio-ratings', schema),
                onSettingsSaved: (callback) => window.StremioEnhancedAPI.onSettingsSaved('stremio-ratings', callback),
                showAlert: window.StremioEnhancedAPI.showAlert,
                showPrompt: (title, message, defaultValue) => window.StremioEnhancedAPI.showPrompt('stremio-ratings', title, message, defaultValue)
            };
            try {
                ${content}
            } catch (err) {
                console.error('[ModController] Plugin crashed: stremio-ratings.plugin.js', err);
            }
        })();
        `;
  await b.evaluate(`(() => { const s = document.createElement('script'); s.innerHTML = ${JSON.stringify(scoped)}; s.id = 'stremio-ratings.plugin.js'; document.body.appendChild(s); })()`);
  await waitFor(b, `!!document.getElementById('sr-pop')`, 5000);
}

// Violentmonkey: the userscript with GM_* backed by a Map and fetch (the Fetch mock answers it).
async function injectUserscript(b, { key = KEY, seed = [] } = {}) {
  const content = readFileSync(join(ROOT, 'stremio-ratings.user.js'), 'utf8');
  await b.evaluate(`(() => {
    const store = new Map(${JSON.stringify([...(key ? [['omdbKey', key]] : []), ...seed])});
    window.__gmStore = store; window.__gmMenu = {};
    const GM_getValue = (k, d) => store.has(k) ? structuredClone(store.get(k)) : d;
    const GM_setValue = (k, v) => store.set(k, structuredClone(v));
    const GM_deleteValue = k => store.delete(k);
    const GM_listValues = () => [...store.keys()];
    const GM_registerMenuCommand = (label, fn) => { window.__gmMenu[label] = fn; };
    const GM_xmlhttpRequest = o => { fetch(o.url).then(async r => o.onload({ status: r.status, responseText: await r.text() }), () => o.onerror()); };
    ${content}
  })()`);
  await waitFor(b, `!!document.getElementById('sr-pop')`, 5000);
}

// Stremio Enhanced 1.2.0's plugin settings box (src/components/plugin-settings-modal/: the modal
// template and _buildInput / _buildToggle), rebuilt from the plugin's registered schema. Stremio's
// own CSS lays each row out (label and description side by side, the label clamped to 2 lines), so
// a long description squeezes the label: Kris's screenshot of 15 Nov 2026 showed "OM / Db… / API".
const SE_MODAL = `((width) => {
  const schema = window.__seReg['stremio-ratings'], values = window.__seCfg;
  const head = s => '<div class="heading-dYMDt" style="flex: 1; padding-right: 20px; min-width: 0;"><div class="label-qI6Vh" style="font-size: 1.1em; white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.4;">' + s.label + '</div>' + (s.description ? '<div style="font-size: 0.85em; color: #a0a0a0; margin-top: 4px; white-space: normal; line-height: 1.4;">' + s.description + '</div>' : '') + '</div>';
  const rows = schema.map(s => s.type === 'toggle'
    ? '<div class="option-vFOAS" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">' + head(s) + '<div class="content-P2T0i" style="flex-shrink: 0;"><div tabindex="0" class="toggle-container-lZfHP button-container-zVLH6 plugin-setting-toggle" data-key="' + s.key + '"><div class="toggle-toOWM"></div></div></div></div>'
    : '<div class="option-vFOAS" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">' + head(s) + '<div class="content-P2T0i" style="flex-shrink: 0; width: 50%; max-width: 300px;"><label class="search-bar-k7MXd search-bar-container-p4tSt" style="width: 100%; padding: 0; margin: 0; display: block;"><input data-key="' + s.key + '" size="1" class="search-input-bAgAh text-input-hnLiz plugin-setting-input" type="text" placeholder="' + s.label + '" value="' + (values[s.key] ?? '') + '" style="width: 100%; box-sizing: border-box; height: 42px; padding: 0 15px;"></label></div></div>').join('');
  document.getElementById('sr-test-se')?.remove();
  const m = document.createElement('div');
  m.id = 'sr-test-se';
  m.innerHTML = '<div class="modal-container" id="stremioratingspluginjs-settings-modal" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 999999; display: flex; justify-content: center; align-items: center; background-color: rgba(0, 0, 0, 0.75);"><div class="modal-dialog-container-DZMKq" style="width: ' + width + '; max-width: 800px; height: auto; max-height: 80vh; display: flex; flex-direction: column; background: rgb(15,13,32); padding: 2rem;"><div class="title-container-v2mmF">stremio-ratings Settings</div><div class="section-container-N6QHW" style="overflow-y: auto; max-height: 50vh; line-height: 1.5; padding-right: 15px;">' + rows + '</div></div></div>';
  document.body.append(m);
  const labels = [...m.querySelectorAll('.heading-dYMDt > .label-qI6Vh')].map(l => ({ text: l.textContent, lines: Math.round(l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).lineHeight)), clipped: l.scrollWidth > l.clientWidth + 1 }));
  const key = m.querySelector('input[data-key="omdb_key"]');
  return { labels, masked: !!key && getComputedStyle(key).webkitTextSecurity === 'disc' };
})`;
async function checkSeSettings(b) {
  for (const width of ['50%', '560px']) {
    const r = await b.evaluate(`${SE_MODAL}(${JSON.stringify(width)})`);
    ok(r.labels.length === 2 && r.labels.every(l => l.lines === 1 && !l.clipped), `SE settings box at ${width === '50%' ? 'half of a 1500-px window' : '560 px'}: each label fits on one line`, r.labels.map(l => `"${l.text}" ${l.lines} line${l.lines === 1 ? '' : 's'}${l.clipped ? ', clipped' : ''}`).join(' · '));
    if (width === '50%') {
      ok(r.masked, 'SE settings box: the OMDb key is masked, so a screenshot does not show it');
      await shot(b, 'plugin-9-se-settings');
    }
  }
  await b.evaluate(`document.getElementById('sr-test-se')?.remove()`);
}

const tilesReady = `document.querySelectorAll('a[href*="#/detail/"] [class*="poster-container"]').length > 5`;
const LOAD = 240000; // Stremio's first load fetches its multi-MB core; a slow CDN day needs minutes
const AUDIT = `(() => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  const tiles = [...document.querySelectorAll('a[href*="#/detail/"]')].filter(a => a.querySelector('[class*="poster-container"]') && !a.closest('[class*="meta-preview"]'));
  const shown = tiles.filter(vis);
  let doubles = 0, wrongId = 0, scores = [], marks = [];
  for (const a of tiles) {
    const host = a.querySelector('[class*="poster-container"]');
    const bs = host.querySelectorAll(':scope > .sr-badge');
    if (bs.length > 1) doubles++;
    const m = a.getAttribute('href').match(/(tt\\d+)/);
    for (const b of bs) { if (b.dataset.srId !== m[1]) wrongId++; if (b.querySelector('.sr-none')) marks.push(m[1]); else scores.push([m[1], +b.textContent]); }
  }
  const strays = document.querySelectorAll('.sr-badge').length - scores.length - marks.length;
  const rows = [...document.querySelectorAll('[class*="runtime-release-info"]')].filter(r => r.getClientRects().length);
  const rowItems = rows.map(r => r.querySelectorAll(':scope > .sr-row-item').length);
  return { tiles: tiles.length, visible: shown.length, badged: scores.length, marks, visibleBadged: shown.filter(a => a.querySelector('.sr-badge')).length, doubles, wrongId, strays, scores, rowItems };
})()`;

function checkScores(scores, label) {
  let bad = 0;
  for (const [id, s] of scores) { const e = expected(mockFor(id, null)); if (e !== s) { bad++; if (bad < 4) console.log(`    ${id}: shows ${s}, expected ${e}`); } }
  ok(scores.length > 0 && bad === 0, `${label}: every badge matches the blend recomputed from the spec`, `${scores.length} checked`);
}

// ---------- the suite ----------
async function suiteBuild(kind) {
  console.log(`\n■ ${kind} build — Discover, panel, breakdown, detail pages, series, Board, Search`);
  const b = await setUp();
  const inject = kind === 'plugin' ? injectPlugin : injectUserscript;
  try {
    await b.send('Page.navigate', { url: SITE + '#/discover' });
    await waitFor(b, tilesReady, LOAD);
    // Tile 1 = selected (the panel tests use it). Tile 2: OMDb knows it but has no ratings yet.
    // Tile 4: a 1.0.0-era cached empty answer with 13 of its 14 days left, which OMDb has since
    // filled in. Tile 6: OMDb has no entry.
    const first = await b.evaluate(`[...document.querySelectorAll('a[href*="#/detail/movie/"]')].filter(a => a.querySelector('[class*="poster-container"]') && !a.closest('[class*="meta-preview"]')).slice(0, 8).map(a => a.getAttribute('href').match(/tt\\d+/)[0])`);
    const [, unratedId, , staleId, , unknownId] = first;
    UNRATED.clear(); UNRATED.add(unratedId); UNKNOWN.add(unknownId);
    const stale = { e: Date.now() + 13 * 864e5, d: { id: staleId, title: 'Film ' + staleId, year: '2026', type: 'movie', imdb: null, votes: null, rt: null, mc: null } };
    await inject(b, { seed: [['c:omdb:' + staleId, stale]] });
    await waitFor(b, `document.querySelectorAll('.sr-badge').length >= 5`, 20000);
    await sleep(1200);
    let a = await b.evaluate(AUDIT);
    ok(a.visibleBadged >= a.visible - 1, 'Discover: every visible poster has a score or the quiet – marker', `${a.visibleBadged} of ${a.visible} visible`);
    const mark = await b.evaluate(`(() => { const s = document.querySelector('.sr-badge[data-sr-id="${unratedId}"] .sr-score'); return s && { none: s.classList.contains('sr-none'), text: s.textContent, title: s.title }; })()`);
    ok(!!mark && mark.none && mark.text === '–' && /OMDb/.test(mark.title) && /new releases/.test(mark.title), 'OMDb has the title but no ratings: a quiet – marker, the reason on hover', mark ? `"${mark.text}" — ${mark.title}` : 'no marker');
    const unk = await b.evaluate(`(() => { const s = document.querySelector('.sr-badge[data-sr-id="${unknownId}"] .sr-score'); return s && { none: s.classList.contains('sr-none'), title: s.title }; })()`);
    ok(!!unk && unk.none && /no entry/.test(unk.title), 'OMDb has no entry: the – marker too, never a score', unk ? unk.title : 'no marker');
    const staleShown = a.scores.find(([id]) => id === staleId);
    ok(!!staleShown && staleShown[1] === expected(mockFor(staleId, null)) && b.calls.some(c => c.i === staleId), 'A cached empty answer is trusted for a day at most: looked up again, its score shows', staleShown ? `${staleId} ★ ${staleShown[1]}` : `${staleId} still blank`);
    const mc = await centre(b, `document.querySelector('.sr-badge[data-sr-id="${unratedId}"] .sr-score')`);
    if (mc) {
      await click(b, mc.x, mc.y); await sleep(300);
      const mp = await b.evaluate(`(() => { const p = document.getElementById('sr-pop'); return { open: !p.hidden, text: p.innerText, imdb: [...p.querySelectorAll('a')].some(x => /imdb\\.com\\/title\\/${unratedId}/.test(x.href)) }; })()`);
      ok(mp.open && /lags new releases/.test(mp.text) && mp.imdb, 'Click the – marker: the breakdown says why and links the title on IMDb', mp.text.split('\n').find(l => /lags/.test(l)) || '');
      await shot(b, `${kind}-0-unrated-marker`);
      await esc(b); await sleep(200);
    } else ok(false, 'Click the – marker: marker on screen');
    if (kind === 'plugin') await checkSeSettings(b);
    ok(a.doubles === 0 && a.wrongId === 0 && a.strays === 0, 'Discover: no doubled, stale or stray badges', JSON.stringify({ doubles: a.doubles, wrongId: a.wrongId, strays: a.strays }));
    checkScores(a.scores, 'Discover');
    const looked = new Set(b.calls.map(c => c.i));
    ok(looked.size <= a.visible + 12 && looked.size < a.tiles, 'Only tiles in or near view are looked up', `${looked.size} lookups for ${a.tiles} tiles (${a.visible} visible)`);
    ok(b.calls.every(c => c.key === KEY && c.host === 'www.omdbapi.com'), 'Every OMDb call carries the key and goes to www.omdbapi.com');


    // The right-hand panel
    const sel = await b.evaluate(`(() => { const s = document.querySelector('[class*="meta-item-container"].selected a[href*="#/detail/"]'); return s && s.getAttribute('href').match(/tt\\d+/)[0]; })()`);
    await waitFor(b, `!!document.querySelector('[class*="meta-preview"] .sr-row-item .sr-score')`, 10000).catch(() => {});
    const panelId = await b.evaluate(`(() => { const s = document.querySelector('[class*="meta-preview"] .sr-row-item'); return s && s.dataset.srId; })()`);
    ok(!!sel && panelId === sel, 'Panel: the score sits in the runtime · year · IMDb row, for the selected title', `${panelId} vs selected ${sel}`);
    a = await b.evaluate(AUDIT);
    ok(a.rowItems.length >= 1 && a.rowItems.every(n => n === 1), 'Panel: exactly one score in the row', JSON.stringify(a.rowItems));
    await shot(b, `${kind}-1-discover`);

    // Click a third tile's badge: the breakdown opens, Discover's selection and the URL stay put.
    const target = await b.evaluate(`(() => { const bs = [...document.querySelectorAll('.sr-badge .sr-score:not(.sr-none)')].filter(x => { const r = x.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 20; }); const t = bs[2] || bs[0]; t.id = 'sr-test-target'; return t.closest('a').getAttribute('href'); })()`);
    const before = await b.evaluate('location.hash');
    const c = await centre(b, `document.getElementById('sr-test-target')`);
    await click(b, c.x, c.y);
    await sleep(400);
    const popInfo = await b.evaluate(`(() => { const p = document.getElementById('sr-pop'); const r = p.getBoundingClientRect(); return { open: !p.hidden, l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight, text: p.innerText, shares: [...p.querySelectorAll('td.s')].map(x => parseInt(x.textContent) || 0), links: [...p.querySelectorAll('a')].map(x => x.href) }; })()`);
    const selAfter = await b.evaluate(`(() => { const s = document.querySelector('[class*="meta-item-container"].selected a[href*="#/detail/"]'); return s && s.getAttribute('href').match(/tt\\d+/)[0]; })()`);
    ok(popInfo.open, 'Click a tile\'s score: the breakdown opens');
    ok(popInfo.l >= 0 && popInfo.t >= 0 && popInfo.r <= popInfo.w && popInfo.b <= popInfo.h, 'Breakdown stays on screen', `${Math.round(popInfo.l)},${Math.round(popInfo.t)} → ${Math.round(popInfo.r)},${Math.round(popInfo.b)} in ${popInfo.w}×${popInfo.h}`);
    ok((await b.evaluate('location.hash')) === before && selAfter === sel, 'The click neither opened nor selected the tile', `hash ${before}, selected ${selAfter}`);
    const sum = popInfo.shares.reduce((s, x) => s + x, 0);
    ok(Math.abs(sum - 100) <= 1, 'Breakdown weights add up to 100 %', popInfo.shares.join(' + '));
    ok(/Critics|Audiences/.test(popInfo.text) && /Metacritic/.test(popInfo.text) && /Rotten Tomatoes/.test(popInfo.text) && /IMDb/.test(popInfo.text), 'Breakdown lists Metacritic, Rotten Tomatoes and IMDb, with a verdict');
    ok(popInfo.links.some(h => /imdb\.com\/title\/tt/.test(h)) && popInfo.links.some(h => /rottentomatoes\.com/.test(h)) && popInfo.links.some(h => /metacritic\.com/.test(h)) && popInfo.links.some(h => /letterboxd\.com\/imdb\/tt/.test(h)), 'Breakdown links IMDb, RT, Metacritic and Letterboxd');
    await shot(b, `${kind}-2-breakdown`);
    await esc(b); await sleep(200);
    ok(await b.evaluate(`document.getElementById('sr-pop').hidden && location.hash === ${JSON.stringify(before)}`), 'Esc closes the breakdown and nothing else');
    await click(b, c.x, c.y); await sleep(300);
    await click(b, 1050, 860); await sleep(300);
    ok(await b.evaluate(`document.getElementById('sr-pop').hidden`), 'A click elsewhere closes it');

    // Select another tile (click its poster, not the badge): the panel follows, still one score.
    const other = await b.evaluate(`(() => { const as = [...document.querySelectorAll('a[href*="#/detail/"]')].filter(a => a.querySelector('.sr-badge .sr-score:not(.sr-none)') && !a.closest('.selected')); const a = as[1]; a.id = 'sr-test-tile'; return a.getAttribute('href').match(/tt\\d+/)[0]; })()`);
    const tc = await b.evaluate(`(() => { const r = document.querySelector('#sr-test-tile [class*="poster-container"]').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.7 }; })()`);
    await click(b, tc.x, tc.y);
    await waitFor(b, `(() => { const s = document.querySelector('[class*="meta-preview"] .sr-row-item'); return s && s.dataset.srId === ${JSON.stringify(other)} && s.querySelector('.sr-score'); })()`, 10000).catch(() => {});
    a = await b.evaluate(AUDIT);
    const panelNow = await b.evaluate(`(() => { const s = document.querySelector('[class*="meta-preview"] .sr-row-item'); return s && s.dataset.srId; })()`);
    ok(panelNow === other && a.rowItems.every(n => n === 1), 'Selecting another tile moves the panel\'s score to it, still one', `${panelNow} vs ${other}`);
    await shot(b, `${kind}-3-panel-follows`);

    // Detail pages: a film (all three sources) and two series (IMDb only).
    await go(b, '#/detail/movie/tt0118694/tt0118694');
    await waitFor(b, `(() => { const s = [...document.querySelectorAll('.sr-row-item')].find(x => x.getClientRects().length && x.dataset.srId === 'tt0118694'); return s && s.textContent; })()`, 30000).catch(() => {});
    const film = await b.evaluate(`(() => { const s = [...document.querySelectorAll('.sr-row-item')].find(x => x.getClientRects().length && x.dataset.srId === 'tt0118694'); return s ? s.textContent : null; })()`);
    ok(film === '83', 'Film page: In the Mood for Love shows ★ 83 (mock MC 87 · RT 92 % · IMDb 8.0 / 192k)', `shows ${film}`);
    const fc = await centre(b, `[...document.querySelectorAll('.sr-row-item .sr-score')].find(x => x.getClientRects().length)`);
    await click(b, fc.x, fc.y); await sleep(300);
    const fp = await b.evaluate(`(() => { const p = document.getElementById('sr-pop'); const r = p.getBoundingClientRect(); return { open: !p.hidden, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, text: p.innerText, hash: location.hash }; })()`);
    ok(fp.open && fp.inside && /Critics and audiences both loved it\./.test(fp.text), 'Film page: breakdown opens on screen with its verdict', fp.text.split('\n')[1]);
    ok(fp.hash === '#/detail/movie/tt0118694/tt0118694', 'Film page: the click stayed on the page');
    await shot(b, `${kind}-4-film-page`);
    await esc(b); await sleep(200);
    ok(await b.evaluate(`location.hash === '#/detail/movie/tt0118694/tt0118694' && document.getElementById('sr-pop').hidden`), 'Film page: Esc closed the box and did not leave the page');

    for (const id of ['tt0903747', 'tt0944947']) {
      await go(b, `#/detail/series/${id}`);
      await waitFor(b, `[...document.querySelectorAll('.sr-row-item')].some(x => x.getClientRects().length && x.dataset.srId === '${id}' && x.querySelector('.sr-score'))`, 30000).catch(() => {});
      const sc = await centre(b, `[...document.querySelectorAll('.sr-row-item')].find(x => x.getClientRects().length && x.dataset.srId === '${id}')?.querySelector('.sr-score')`);
      if (!sc) { ok(false, `Series ${id}: score shown`); continue; }
      await click(b, sc.x, sc.y); await sleep(300);
      const sp = await b.evaluate(`(() => { const p = document.getElementById('sr-pop'); return { open: !p.hidden, text: p.innerText, shares: [...p.querySelectorAll('td.s')].map(x => x.textContent).filter(Boolean), lb: [...p.querySelectorAll('a')].some(a => /letterboxd/.test(a.href)) }; })()`);
      ok(sp.open && /IMDb only/.test(sp.text) && sp.shares.join() === '100%' && !sp.lb, `Series ${id}: IMDb-only score, said plainly, IMDb weight 100 %, no Letterboxd link`, sp.text.split('\n').find(l => /IMDb only/.test(l)) || '');
      if (id === 'tt0903747') await shot(b, `${kind}-5-series`);
      await esc(b); await sleep(150);
    }

    // Board and Search
    for (const [hash, label] of [['#/', 'Board'], ['#/search?search=matrix', 'Search']]) {
      await go(b, hash);
      await waitFor(b, `[...document.querySelectorAll('a[href*="#/detail/"] .sr-badge')].some(x => x.getClientRects().length)`, 30000).catch(() => {});
      await sleep(1500);
      a = await b.evaluate(AUDIT);
      ok(a.visibleBadged >= Math.max(3, a.visible - 2) && a.doubles === 0 && a.wrongId === 0, `${label}: visible tiles have one score each`, `${a.visibleBadged} of ${a.visible} visible, doubles ${a.doubles}`);
      checkScores(a.scores, label);
      await shot(b, `${kind}-6-${label.toLowerCase()}`);
    }
    // Switch Discover to another catalogue: Stremio may reuse tiles for new titles; no stale scores.
    await go(b, '#/discover/https%3A%2F%2Fv3-cinemeta.strem.io%2Fmanifest.json/series/top');
    await waitFor(b, `[...document.querySelectorAll('a[href*="#/detail/series/"] .sr-badge')].some(x => x.getClientRects().length)`, 30000).catch(() => {});
    await sleep(1500);
    a = await b.evaluate(AUDIT);
    ok(a.visibleBadged >= Math.max(3, a.visible - 2) && a.doubles === 0 && a.wrongId === 0 && a.rowItems.every(n => n === 1), 'Discover → Series: fresh scores, none stale or doubled, one in the panel', `${a.visibleBadged} of ${a.visible} visible, wrongId ${a.wrongId}, panel ${JSON.stringify(a.rowItems)}`);
    await shot(b, `${kind}-7-discover-series`);
    ok(b.leaks.length === 0, 'The key went nowhere but www.omdbapi.com', b.leaks.join(', '));
    if (kind === 'plugin') {
      const inLs = await b.evaluate(`Object.keys(localStorage).some(k => (localStorage.getItem(k) || '').includes(${JSON.stringify(KEY)}))`);
      ok(!inLs, 'Plugin: the key is not in the page\'s localStorage (it lives in SE\'s plugin settings)');
      const n = await b.evaluate(`Object.keys(localStorage).filter(k => k.startsWith('stremio-ratings:')).length`);
      const budget = await b.evaluate(`JSON.parse(localStorage.getItem('stremio-ratings:omdbBudget') || 'null')`);
      ok(budget && budget.used === b.calls.length, 'Plugin: the day\'s OMDb count matches the calls made', `${budget && budget.used} vs ${b.calls.length}`);
      // Reload: everything seen so far comes from the cache.
      const seen = b.calls.length;
      await b.send('Page.navigate', { url: SITE + '#/discover' });
      await waitFor(b, tilesReady, LOAD);
      await injectPlugin(b);
      await waitFor(b, `document.querySelectorAll('.sr-badge').length >= 5`, 20000).catch(() => {});
      await sleep(1500);
      ok(b.calls.length === seen, 'After a reload, Discover\'s scores come from the cache: no new OMDb calls', `${b.calls.length - seen} new, ${n} cache entries`);
    }
  } finally { await b.close(); }
}

async function suiteNoKeyAndLimit() {
  console.log('\n■ plugin build — no key, saving the key in the page, and OMDb\'s daily limit');
  let b = await setUp();
  try {
    await b.send('Page.navigate', { url: SITE + '#/discover' });
    await waitFor(b, tilesReady, LOAD);
    await injectPlugin(b, { key: '' });
    await sleep(1500);
    ok(b.calls.length === 0 && (await b.evaluate(`document.querySelectorAll('.sr-badge, .sr-row-item .sr-score').length`)) === 0, 'No key: Discover shows no scores and calls nothing');
    await go(b, '#/detail/movie/tt0118694/tt0118694');
    await waitFor(b, `[...document.querySelectorAll('[class*="runtime-release-info"]')].some(r => r.getClientRects().length)`, 60000);
    await waitFor(b, `!!document.querySelector('.sr-keybox input')`, 10000).catch(() => {});
    const box = await b.evaluate(`(() => { const k = document.querySelector('.sr-keybox'); return k && k.innerText; })()`);
    ok(!!box && /free OMDb key/.test(box) && b.calls.length === 0, 'No key: the title page shows the key box, and nothing calls OMDb', (box || '').split('\n')[0]);
    await shot(b, 'plugin-7-no-key');
    await b.evaluate(`document.querySelector('.sr-keybox input').focus()`);
    await b.send('Input.insertText', { text: 'Here is your key: ' + KEY });
    const sv = await centre(b, `document.querySelector('.sr-keybox .sr-solid')`);
    await click(b, sv.x, sv.y);
    await waitFor(b, `[...document.querySelectorAll('.sr-row-item .sr-score')].some(x => x.getClientRects().length)`, 10000).catch(() => {});
    const after = await b.evaluate(`({ score: [...document.querySelectorAll('.sr-row-item .sr-score')].find(x => x.getClientRects().length)?.textContent, box: !!document.querySelector('.sr-keybox'), saved: window.__seCfg.omdb_key === ${JSON.stringify(KEY)} })`);
    ok(after.score === '83' && !after.box && after.saved, 'Pasting a line with the key and Save: the score appears, the box goes, the key is saved to SE\'s settings', JSON.stringify(after));
    await b.evaluate(`window.StremioEnhancedAPI.saveSetting('stremio-ratings', 'clear_cache', true)`);
    await sleep(500);
    const cleared = await b.evaluate(`({ cache: Object.keys(localStorage).filter(k => k.startsWith('stremio-ratings:c:')).length, toggle: window.__seCfg.clear_cache })`);
    ok(cleared.toggle === false, 'SE settings "Clear cached ratings" clears and switches itself off', JSON.stringify(cleared));
  } finally { await b.close(); }

  b = await setUp({ mode: 'limit' });
  try {
    await b.send('Page.navigate', { url: SITE + '#/discover' });
    await waitFor(b, tilesReady, LOAD);
    await injectPlugin(b);
    await sleep(4000);
    const n1 = b.calls.length;
    const budget = await b.evaluate(`JSON.parse(localStorage.getItem('stremio-ratings:omdbBudget') || 'null')`);
    ok(n1 >= 1 && n1 <= 3 && budget && budget.full === true, '"Request limit reached!": the day is marked full after the first answer, so calls stop', `${n1} calls, budget ${JSON.stringify(budget)}`);
    ok(await b.evaluate(`document.querySelectorAll('.sr-badge').length === 0`), 'Limit: no tile shows a made-up score');
    await go(b, '#/detail/movie/tt0118694/tt0118694');
    await waitFor(b, `!!document.querySelector('.sr-keybox')`, 15000).catch(() => {});
    const msg = await b.evaluate(`document.querySelector('.sr-keybox')?.innerText || ''`);
    ok(/used up/.test(msg) && b.calls.length === n1, 'Limit: the title page says the lookups are used up, and still makes no call', msg);
    await shot(b, 'plugin-8-limit');
  } finally { await b.close(); }
}

// ---------- run ----------
try {
  console.log('■ build is current');
  try { execFileSync('node', [join(ROOT, 'stremio-ratings', 'build.mjs'), '--check'], { stdio: 'pipe' }); ok(true, 'stremio-ratings.user.js and .plugin.js match src/'); }
  catch (e) { ok(false, 'built files match src/', String(e.stdout || e.message).trim()); }
  const plugin = readFileSync(join(ROOT, 'stremio-ratings.plugin.js'), 'utf8');
  const head = (plugin.match(/\/\*\*([\s\S]*?)\*\//) || [])[1] || '';
  ok(['name', 'description', 'author', 'version'].every(k => new RegExp('@' + k + '\\s+\\S').test(head)), 'Plugin header: SE\'s required @name, @description, @author, @version in the first /** block');
  const v1 = (plugin.match(/@version\s+(\S+)/) || [])[1], v2 = (readFileSync(join(ROOT, 'stremio-ratings.user.js'), 'utf8').match(/@version\s+(\S+)/) || [])[1];
  ok(v1 && v1 === v2, 'Both builds carry the same @version', `${v1} / ${v2}`);
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
  if (!only || only === 'plugin') await suiteBuild('plugin');
  if (!only || only === 'userscript') await suiteBuild('userscript');
  if (!only || only === 'nokey') await suiteNoKeyAndLimit();
} catch (e) { failed++; console.log('  ✗ the run broke: ' + (e.stack || e.message)); }
console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
