// Minimal Chrome DevTools Protocol driver: headless Chrome in a throwaway profile, no npm packages
// (Node >= 22 has WebSocket built in). Never touches Kris's own Chrome or its profile.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ width = 1500, height = 900, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-chrome-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  // The profile is thrown away, but the HTTP cache is shared between runs: Stremio's core is a
  // multi-MB WebAssembly file, and its CDN was serving it at ~7 KB/s on 15 Nov 2026.
  const cache = join(tmpdir(), 'stremio-ratings-chrome-cache');
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--disk-cache-dir=${cache}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--window-size=${width},${height}`, ...args, 'about:blank',
  ], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 80; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (ver.length) break; } catch (_) { /* not up yet */ }
    await sleep(150);
  }
  if (!ver || !ver.length) { proc.kill(); throw new Error('Chrome did not start'); }
  const page = ver.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const waits = new Map(); const handlers = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result); }
    else if (m.method) for (const h of handlers.get(m.method) || []) h(m.params);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => { const i = ++id; waits.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); });
  const on = (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const close = async () => { try { ws.close(); } catch (_) {} proc.kill(); await sleep(300); try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} };
  return { send, on, evaluate, close, width, height };
}

export async function waitFor(b, expr, timeout = 20000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await b.evaluate(expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for: ' + expr.slice(0, 120));
    await sleep(every);
  }
}
