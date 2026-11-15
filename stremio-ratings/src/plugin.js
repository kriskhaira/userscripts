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
