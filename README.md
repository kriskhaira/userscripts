# userscripts

[Violentmonkey](https://violentmonkey.github.io/) user scripts.

| Script | Site | Install |
|---|---|---|
| Instagram — DM tab titles. A DM tab reads *Name (@handle) • DM* instead of *Instagram • Messages* | instagram.com | [instagram-dm-titles.user.js](https://raw.githubusercontent.com/kriskhaira/userscripts/main/instagram-dm-titles.user.js) |
| WhatsApp Web — focus the search box after Cmd+F. When *Search messages* opens (⌘⇧F), the cursor goes into its search box | web.whatsapp.com | [whatsapp-search-focus.user.js](https://raw.githubusercontent.com/kriskhaira/userscripts/main/whatsapp-search-focus.user.js) |
| MUBI — one rating per film. A critic-weighted blend (60 = an average film; Metacritic 35 %, Rotten Tomatoes 20 %, MUBI critics 10 %, MUBI members 20 %, IMDb 15 %) on every poster tile, the big top film and film pages, in MUBI's own black-and-white style; click it for the breakdown, a one-line verdict, a critic quote and links. **★ Ranked** (beside MUBI's search icon) lists every film you can watch in your country, best first, filtered by score and genre. IMDb · RT · Metacritic need a free [OMDb key](https://www.omdbapi.com/apikey.aspx), pasted once into the box under any film's title | mubi.com | [mubi-ratings.user.js](https://raw.githubusercontent.com/kriskhaira/userscripts/main/mubi-ratings.user.js) |
| Stremio — one rating per film or series. The same critic-weighted blend as MUBI's, without MUBI's own sources (60 = an average film; Metacritic 42 %, Rotten Tomatoes 23 %, IMDb 35 %), on poster tiles (Board, Discover, Search, Library), Discover's side panel and every title page, in Stremio's own white-on-dark style; click it for the breakdown, a one-line verdict and links. Series usually get IMDb only, because OMDb carries no RT or Metacritic for them, and the breakdown says so. Needs a free [OMDb key](https://www.omdbapi.com/apikey.aspx), pasted once into the box under any title. **Two builds from one source** (`stremio-ratings/`): a userscript for web.stremio.com, and a [Stremio Enhanced](https://github.com/REVENGE977/stremio-enhanced) plugin | web.stremio.com · Stremio Enhanced | [stremio-ratings.user.js](https://raw.githubusercontent.com/kriskhaira/userscripts/main/stremio-ratings.user.js) · [stremio-ratings.plugin.js](https://raw.githubusercontent.com/kriskhaira/userscripts/main/stremio-ratings.plugin.js) |
| Instagram — one control bar on the video in view: timeline scrubber, 0.5× / 1× / 2×, mirror (flip left–right), reverse, frame step. Keys: Space · `,` `.` frame · ← → 2 s · M mirror · R reverse · 1 2 3 speed | www.instagram.com | [instagram-video-controls.user.js](https://raw.githubusercontent.com/kriskhaira/userscripts/main/instagram-video-controls.user.js) |

Open the install link with Violentmonkey installed and click **Install**. Violentmonkey checks for updates on its own. Bump `@version` on every edit.

## Stremio ratings — one source, two builds

`stremio-ratings/src/core.js` holds everything; `src/userscript.js` (Violentmonkey storage, `GM_xmlhttpRequest`) and `src/plugin.js` (Stremio Enhanced's plugin settings, `localStorage`, `fetch`) wrap it. The two installable files at the top of the repo are built, and committed because the raw links install them:

```sh
node stremio-ratings/build.mjs                      # after editing src/ and bumping VERSION in build.mjs
node stremio-ratings/test/test-stremio-ratings.mjs  # headless Chrome on the live web.stremio.com, OMDb mocked, ~4 min
```

Stremio Enhanced install: copy `stremio-ratings.plugin.js` into its plugins folder (Settings → *Open plugins folder*), reload, tick it under Settings → Plugins, then paste the OMDb key under its gear.
