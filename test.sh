#!/bin/sh
# Smoke test for every userscript in this repo: fast, offline, no browser.
#   1. each *.user.js / *.plugin.js parses (node --check)
#   2. each *.user.js has a ==UserScript== block with @name, @namespace and @version
#      (a missing @namespace or a changed @name makes Violentmonkey install a second copy)
#   3. the Stremio builds match their source (stremio-ratings/build.mjs --check)
# The live end-to-end Stremio test (headless Chrome on web.stremio.com, OMDb mocked) runs only with
# STREMIO_E2E=1, because it needs the network and Chrome.
# Run: sh test.sh   · exit 0 = all passed
cd "$(dirname "$0")" || exit 1
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1"; }

for f in *.user.js *.plugin.js; do
  [ -f "$f" ] || continue
  if node --check "$f" 2>/dev/null; then ok "$f parses"; else bad "$f does not parse"; fi
done

for f in *.user.js; do
  [ -f "$f" ] || continue
  head=$(sed -n '/==UserScript==/,/==\/UserScript==/p' "$f")
  missing=""
  for k in @name @namespace @version; do
    printf '%s\n' "$head" | grep -q "^// $k " || missing="$missing $k"
  done
  if [ -z "$missing" ]; then ok "$f header complete"; else bad "$f header lacks$missing"; fi
done

if node stremio-ratings/build.mjs --check >/dev/null; then ok "stremio-ratings builds match src/"
else bad "stremio-ratings builds are stale — run node stremio-ratings/build.mjs"; fi

if [ "${STREMIO_E2E:-}" = "1" ]; then
  if node stremio-ratings/test/test-stremio-ratings.mjs; then ok "stremio-ratings end-to-end"
  else bad "stremio-ratings end-to-end"; fi
fi

echo "ℹ pass $pass"
echo "ℹ fail $fail"
[ "$fail" -eq 0 ]
