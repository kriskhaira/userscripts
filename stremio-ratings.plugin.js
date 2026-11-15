/**
 * @name Stremio Ratings
 * @description One number per film or series on Stremio — poster tiles, Discover’s side panel and the title page: a critic-weighted blend of Metacritic, Rotten Tomatoes and IMDb (via a free OMDb key). Click it for the breakdown and links.
 * @updateUrl https://raw.githubusercontent.com/kriskhaira/userscripts/main/stremio-ratings.plugin.js
 * @version 1.2.0
 * @author Kris Khaira
 * @source https://github.com/kriskhaira/userscripts
 */
// Built by stremio-ratings/build.mjs from stremio-ratings/src/ — edit those, not this file.

(function () {
'use strict';

// Stremio ratings — the shared core. build.mjs wraps it twice: as a Violentmonkey userscript
// (web.stremio.com in Chrome) and as a Stremio Enhanced plugin. Each wrapper hands it a `host`
// with storage, a JSON GET and the key's home; everything else lives here, once.
//
// Why (Kris, 2026-11-14): "how to get ratings on movies and tv series for stremio like we did with
// MUBI?" — then "go" on 2026-11-15. Same idea as mubi-ratings.user.js: one critic-weighted number
// per title, in the site's own look, with the breakdown one click away.
//
// The number (1–99; 60 = an average film):
// - Each score becomes "how far above or below an average film" (a z-score), with the same rough
//   population figures as the MUBI script (estimates, not measured): Metacritic 58 ± 17,
//   Tomatometer 62 ± 28, IMDb 6.4 ± 1.0. The result maps to 60 ± 16 per step, clamped to 1–99.
// - Kris's MUBI ruling, critics 65 % / audiences 35 %, with MUBI's own sources gone: Metacritic 42,
//   Rotten Tomatoes 23, IMDb 35. IMDb counts less on few votes (votes / (votes + 1000)); a missing
//   source drops out and the rest share its weight; thin evidence is pulled toward 60.
// - Series: OMDb usually carries only IMDb for a series, so a series score is often IMDb-only, and
//   the breakdown says so.
//
// Data: OMDb by IMDb ID (?i=tt…), exact, no title guessing — Stremio's tiles link to
// #/detail/<movie|series>/tt…. Free key = 1,000 calls a day, shared with the MUBI script (which
// stops at its own 950), so this one stops at 400 and treats "Request limit reached!" as a full
// day. Cache: OMDb 14 days; an answer with no usable rating (no entry, or no ratings yet) 1 day,
// because OMDb lags new releases (15 Nov 2026: six 2026 films IMDb already rated came back empty,
// Resident Evil among them at IMDb 7.4 from 166k votes). Such a title gets a quiet "★ –" marker,
// the reason on hover, so a blank never reads as broken. Tiles look up only once they scroll into view.
// IMDb's own daily file fills a missing IMDb number (1.2.0, Kris's "445 go", 16 Nov 2026): see
// "IMDb's daily ratings file" below.
// The key goes only to www.omdbapi.com; DOM is built with createElement + textContent; nothing
// from the API is parsed as HTML.
//
// Markup checked 2026-11-15 on web.stremio.com (class names end in a generated hash, so only the
// readable prefix is matched):
// - tile: a[href="#/detail/movie/tt…/tt…"] > div[class^="poster-container"] (position: relative,
//   z-index 0 — its own layer); Stremio uses its top-left (watched, dismiss) and, for library
//   series with new episodes, its top-right ("new-videos"), so the badge drops below that one;
// - Discover's right panel and the detail page share one component: div[class*="meta-preview"] >
//   … > div[class*="runtime-release-info"] (runtime · year · IMDb button) — the score joins that row.

function stremioRatings(host) {
  'use strict';

  const TAG = '[stremio-ratings]';
  const DAY = 864e5;
  const TTL_OMDB = 14 * DAY;
  const TTL_EMPTY = DAY; // no entry, or no ratings yet: OMDb lags new releases, so ask again tomorrow
  const OMDB_CAP = 400; // of the free 1,000 a day; MUBI's script stops at its own 950
  const BAD_RETRY = 10 * 60e3; // a rejected key is re-tried after 10 min (a new key works only once activated)
  const KEY_RE = /^[a-z0-9]{8}$/i;
  const DETAIL = /#\/detail\/(movie|series)\/(tt\d{5,10})(?![0-9])/i;
  const TILE = { minW: 60, maxW: 600, minH: 60 };
  const now = () => Date.now();

  // ---------- the blend ----------
  const SOURCES = [
    { key: 'mc', label: 'Metacritic', kind: 'critics', w: 0.42, mean: 58, sd: 17 },
    { key: 'rt', label: 'Rotten Tomatoes', kind: 'critics', w: 0.23, mean: 62, sd: 28 },
    { key: 'imdb', label: 'IMDb', kind: 'audience', w: 0.35, mean: 6.4, sd: 1.0, k: 1000 },
  ];
  const SHRINK = 0.08; // evidence prior: pulls thin-evidence titles toward 60
  const MID = 60, PER_SD = 16;
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };

  function values(r) {
    return { mc: num(r && r.mc), rt: num(r && r.rt), imdb: num(r && r.imdb), imdbN: Math.max(0, num(r && r.votes) || 0) };
  }

  function blend(v) {
    const parts = []; let wz = 0, w = 0;
    for (const s of SOURCES) {
      const value = v[s.key];
      if (value == null) { parts.push({ ...s, value: null }); continue; }
      const n = s.k ? v[s.key + 'N'] : null;
      const we = s.w * (s.k ? n / (n + s.k) : 1);
      wz += we * (value - s.mean) / s.sd; w += we;
      parts.push({ ...s, value, n, we });
    }
    if (!w) return { score: null, parts };
    for (const p of parts) if (p.we) p.share = p.we / w;
    return { score: Math.max(1, Math.min(99, Math.round(MID + PER_SD * wz / (w + SHRINK)))), parts };
  }

  // ---------- storage (host: get / set / del / list, all synchronous) ----------
  const cacheGet = k => { const v = host.get('c:' + k); return v && v.e > now() ? v : null; };
  const cacheSet = (k, d, ttl) => host.set('c:' + k, { e: now() + ttl, d });
  (function prune() {
    const keys = host.list().filter(k => k.startsWith('c:'));
    if (keys.length < (host.maxEntries || 4000)) return;
    const t = now(), live = [];
    for (const k of keys) { const v = host.get(k); if (!v || v.e <= t) host.del(k); else live.push([k, v.e]); }
    const room = Math.floor((host.maxEntries || 4000) * 0.75);
    if (live.length > room) live.sort((a, b) => a[1] - b[1]).slice(0, live.length - room).forEach(([k]) => host.del(k));
  })();

  // ---------- network ----------
  function limiter(n) {
    let active = 0; const queue = [];
    const next = () => {
      if (active >= n || !queue.length) return;
      active++;
      const { fn, ok, fail } = queue.shift();
      fn().then(ok, fail).finally(() => { active--; next(); });
    };
    return fn => new Promise((ok, fail) => { queue.push({ fn, ok, fail }); next(); });
  }
  const omdbQ = limiter(2);
  const inflight = new Map();
  function once(key, fn) {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  // ---------- OMDb ----------
  class OmdbStop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const today = () => new Date().toISOString().slice(0, 10);
  function budget() { const b = host.get('omdbBudget'); return b && b.day === today() ? b : { day: today(), used: 0, full: false }; }

  async function omdb(params) {
    const key = host.getKey();
    if (!key) throw new OmdbStop('nokey', 'no OMDb key');
    const bad = host.get('omdbBad');
    if (bad && bad.key === key && now() - bad.at < BAD_RETRY) throw new OmdbStop('badkey', bad.msg || 'Invalid API key!');
    const b = budget();
    if (b.full || b.used >= OMDB_CAP) throw new OmdbStop('limit', 'daily limit');
    b.used++; host.set('omdbBudget', b);
    const r = await omdbQ(() => host.request('https://www.omdbapi.com/?' + new URLSearchParams({ apikey: key, ...params })));
    const err = (r.body && r.body.Error) || '';
    if (/limit/i.test(err)) { b.full = true; host.set('omdbBudget', b); throw new OmdbStop('limit', err); }
    if (r.status === 401 || /api key/i.test(err)) {
      host.set('omdbBad', { key, at: now(), msg: err || 'HTTP 401' });
      console.debug(TAG, 'OMDb rejected the key:', err || 'HTTP 401'); // the key itself is never logged
      throw new OmdbStop('badkey', err || 'HTTP 401');
    }
    if (r.status !== 200 || !r.body) throw new Error('OMDb HTTP ' + r.status);
    return r.body.Response === 'True' ? r.body : null;
  }

  function summarise(d) {
    const na = v => (!v || v === 'N/A') ? null : String(v);
    const rt = (d.Ratings || []).find(x => x && x.Source === 'Rotten Tomatoes');
    return {
      id: String(d.imdbID || ''), title: String(d.Title || ''), year: na(d.Year), type: na(d.Type),
      imdb: na(d.imdbRating), votes: na(d.imdbVotes), rt: rt ? String(rt.Value) : null, mc: na(d.Metascore),
    };
  }

  const usable = r => blend(values(r)).score != null;
  function omdbFor(id) {
    const c = cacheGet('omdb:' + id);
    // An empty answer is trusted for a day at most, including one 1.0.0 cached for 14 days.
    if (c && (usable(c.d) || c.e - now() <= TTL_EMPTY)) return Promise.resolve(c.d);
    return once('omdb:' + id, async () => {
      const d = await omdb({ i: id });
      const r = d ? summarise(d) : null;
      cacheSet('omdb:' + id, r, usable(r) ? TTL_OMDB : TTL_EMPTY);
      return r;
    });
  }

  // ---------- IMDb's daily ratings file ----------
  // OMDb lags new releases (15 Nov 2026: Resident Evil empty on OMDb, IMDb 7.4 from 166k votes). When
  // OMDb answers with no IMDb rating, the number comes from IMDb's non-commercial dataset
  // title.ratings.tsv.gz: ~8.8 MB gzip, 1.7M rows, refreshed daily, no key; personal, non-commercial
  // use only, with IMDb's credit line wherever its data shows (developer.imdb.com/non-commercial-datasets).
  // - Downloaded only when a title needs it, and at most once a day; kept as one gzip blob in this
  //   site's IndexedDB, so a reload or a new tab reads it from disk instead of downloading again.
  // - Read as a stream (gzip → text, chunk by chunk) for just the queued IDs, then dropped from
  //   memory; only those IDs' numbers are cached (1 day), never the file's rows.
  // - The server sends no CORS header: only a host with host.getBinary reads it (the userscript's
  //   GM_xmlhttpRequest; Stremio Enhanced, whose window runs with webSecurity off). Without it, ★ –.
  const IMDB_FILE = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
  const IMDB_CREDIT = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';
  const FILE_EVERY = DAY, FILE_RETRY = 60 * 60e3, TTL_FILE = DAY;
  function fileStore(mode, fn) {
    return new Promise((ok, fail) => {
      const open = indexedDB.open('stremio-ratings', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files');
      open.onerror = () => fail(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('files', mode), req = fn(tx.objectStore('files'));
        tx.oncomplete = () => { db.close(); ok(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); fail(tx.error || new Error('IndexedDB')); };
      };
    });
  }
  async function imdbBlob() {
    const kept = await fileStore('readonly', st => st.get('title.ratings')).catch(() => null);
    if (kept && now() - kept.at < FILE_EVERY) return kept.blob;
    const t = host.get('imdbFile') || {}; // when it was last downloaded, or last tried and failed
    if (t.ok && now() - t.ok < FILE_EVERY) return kept ? kept.blob : null; // today's copy wasn't kept: no second download
    if (t.fail && now() - t.fail < FILE_RETRY) return kept ? kept.blob : null;
    let r;
    try { r = await host.getBinary(IMDB_FILE); } catch (e) { r = { status: 0, why: e.message }; }
    if (r.status !== 200 || !r.body || !r.body.byteLength) {
      host.set('imdbFile', { ...t, fail: now() });
      console.debug(TAG, 'IMDb file not downloaded:', r.why || 'HTTP ' + r.status);
      return kept ? kept.blob : null;
    }
    host.set('imdbFile', { ok: now() });
    const blob = new Blob([r.body]);
    await fileStore('readwrite', st => st.put({ at: now(), blob }, 'title.ratings')).catch(e => console.debug(TAG, 'IMDb file not kept:', e && e.message));
    return blob;
  }
  // One pass over the file for a set of IDs. Lines are "tconst \t averageRating \t numVotes". The
  // bytes are read as they come (no text decoding, no string per line): only a matching line is
  // copied out. A full pass over the 1.7M rows takes ~0.1 s; it stops early once every ID is found.
  async function scanFile(blob, ids) {
    const want = new Map(); // digit count and number → "tt…", so tt0133093 never matches tt00133093
    for (const id of ids) { const m = /^tt(\d{1,10})$/.exec(id); if (m) want.set(m[1].length * 1e11 + Number(m[1]), id); }
    const found = new Map();
    if (!want.size) return found;
    const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    // st: 0 = reading "tt" · 1 = reading the number · 2 = not wanted, skip to the line's end · 3 = wanted, copy
    let st = 0, tt = 0, n = 0, len = 0, id = '', line = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === 10) {
          if (st === 3) { const [r, v] = line.split('\t'); if (num(r) != null && num(v)) found.set(id, { rating: num(r), votes: num(v) }); }
          st = 0; tt = 0; n = 0; len = 0; line = '';
        } else if (st === 0) { if (c === 116) { if (++tt === 2) st = 1; } else st = 2; }
        else if (st === 1) {
          if (c >= 48 && c <= 57 && len < 10) { n = n * 10 + c - 48; len++; }
          else if (c === 9 && want.has(len * 1e11 + n)) { id = want.get(len * 1e11 + n); st = 3; }
          else st = 2;
        } else if (st === 3) line += String.fromCharCode(c);
      }
      if (found.size === want.size) { reader.cancel().catch(() => {}); break; }
    }
    return found;
  }
  // Titles are queued for a moment so one pass serves a whole screen.
  const fileQueue = new Map();
  let fileTimer = 0, fileBusy = false;
  function imdbFromFile(id) {
    if (!host.getBinary || typeof DecompressionStream === 'undefined' || typeof indexedDB === 'undefined') return Promise.resolve(null);
    const c = cacheGet('imdbf:' + id);
    if (c) return Promise.resolve(c.d);
    return new Promise(ok => {
      if (!fileQueue.has(id)) fileQueue.set(id, []);
      fileQueue.get(id).push(ok);
      clearTimeout(fileTimer); fileTimer = setTimeout(runFileQueue, 600);
    });
  }
  async function runFileQueue() {
    if (fileBusy) return; // the running pass picks up whatever was queued meanwhile
    fileBusy = true;
    try {
      while (fileQueue.size) {
        const batch = new Map(fileQueue); fileQueue.clear();
        let found = null;
        try { const blob = await imdbBlob(); if (blob) found = await scanFile(blob, [...batch.keys()]); }
        catch (e) { console.debug(TAG, 'IMDb file:', e.message); }
        for (const [id, waiting] of batch) {
          const d = found ? found.get(id) || null : null;
          if (found) cacheSet('imdbf:' + id, d, TTL_FILE); // no file today: not cached, asked again later
          waiting.forEach(f => f(d));
        }
      }
    } finally { fileBusy = false; }
  }

  // Everything one title needs: OMDb data (or why not), IMDb's file for a missing IMDb number, the blend.
  function ratingsFor(id, type) {
    return once('rate:' + id, async () => {
      let r = null, status = 'ok', why = '';
      try { r = await omdbFor(id); if (!r) status = 'nomatch'; }
      catch (e) { status = e instanceof OmdbStop ? e.code : 'error'; why = e.message; if (status === 'error') console.debug(TAG, id, e.message); }
      if ((status === 'ok' || status === 'nomatch') && !(r && num(r.imdb) != null && num(r.votes))) {
        const f = await imdbFromFile(id);
        if (f) {
          r = { ...(r || { id, title: '', year: null, type: type || null, rt: null, mc: null }), imdb: String(f.rating), votes: String(f.votes), imdbFile: true };
          status = 'ok';
        }
      }
      const b = blend(values(r));
      if (status === 'ok' && b.score == null) status = 'unrated'; // OMDb knows it, rates nothing yet
      return { id, type: (r && r.type) || type || 'movie', r, status, why, ...b };
    });
  }

  // ---------- DOM helpers ----------
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') e.style.cssText = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const fmt1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const fmtCount = n => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: text });
  const note = text => el('span', { className: 'sr-note', textContent: text });
  function star() {
    const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', 'M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.9l-6.4 3.5 1.4-7.1-5.3-5 7.2-.9z');
    s.append(p); return s;
  }
  const scoreFace = score => [star(), el('span', { textContent: score == null ? '–' : String(score) })];
  const QUIET = new Set(['unrated', 'nomatch']); // no score for a reason worth showing: the "★ –" marker

  // Stremio's own look: its font (PlusJakartaSans, inherited), its white foreground and near-black
  // background, its pill radius. White outline, no colour bands (Kris's MUBI ruling, 6 Nov 2026:
  // "stick to white and black" … "same colours as on the site"). Over a poster the pill carries a
  // dark glass fill so it reads on snow and on black alike; hover inverts it, white with dark text.
  const FG = 'var(--primary-foreground-color, rgba(255,255,255,.9))';
  const BG = 'rgb(12,11,17)'; // Stremio's --primary-background-color
  document.head.append(el('style', { id: 'sr-style', textContent: `
    .sr-badge{position:absolute;top:.5rem;right:.5rem;z-index:1;pointer-events:none;line-height:0}
    .sr-badge.sr-low{top:2.1rem}
    .sr-score{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:.3em;box-sizing:border-box;margin:0;border:2px solid ${FG};border-radius:999px;background:rgba(12,11,17,.58);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);color:#fff;font-family:inherit;font-weight:700;font-size:13px;line-height:1;letter-spacing:.01em;font-variant-numeric:tabular-nums;white-space:nowrap;padding:4px 9px 4px 7px;box-shadow:0 1px 4px rgba(0,0,0,.35);transition:background-color .15s,color .15s}
    .sr-score svg{width:.95em;height:.95em;fill:currentColor;flex:none;margin-top:-.08em}
    .sr-score:hover,.sr-score[aria-expanded="true"]{background:#fff;border-color:#fff;color:${BG}}
    .sr-score:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .sr-score.sr-none{opacity:.55;font-weight:600}
    .sr-score.sr-none:hover,.sr-score.sr-none[aria-expanded="true"]{opacity:1}
    .sr-score.sr-big{font-size:1.1rem;font-weight:700;gap:.35em;padding:.45rem .95rem .45rem .75rem;box-shadow:none}
    .sr-row-item{flex:none;display:inline-flex;align-items:center}
    .sr-keybox{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.75rem 0 .25rem;font-family:inherit;font-size:.95rem}
    .sr-note{color:${FG};font-weight:500;font-size:.95rem}
    .sr-keybox input{font-family:inherit;font-weight:500;font-size:.95rem;padding:.5rem .8rem;border-radius:999px;border:2px solid rgba(255,255,255,.35);background:rgba(12,11,17,.6);color:#fff;width:9em;-webkit-text-security:disc}
    .sr-keybox input.sr-bad{border-color:#fff}
    .sr-keybox .sr-btn,.sr-keybox a.sr-btn{font-family:inherit;font-weight:600;font-size:.95rem;padding:.5rem 1rem;border-radius:999px;border:0;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;text-decoration:none;white-space:nowrap}
    .sr-keybox .sr-btn.sr-solid{background:#fff;color:${BG}}
    .sr-keybox .sr-btn:hover{background:rgba(255,255,255,.2)}
    .sr-keybox .sr-btn.sr-solid:hover{background:rgba(255,255,255,.85)}
    #sr-pop{position:fixed;z-index:2147483000;width:330px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;background:var(--modal-background-color, rgb(15,13,32));color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:var(--border-radius, .75rem);box-shadow:0 12px 36px rgba(0,0,0,.6);padding:14px 16px;font-size:13px;line-height:1.45;text-align:left}
    #sr-pop[hidden]{display:none}
    #sr-pop .sr-h{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-weight:700;font-size:14px}
    #sr-pop .sr-h .sr-score{cursor:default;pointer-events:none;background:none;color:#fff;border-color:#fff;box-shadow:none}
    #sr-pop .sr-sum{margin:0 0 8px;font-weight:700;font-size:13px}
    #sr-pop table{border-collapse:collapse;width:100%}
    #sr-pop th{font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.45;text-align:left;padding:6px 0 2px}
    #sr-pop td{padding:2px 0;vertical-align:baseline}
    #sr-pop td.v{text-align:right;font-weight:700;padding-left:10px;white-space:nowrap}
    #sr-pop td.s{text-align:right;opacity:.6;padding-left:10px;font-size:12px;white-space:nowrap}
    #sr-pop .sr-miss{opacity:.4}
    #sr-pop a{color:#fff;text-decoration:underline;text-underline-offset:2px}
    #sr-pop .sr-foot{margin-top:10px;font-size:12px;opacity:.75}
    #sr-pop .sr-warn{margin-top:8px;font-size:12px;font-weight:600;border-left:2px solid #fff;padding-left:8px}
  ` }));

  // ---------- the breakdown popover ----------
  const pop = el('div', { id: 'sr-pop', role: 'dialog', 'aria-label': 'Rating breakdown', hidden: true });
  document.body.append(pop);
  let popOwner = null, popSide = null;

  const isSeries = info => /series/i.test(info.type);
  function sourceLink(key, info) {
    const { r, id } = info;
    const q = encodeURIComponent((r && r.title) || '');
    if (key === 'imdb') return `https://www.imdb.com/title/${id}/`;
    if (key === 'mc') return `https://www.metacritic.com/search/${q}/${isSeries(info) ? '' : '?category=2'}`;
    return `https://www.rottentomatoes.com/search?search=${q}`;
  }
  function shown(p) {
    if (p.value == null) return '–';
    if (p.key === 'rt') return Math.round(p.value) + '%';
    if (p.key === 'mc') return String(Math.round(p.value));
    return fmt1(p.value) + (p.n ? ' · ' + fmtCount(p.n) : '');
  }

  // One plain line from the numbers: each side's weighted distance from an average film.
  const VERDICT = [[1.2, 'loved it'], [0.5, 'liked it'], [-0.5, 'were mixed'], [-Infinity, 'disliked it']];
  function verdict(parts, kind) {
    let wz = 0, w = 0;
    for (const p of parts) if (p.kind === kind && p.we) { wz += p.we * (p.value - p.mean) / p.sd; w += p.we; }
    return w ? VERDICT.find(([t]) => wz / w >= t)[1] : null;
  }
  function summary(parts) {
    const c = verdict(parts, 'critics'), a = verdict(parts, 'audience');
    if (c && a) return c === a ? `Critics and audiences ${c === 'were mixed' ? 'were both mixed' : 'both ' + c}.` : `Critics ${c}; audiences ${a}.`;
    return c ? `Critics ${c}.` : a ? `Audiences ${a}.` : '';
  }

  const MSG = {
    nokey: () => `IMDb, Rotten Tomatoes and Metacritic need a free OMDb key: ${host.keyHint}.`,
    badkey: why => `OMDb rejected the saved key (“${why}”). Click the activation link in OMDb’s email, then try again: ${host.keyHint}.`,
    limit: () => 'Today’s OMDb lookups are used up (this script stops at 400 of the free 1,000, shared with MUBI) — back tomorrow.',
    nomatch: () => 'No score yet: OMDb has no entry for this IMDb ID. It lags new releases; looked up again tomorrow.',
    unrated: () => 'No score yet: OMDb has no IMDb, Rotten Tomatoes or Metacritic rating for this title. It lags new releases, so IMDb may already rate it; looked up again tomorrow.',
    error: why => `Ratings didn’t load: ${why}`,
  };

  function fillPop(info) {
    const { r, status, why, score, parts } = info;
    const title = r && r.title ? `${r.title}${r.year ? ` (${r.year})` : ''}` : info.id;
    const head = el('div', { className: 'sr-h' }, el('span', { className: 'sr-score' }, ...scoreFace(score)), el('span', { textContent: title }));
    const table = el('table');
    for (const kind of ['critics', 'audience']) {
      table.append(el('tr', {}, el('th', { colSpan: 3, textContent: kind === 'critics' ? 'Critics' : 'Audiences' })));
      for (const p of parts.filter(x => x.kind === kind)) {
        table.append(el('tr', { className: p.value == null ? 'sr-miss' : '' },
          el('td', {}, link(sourceLink(p.key, info), p.label)),
          el('td', { className: 'v', textContent: shown(p) }),
          el('td', { className: 's', textContent: p.share ? Math.round(p.share * 100) + '%' : '' })));
      }
    }
    const kids = [head];
    const sum = summary(parts);
    if (sum) kids.push(el('p', { className: 'sr-sum', textContent: sum }));
    kids.push(table);
    const used = parts.filter(p => p.we);
    if (used.length === 1 && used[0].key === 'imdb') {
      kids.push(el('div', { className: 'sr-warn', textContent: isSeries(info)
        ? 'IMDb only: OMDb carries no Rotten Tomatoes or Metacritic score for this series, so this number is IMDb’s alone.'
        : 'IMDb only: OMDb has no Rotten Tomatoes or Metacritic score for this film, so this number is IMDb’s alone.' }));
    }
    if (r && r.imdbFile) kids.push(el('div', { className: 'sr-warn', textContent: 'IMDb’s number is from IMDb’s own daily file: OMDb has no IMDb rating for this title yet.' }));
    if (MSG[status]) kids.push(el('div', { className: 'sr-warn', textContent: MSG[status](why) }));
    const foot = el('div', { className: 'sr-foot' }, '60 = an average film · 70 good · 80+ great. Right column = weight used.');
    if (!isSeries(info)) foot.append(' ', link(`https://letterboxd.com/imdb/${info.id}/`, 'Letterboxd ↗'));
    kids.push(foot);
    if (r && r.imdbFile) kids.push(el('div', { className: 'sr-foot', textContent: IMDB_CREDIT }));
    pop.replaceChildren(...kids);
  }

  // The side (below or above the score) is picked once per open and kept, so nothing flips the box
  // (the MUBI lesson of 7 Nov 2026). Above, it hangs by its bottom edge.
  function placePop() {
    if (!popOwner) return;
    if (!popOwner.isConnected) return closePop();
    const b = popOwner.getBoundingClientRect();
    if (!b.width || b.bottom < 0 || b.top > innerHeight) return closePop();
    const p = pop.getBoundingClientRect();
    let left = b.right - p.width; // tiles: hang left from a top-right badge
    if (left < 8) left = b.left; // the title row: the score sits at the left, so start there
    left = Math.max(8, Math.min(left, innerWidth - p.width - 8));
    if (!popSide) {
      const below = innerHeight - 8 - (b.bottom + 6), above = b.top - 6 - 8;
      popSide = p.height <= below || below >= above ? 'below' : 'above';
    }
    pop.style.left = left + 'px';
    if (popSide === 'below') { pop.style.top = (b.bottom + 6) + 'px'; pop.style.bottom = 'auto'; }
    else { pop.style.top = 'auto'; pop.style.bottom = (innerHeight - b.top + 6) + 'px'; }
  }
  function openPop(btn, info) {
    closePop();
    fillPop(info);
    popOwner = btn; popSide = null; btn.setAttribute('aria-expanded', 'true');
    pop.hidden = false; placePop();
  }
  function closePop() {
    if (!popOwner) return;
    popOwner.setAttribute('aria-expanded', 'false');
    popOwner = null; pop.hidden = true;
  }
  document.addEventListener('click', e => { if (popOwner && !pop.contains(e.target) && !popOwner.contains(e.target)) closePop(); }, true);
  // Capture on window, ahead of Stremio's own shortcuts, so Esc closes the box and nothing else.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !popOwner) return;
    const b = popOwner; closePop(); b.focus({ preventScroll: true });
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  let rafPending = false;
  const onMove = () => { if (popOwner && !rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; placePop(); }); } };
  addEventListener('scroll', onMove, { capture: true, passive: true });
  addEventListener('resize', onMove, { passive: true });

  function scoreButton(info, big = false) {
    const none = info.score == null;
    const b = el('button', {
      type: 'button', className: `sr-score${big ? ' sr-big' : ''}${none ? ' sr-none' : ''}`, tabIndex: 0,
      title: none ? MSG[info.status]() + ' Click for links.' : 'Blended rating — click for the breakdown',
      'aria-label': none ? 'No rating yet — show why' : `Rating ${info.score} of 100 — show the breakdown`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    });
    b.dataset.srId = info.id;
    b.append(...scoreFace(info.score));
    // A click on a tile's score must neither open the title nor select it in Discover.
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (popOwner === b) closePop(); else openPop(b, info); });
    for (const t of ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'touchstart', 'dblclick', 'keydown', 'keyup']) {
      b.addEventListener(t, e => { if (!/key/.test(t) || e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    }
    return b;
  }

  // ---------- tiles ----------
  function idOf(href) {
    const m = String(href || '').match(DETAIL);
    return m ? { type: m[1].toLowerCase(), id: m[2].toLowerCase() } : null;
  }
  const posterOf = a => a.querySelector('[class*="poster-container"]');
  const ours = e => !!e.closest('#sr-pop, .sr-badge, .sr-row-item, .sr-keybox');
  const inPreview = e => !!e.closest('[class*="meta-preview"]');

  async function renderTile(a, id, type) {
    const live = () => a.isConnected && a.dataset.srId === id;
    try {
      const info = await ratingsFor(id, type);
      if (!live() || (info.score == null && !QUIET.has(info.status))) { if (live()) a.dataset.sr = 'none'; return; }
      const host_ = posterOf(a) || a;
      host_.querySelectorAll(':scope > .sr-badge').forEach(x => x.remove()); // never two
      if (getComputedStyle(host_).position === 'static') host_.style.position = 'relative';
      const badge = el('span', { className: 'sr-badge' }, scoreButton(info));
      badge.dataset.srId = id;
      if (host_.querySelector(':scope > [class*="new-videos"]')) badge.classList.add('sr-low');
      host_.append(badge);
      a.dataset.sr = 'shown';
    } catch (e) { console.debug(TAG, id, e.message); }
  }

  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const a = en.target; const { width: w, height: h } = en.boundingClientRect;
      if (!w || !h) continue; // a hidden route or slide: keep waiting
      io.unobserve(a);
      if (w < TILE.minW || w > TILE.maxW || h < TILE.minH) { a.dataset.sr = 'skip'; continue; }
      a.dataset.sr = 'done'; // → 'shown' once the score is on the page
      renderTile(a, a.dataset.srId, a.dataset.srType);
    }
  }, { rootMargin: '300px' });

  function scanTiles() {
    for (const a of document.querySelectorAll('a[href*="#/detail/"]')) {
      if (ours(a) || inPreview(a) || !posterOf(a)) continue; // the panel's Show button, an episode row
      const got = idOf(a.getAttribute('href'));
      if (!got) continue; // not an IMDb title (a channel, an addon's own ID)
      if (a.dataset.srId !== got.id) {
        // React reused this tile for another title: drop the old score, look the new one up.
        (posterOf(a) || a).querySelectorAll(':scope > .sr-badge').forEach(x => x.remove());
        a.dataset.srId = got.id; a.dataset.srType = got.type; a.dataset.sr = 'wait';
        io.unobserve(a); io.observe(a);
      } else if (a.dataset.sr === 'wait') {
        io.unobserve(a); io.observe(a); // re-check: a route may have become visible
      } else if (a.dataset.sr === 'shown' && !(posterOf(a) || a).querySelector(':scope > .sr-badge')) {
        a.dataset.sr = 'wait'; io.observe(a); // Stremio re-drew the poster and dropped the score: put it back
      }
    }
  }

  // ---------- Discover's right panel and the detail page ----------
  function previewId(row) {
    const box = row.closest('[class*="meta-preview"]') || row.parentElement;
    const imdbBtn = box && box.querySelector('a[href*="imdb.com"]');
    if (imdbBtn) {
      let h = imdbBtn.getAttribute('href') || '';
      try { h = decodeURIComponent(h); } catch (_) { /* keep raw */ }
      const m = h.match(/imdb\.com\/title\/(tt\d{5,10})/i);
      if (m) {
        const show = box.querySelector('a[href*="#/detail/"]');
        const typed = show && idOf(show.getAttribute('href'));
        const here = idOf(location.hash);
        return { id: m[1].toLowerCase(), type: (typed && typed.type) || (here && here.type) || '' };
      }
    }
    const show = box && box.querySelector('a[href*="#/detail/"]');
    return (show && idOf(show.getAttribute('href'))) || (/^#\/detail\//.test(location.hash) ? idOf(location.hash) : null);
  }

  function keyForm(msg, rejected) {
    const input = el('input', { type: 'text', placeholder: rejected ? 'or paste a new key' : 'OMDb key', autocomplete: 'off', spellcheck: false, 'aria-label': 'OMDb API key' });
    const err = note('');
    const save = () => {
      const v = input.value.trim();
      const key = KEY_RE.test(v) ? v : (v.match(/\b(?=[a-z]*\d)[a-z0-9]{8}\b/i) || [])[0]; // a pasted line such as "Here is your key: 1a2b3c4d"
      if (!key) { input.classList.add('sr-bad'); err.textContent = 'That isn’t an OMDb key — paste just the 8-character key from OMDb’s email'; input.focus(); return; }
      host.saveKey(key); host.del('omdbBad');
      refreshAll();
    };
    for (const t of ['keydown', 'keyup', 'keypress']) input.addEventListener(t, e => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Enter') save(); });
    const kids = [note(msg)];
    if (rejected) kids.push(el('button', { type: 'button', className: 'sr-btn', textContent: 'Try again', onclick: () => { host.del('omdbBad'); refreshAll(); } }));
    else kids.push(el('a', { className: 'sr-btn', href: 'https://www.omdbapi.com/apikey.aspx', target: '_blank', rel: 'noopener noreferrer', textContent: 'Get a free key ↗' }));
    kids.push(input, el('button', { type: 'button', className: 'sr-btn sr-solid', textContent: 'Save', onclick: save }), err);
    const box = el('div', { className: 'sr-keybox' }, ...kids);
    for (const t of ['mousedown', 'pointerdown', 'click']) box.addEventListener(t, e => e.stopPropagation());
    return box;
  }

  async function fillRow(row, slot, id, type) {
    const live = () => slot.isConnected && slot.dataset.srId === id;
    const info = await ratingsFor(id, type);
    if (!live()) return;
    const kids = info.score != null || QUIET.has(info.status) ? [scoreButton(info, true)] : [];
    slot.replaceChildren(...kids);
    // The key box and plain notes go on the detail page only; Discover's narrow panel stays clean.
    const page = row.closest('[class*="meta-preview"]');
    const onDetail = /^#\/detail\//.test(location.hash) && !!idOf(location.hash) && idOf(location.hash).id === id;
    page && page.querySelectorAll('.sr-keybox').forEach(x => x.remove());
    if (!onDetail) return;
    let extra = null;
    if (info.status === 'nokey') extra = keyForm('IMDb · Rotten Tomatoes · Metacritic need a free OMDb key:', false);
    else if (info.status === 'badkey') extra = keyForm(`⚠️ Your key is saved, but OMDb says “${info.why}”. A new key only works after you click the activation link in OMDb’s email. Click it, then:`, true);
    else if (info.score == null) extra = el('div', { className: 'sr-keybox' }, note(MSG[info.status] ? MSG[info.status](info.why) : 'No IMDb, Rotten Tomatoes or Metacritic score yet.'));
    if (extra) { extra.dataset.srId = id; row.after(extra); }
  }

  function scanRows() {
    for (const row of document.querySelectorAll('[class*="runtime-release-info"]')) {
      if (!row.getClientRects().length) continue; // a hidden route keeps its DOM
      const got = previewId(row);
      let slot = row.querySelector(':scope > .sr-row-item');
      if (!got) { slot?.remove(); continue; }
      if (slot && slot.dataset.srId === got.id) continue;
      slot?.remove();
      slot = el('span', { className: 'sr-row-item' });
      slot.dataset.srId = got.id;
      row.append(slot);
      fillRow(row, slot, got.id, got.type).catch(e => console.debug(TAG, got.id, e.message));
    }
    // A key box left behind by a title that is no longer shown.
    for (const k of document.querySelectorAll('.sr-keybox')) {
      const row = k.previousElementSibling;
      const slot = row && row.querySelector(':scope > .sr-row-item');
      if (!slot || slot.dataset.srId !== k.dataset.srId) k.remove();
    }
  }

  // ---------- wiring ----------
  function refreshAll() {
    closePop();
    inflight.clear();
    document.querySelectorAll('.sr-badge, .sr-row-item, .sr-keybox').forEach(x => x.remove());
    for (const a of document.querySelectorAll('a[data-sr-id]')) { io.unobserve(a); delete a.dataset.srId; delete a.dataset.sr; delete a.dataset.srType; }
    scan();
  }
  function clearCache() {
    for (const k of host.list()) if (k.startsWith('c:')) host.del(k);
    refreshAll(); // today's OMDb count is kept: OMDb still counts those calls
  }

  let lastHash = location.hash;
  function scan() {
    if (location.hash !== lastHash) { lastHash = location.hash; closePop(); }
    scanTiles(); scanRows();
  }
  let timer = 0;
  new MutationObserver(muts => {
    if (muts.every(m => pop.contains(m.target))) return; // our own redraws
    clearTimeout(timer); timer = setTimeout(scan, 200);
  }).observe(document.body, { childList: true, subtree: true });
  addEventListener('hashchange', () => { clearTimeout(timer); timer = setTimeout(scan, 50); });
  scan();

  return { refreshAll, clearCache, blend, values, ratingsFor, SOURCES, OMDB_CAP };
}

// The Stremio Enhanced shell. SE pastes this file into web.stremio.com's page inside its own
// wrapper, which defines StremioEnhancedAPI; there are no GM_* functions here.
// - The key lives in SE's plugin settings (Settings → Plugins → the gear beside this plugin), which
//   SE keeps in stremio-ratings.plugin.json in its plugins folder, outside the page's storage.
// - The cache lives in the page's localStorage under "stremio-ratings:", capped at 1,500 entries so
//   it never crowds out Stremio's own data; a full store is pruned, never allowed to throw.
// - fetch() goes only to www.omdbapi.com (it answers with Access-Control-Allow-Origin: *) and, for
//   IMDb's daily ratings file, to datasets.imdbws.com (no key), with no cookies and no referrer.
(() => {
  'use strict';
  if (window.__stremioRatings) return; // SE re-runs a plugin toggled back on; one copy is enough
  window.__stremioRatings = true;
  const SE = typeof StremioEnhancedAPI !== 'undefined' ? StremioEnhancedAPI : null;
  const NS = 'stremio-ratings:';
  const MAX = 1500;
  const mem = new Map(); // used only if localStorage is unavailable
  const ls = (() => { try { const s = window.localStorage; s.getItem('x'); return s; } catch (_) { return null; } })();
  let key = '';

  function list() {
    if (!ls) return [...mem.keys()];
    const out = [];
    try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(NS)) out.push(k.slice(NS.length)); } } catch (_) { /* ignore */ }
    return out;
  }
  function dropExpired(share) {
    const t = Date.now(), cache = [];
    for (const k of list()) if (k.startsWith('c:')) { const v = host.get(k); if (!v || v.e <= t) host.del(k); else cache.push([k, v.e]); }
    if (share) cache.sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(cache.length * share)).forEach(([k]) => host.del(k));
  }
  const host = {
    maxEntries: MAX,
    keyHint: 'Settings → Plugins → the gear beside Stremio Ratings, or the box under any title on its own page',
    get(k, d = null) {
      if (!ls) return mem.has(k) ? mem.get(k) : d;
      try { const v = ls.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; }
    },
    set(k, v) {
      if (!ls) { mem.set(k, v); return; }
      const s = JSON.stringify(v);
      try { ls.setItem(NS + k, s); }
      catch (_) { // the origin's store is full: make room from our own cache, once, then give up quietly
        dropExpired(0.5);
        try { ls.setItem(NS + k, s); } catch (e) { console.debug('[stremio-ratings] not cached:', e.name); }
      }
    },
    del(k) { if (!ls) { mem.delete(k); return; } try { ls.removeItem(NS + k); } catch (_) { /* ignore */ } },
    list,
    getKey: () => key,
    saveKey(k) {
      key = k;
      if (SE) Promise.resolve(SE.saveSetting('omdb_key', k)).catch(e => console.debug('[stremio-ratings] key not saved:', e && e.message));
      else host.set('omdbKey', k);
    },
    // IMDb's daily ratings file. Its server sends no CORS header, but Stremio Enhanced 1.2.0 opens
    // its window with webSecurity: false (src/main.ts), so fetch() can read it there.
    async getBinary(url) {
      const r = await fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer' });
      return { status: r.status, body: r.ok ? await r.arrayBuffer() : null };
    },
    async request(url) {
      const r = await fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      let body = null; try { body = await r.json(); } catch (_) { /* not JSON */ }
      return { status: r.status, body };
    },
  };

  (async () => {
    if (SE) {
      // registerSettings rejects on a reload (the schema is still registered); that's fine.
      // SE's settings box puts each label beside its description, and Stremio's CSS clamps the
      // label to 2 lines, so a long description squeezed "OMDb API key" to "OM / Db…" (Kris,
      // 15 Nov 2026). Short labels and descriptions, the label kept to one line, and the key
      // masked: SE's schema has no password type (input · toggle · select, v1.2.0), so CSS does it.
      // The long help lives in the vault note "Stremio — ratings on tiles and title pages".
      try {
        await SE.registerSettings([
          { key: 'omdb_key', type: 'input', label: 'OMDb key', description: 'Free at omdbapi.com', defaultValue: '' },
          { key: 'clear_cache', type: 'toggle', label: 'Refresh', description: 'Look every title up again', defaultValue: false },
        ]);
      } catch (_) { /* already registered */ }
      const css = document.createElement('style');
      css.id = 'sr-se-settings';
      css.textContent = '[id$="-settings-modal"]:has([data-key="omdb_key"]) [class*="heading-"] > [class*="label-"]{flex:none;white-space:nowrap}'
        + ' .plugin-setting-input[data-key="omdb_key"]{-webkit-text-security:disc}';
      document.head.append(css);
      try { key = String((await SE.getSetting('omdb_key')) || '').trim(); } catch (_) { key = ''; }
    } else {
      key = String(host.get('omdbKey', '') || '').trim();
    }
    const app = stremioRatings(host);
    window.__stremioRatings = app;
    if (SE && typeof SE.onSettingsSaved === 'function') {
      SE.onSettingsSaved(cfg => {
        cfg = cfg || {};
        const k = String(cfg.omdb_key || '').trim();
        if (cfg.clear_cache === true || cfg.clear_cache === 'true') {
          Promise.resolve(SE.saveSetting('clear_cache', false)).catch(() => {});
          key = k; host.del('omdbBad'); app.clearCache();
        } else if (k !== key) {
          key = k; host.del('omdbBad'); app.refreshAll();
        }
      });
    }
  })().catch(e => console.error('[stremio-ratings] failed to start', e));
})();
})();
