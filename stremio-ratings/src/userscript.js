// The Violentmonkey shell: Violentmonkey's own storage (no page script can read the key) and
// GM_xmlhttpRequest, which @connect limits to www.omdbapi.com.
(() => {
  'use strict';
  const host = {
    keyHint: 'Violentmonkey icon → this script → Set OMDb key…, or the box under any title on its own page',
    get: (k, d = null) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v),
    del: k => GM_deleteValue(k),
    list: () => GM_listValues(),
    getKey: () => String(GM_getValue('omdbKey', '') || '').trim(),
    saveKey: k => GM_setValue('omdbKey', k),
    request: url => new Promise((resolve, reject) => {
      const bare = url.split('?')[0]; // never log the query: it holds the OMDb key
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 15000, anonymous: true,
        onload: r => { let body = null; try { body = JSON.parse(r.responseText); } catch (_) { /* not JSON */ } resolve({ status: r.status, body }); },
        onerror: () => reject(new Error('network error: ' + bare)),
        ontimeout: () => reject(new Error('timeout: ' + bare)),
      });
    }),
  };
  const app = stremioRatings(host);
  GM_registerMenuCommand('Set OMDb key…', () => {
    const v = prompt('Paste your OMDb API key (8 letters or digits). Free key: omdbapi.com/apikey.aspx', '');
    if (v == null) return;
    if (!/^[a-z0-9]{8}$/i.test(v.trim())) { alert('That doesn’t look like an OMDb key (8 letters or digits).'); return; }
    GM_setValue('omdbKey', v.trim()); GM_deleteValue('omdbBad');
    app.refreshAll();
  });
  GM_registerMenuCommand('Clear cached ratings', () => app.clearCache());
})();
