// The Stremio Enhanced shell. SE pastes this file into web.stremio.com's page inside its own
// wrapper, which defines StremioEnhancedAPI; there are no GM_* functions here.
// - The key lives in SE's plugin settings (Settings → Plugins → the gear beside this plugin), which
//   SE keeps in stremio-ratings.plugin.json in its plugins folder, outside the page's storage.
// - The cache lives in the page's localStorage under "stremio-ratings:", capped at 1,500 entries so
//   it never crowds out Stremio's own data; a full store is pruned, never allowed to throw.
// - fetch() goes only to www.omdbapi.com (it answers with Access-Control-Allow-Origin: *), with no
//   cookies and no referrer.
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
    async request(url) {
      const r = await fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      let body = null; try { body = await r.json(); } catch (_) { /* not JSON */ }
      return { status: r.status, body };
    },
  };

  (async () => {
    if (SE) {
      // registerSettings rejects on a reload (the schema is still registered); that's fine.
      try {
        await SE.registerSettings([
          { key: 'omdb_key', type: 'input', label: 'OMDb API key', description: 'Free at omdbapi.com/apikey.aspx (1,000 lookups a day, shared with the MUBI script; this plugin stops at 400). Click the activation link in OMDb’s email first.', defaultValue: '' },
          { key: 'clear_cache', type: 'toggle', label: 'Clear cached ratings', description: 'Switch on and close this box: every title is looked up again. It switches itself off.', defaultValue: false },
        ]);
      } catch (_) { /* already registered */ }
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
