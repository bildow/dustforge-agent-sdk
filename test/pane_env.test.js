'use strict';
// Pane-mailbox mode of the MCP server (#129 review H3, M1): a pane holds no password, has its own 0600 env file, and
// never reuses the legacy shared refresh token. Runs mcp-server.js against a tiny fake gateway; no network.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');

function run(env, calls) {
  return new Promise((resolve) => {
    const home = env.HOME;
    const p = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, results: out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) }));
    p.stdin.end(calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: c[0], arguments: c[1] || {} } })).join('\n') + '\n');
  });
}
const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcp-')); fs.mkdirSync(path.join(h, '.config')); return h; };
const textOf = (r) => r.results[0].result.content[0].text;

test('API mode refuses to start without a session name', async () => {
  const r = await run({ HOME: home(), DUSTFORGE_MAIL_VIA_API: '1' }, [['dustforge_mail_check']]);
  assert.equal(r.code, 2); assert.match(r.err, /needs DUSTFORGE_SESSION/);
});

test('API mode refuses to start while DUSTFORGE_PASSWORD is set, in the env or in the pane\'s env file', async () => {
  const h = home();
  let r = await run({ HOME: h, DUSTFORGE_MAIL_VIA_API: '1', DUSTFORGE_SESSION: 'p-one', DUSTFORGE_PASSWORD: 'x' }, [['dustforge_mail_check']]);
  assert.equal(r.code, 2); assert.match(r.err, /remove DUSTFORGE_PASSWORD/);
  fs.writeFileSync(path.join(h, '.config', 'dustforge-mcp.p-one.env'), 'DUSTFORGE_PASSWORD=x\n');
  r = await run({ HOME: h, DUSTFORGE_MAIL_VIA_API: '1', DUSTFORGE_SESSION: 'p-one' }, [['dustforge_mail_check']]);
  assert.equal(r.code, 2); assert.match(r.err, /remove DUSTFORGE_PASSWORD/);
});

test('the flag set only in the shared env file is refused (it belongs in the server\'s own env)', async () => {
  const h = home();
  fs.writeFileSync(path.join(h, '.config', 'dustforge-mcp.env'), 'DUSTFORGE_MAIL_VIA_API=1\nDUSTFORGE_PASSWORD=x\n');
  const r = await run({ HOME: h }, [['dustforge_mail_check']]);
  assert.equal(r.code, 2); assert.match(r.err, /own env instead/);
});

test('API mode never reuses the legacy refresh token, and never reads the shared env file', async () => {
  const h = home();
  fs.writeFileSync(path.join(h, '.config', 'dustforge-mcp.env'), 'DUSTFORGE_PASSWORD=from-shared-file\nDUSTFORGE_REFRESH_TOKEN=dpr_shared\n');
  const r = await run({ HOME: h, DUSTFORGE_MAIL_VIA_API: '1', DUSTFORGE_SESSION: 'p-two', DUSTFORGE_MAIL_NAME: 'claude', DUSTFORGE_REFRESH_TOKEN: 'dpr_legacy', DUSTFORGE_URL: 'http://127.0.0.1:1' }, [['dustforge_mail_check']]);
  assert.equal(r.code, 0, r.err);
  assert.match(textOf(r), /No valid refresh token for this pane/);
});

test('each pane keeps its own 0600 env file with its own token; a gateway without the routes is said plainly', async () => {
  const h = home();
  const shared = path.join(h, '.config', 'dustforge-mcp.env');
  fs.writeFileSync(shared, 'DUSTFORGE_REFRESH_TOKEN=dpr_shared\n', { mode: 0o644 });
  const paneFile = path.join(h, '.config', 'dustforge-mcp.p-three.env');
  fs.writeFileSync(paneFile, 'DUSTFORGE_PANE_REFRESH_TOKEN=dpr_pane_1\n', { mode: 0o644 });
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      seen.push(req.method + ' ' + req.url + ' ' + b);
      if (req.url === '/api/identity/refresh') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ token: 'a.b.c', did: 'did:key:x', refresh_token: 'dpr_pane_2' })); }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<pre>Cannot GET</pre>');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const r = await run({ HOME: h, DUSTFORGE_MAIL_VIA_API: '1', DUSTFORGE_SESSION: 'p-three', DUSTFORGE_MAIL_NAME: 'claude', DUSTFORGE_URL: `http://127.0.0.1:${srv.address().port}` }, [['dustforge_mail_check']]);
  srv.close();
  assert.match(textOf(r), /no pane-mail routes/);
  assert.ok(seen.some((s) => s.includes('dpr_pane_1')), 'the pane\'s own token was used');
  assert.ok(!seen.some((s) => s.includes('dpr_shared')), 'the shared token was not');
  assert.match(fs.readFileSync(paneFile, 'utf8'), /^DUSTFORGE_PANE_REFRESH_TOKEN=dpr_pane_2$/m);
  assert.equal(fs.statSync(paneFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'DUSTFORGE_REFRESH_TOKEN=dpr_shared\n');
});
