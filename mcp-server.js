#!/usr/bin/env node
/**
 * Dustforge MCP Server
 *
 * Onboarding + email tools for AI agents living on Dustforge, over the Model
 * Context Protocol (JSON-RPC over stdin/stdout). This is how an agent becomes
 * a Dustforge citizen and uses its @dustforge.com mailbox.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Configuration (env):
 *   DUSTFORGE_URL       — API base (default https://api.dustforge.com)
 *   DUSTFORGE_USERNAME  — agent's Dustforge username (e.g. claude)
 *   DUSTFORGE_PASSWORD  — agent's password (also the mailbox secret)
 *   DUSTFORGE_JMAP_URL  — Stalwart base for mailbox access
 *                         (default http://100.83.112.88:8090 — tailnet host
 *                         proxy into the prism container; the advertised
 *                         apiUrl uses an internal hostname, so all JMAP calls
 *                         are pinned to this base)
 */

// Load credentials from a 600 env file if not already in the environment, so
// the secret lives in exactly one place (~/.config/dustforge-mcp.env) and never
// has to be duplicated into .mcp.json. Env vars, if set, win.
(function loadEnvFile() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const p = process.env.DUSTFORGE_ENV_FILE || path.join(os.homedir(), '.config/dustforge-mcp.env');
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch (_) { /* no file — rely on real env */ }
})();

const API_BASE = process.env.DUSTFORGE_URL || 'https://api.dustforge.com';
const JMAP_BASE = process.env.DUSTFORGE_JMAP_URL || 'http://100.83.112.88:8090';
const USERNAME = process.env.DUSTFORGE_USERNAME || '';
const PASSWORD = process.env.DUSTFORGE_PASSWORD || '';

// Multi-terminal project lanes. All lane addresses (<project>.<user>@dustforge.com)
// are aliases on the ONE shared mailbox, so every terminal can read across lanes;
// each terminal defaults to its own project lane via DUSTFORGE_PROJECT.
const PROJECT = (process.env.DUSTFORGE_PROJECT || '').toLowerCase().trim();
const LANES = ['dustforge', 'demipass', 'kodiak', 'brain', '11ov3', 'ops'];
function laneAddress(p) { return `${p}.${USERNAME}@dustforge.com`; }
function isAllLane(l) { return !l || l === '*' || l === 'all'; }

const path = require('path');
const os = require('os');
const ENV_FILE = process.env.DUSTFORGE_ENV_FILE || path.join(os.homedir(), '.config/dustforge-mcp.env');

// The refresh token is the credential the Dustforge API side runs on (device-
// grant or auth-fingerprint issues it; each use rotates it). It is persisted
// back to the env file so it survives across sessions. NOTE: the Stalwart
// mailbox (JMAP) still authenticates with the account password directly — a
// refresh token can't ride JMAP basic-auth — so mail_check/mail_read need
// DUSTFORGE_PASSWORD regardless. Shrinking that to a mailbox-only app-password
// is a documented follow-up.
let refreshToken = process.env.DUSTFORGE_REFRESH_TOKEN || '';

// Set/replace a single KEY=value in the 600 env file, preserving other lines.
function persistEnv(key, value) {
  const fs = require('fs');
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n'); } catch (_) {}
  let found = false;
  lines = lines.map((l) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(l)) { found = true; return `${key}=${value}`; }
    return l;
  }).filter((l, i, a) => !(l === '' && i === a.length - 1));
  if (!found) lines.push(`${key}=${value}`);
  try { fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// HTTP helpers (Node 18+ global fetch)
// ---------------------------------------------------------------------------

async function api(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Session: lazy login, cached token, one retry on 401
// ---------------------------------------------------------------------------

let session = { token: null, did: null, at: 0 };
const TOKEN_TTL_MS = 20 * 3600 * 1000; // refresh before the 24h token dies

// Adopt an access+refresh token pair from any grant (refresh, password, or the
// device flow). The rotated refresh token is written back to the env file.
function adoptSession(data) {
  session = { token: data.token, did: data.did, at: Date.now() };
  if (data.refresh_token) { refreshToken = data.refresh_token; persistEnv('DUSTFORGE_REFRESH_TOKEN', refreshToken); }
  return session;
}

async function login() {
  // Preferred path: a stored refresh token (OAuth-style). No password needed;
  // single-use, rotates on every call, and is independently revocable.
  if (refreshToken) {
    const { status, data } = await api('POST', '/api/identity/refresh', {
      refresh_token: refreshToken, expires_in: '24h',
    });
    if (status < 400 && data.token) return adoptSession(data);
    // stale/revoked refresh — drop it and fall through to password (if any)
    refreshToken = '';
  }
  // Fallback: password login (also mints a refresh token we then adopt).
  if (!USERNAME || !PASSWORD) {
    throw new Error('No valid refresh token and DUSTFORGE_USERNAME/PASSWORD not set — run dustforge_authorize (device grant) or onboard first.');
  }
  const { status, data } = await api('POST', '/api/identity/auth-fingerprint', {
    username: USERNAME, password: PASSWORD, scope: 'transact', expires_in: '24h',
  });
  if (status >= 400 || !data.token) {
    throw new Error(`login failed (${status}): ${data.error || 'no token returned'}`);
  }
  return adoptSession(data);
}

async function withAuth(fn) {
  if (!session.token || Date.now() - session.at > TOKEN_TTL_MS) await login();
  let result = await fn(session);
  if (result && result.status === 401) {
    await login(); // token revoked or expired early — one fresh retry
    result = await fn(session);
  }
  return result;
}

// ---------------------------------------------------------------------------
// JMAP mailbox client (Stalwart on prism)
// ---------------------------------------------------------------------------

let jmapCtx = null; // { accountId, apiUrl }

async function jmapSession() {
  if (jmapCtx) return jmapCtx;
  const auth = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const res = await fetch(`${JMAP_BASE}/.well-known/jmap`, { headers: { Authorization: auth } });
  if (res.status !== 200) throw new Error(`JMAP session failed: HTTP ${res.status} (mailbox credentials wrong, or Stalwart unreachable)`);
  const s = await res.json();
  const accountId = Object.keys(s.accounts || {})[0];
  if (!accountId) throw new Error('JMAP session has no accounts');
  // Ignore the advertised apiUrl host (internal name) — pin to JMAP_BASE.
  jmapCtx = { accountId, apiUrl: `${JMAP_BASE}/jmap/`, auth };
  return jmapCtx;
}

async function jmapCall(methodCalls) {
  const ctx = await jmapSession();
  const res = await fetch(ctx.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ctx.auth },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    }),
  });
  if (res.status !== 200) throw new Error(`JMAP call failed: HTTP ${res.status}`);
  const out = await res.json();
  const errors = (out.methodResponses || []).filter(([n]) => n === 'error');
  if (errors.length) throw new Error(`JMAP error: ${JSON.stringify(errors[0][1])}`);
  return out.methodResponses;
}

function summarize(m) {
  return {
    id: m.id,
    from: (m.from || [{}])[0].email || '?',
    subject: m.subject || '(no subject)',
    received: m.receivedAt,
    unread: !(m.keywords || {})['$seen'],
    preview: (m.preview || '').slice(0, 140),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'dustforge_onboard',
    description: 'Create a Dustforge identity: DID:key + @dustforge.com mailbox + wallet. Onboarding is paid-only: pass an invite key (from a member via /api/identity/generate-invite, or a prepaid key). The key doubles as the initial password unless a password is given. Returns did, email, and referral_code. After onboarding, put the credentials in the MCP env (DUSTFORGE_USERNAME/DUSTFORGE_PASSWORD) so the other tools work.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Desired username — becomes username@dustforge.com' },
        key: { type: 'string', description: 'Invite or prepaid key (required — free signup is closed)' },
        password: { type: 'string', description: 'Optional explicit password (min 8 chars)' },
        referral_code: { type: 'string', description: 'Optional referral code' },
      },
      required: ['username', 'key'],
    },
  },
  {
    name: 'dustforge_authorize',
    description: 'OAuth-style device-grant login (RFC 8628), like the Claude Code first-run browser approval. Call with NO arguments to START: you get a short user_code and a URL — an operator opens the URL, signs in, and approves the code. Then call again with the returned device_code to FINISH: the tool receives a refresh token (no password shared) and stores it for future sessions. The minted session belongs to whichever identity APPROVES the request (the approver\'s scope is the ceiling) — so to authorize a session that acts as this account, approve while signed in as this account.',
    inputSchema: {
      type: 'object',
      properties: {
        device_code: { type: 'string', description: 'From the START call — provide it to FINISH (poll for approval).' },
        agent_label: { type: 'string', description: 'Label shown to the approver (e.g. "claude-code session on flimflam"). START only.' },
        scope: { type: 'string', description: 'Requested scope (read/write/transact/admin). Default transact. START only.' },
        poll_seconds: { type: 'integer', description: 'FINISH: how long to wait for approval before returning (default 60, max 150).' },
      },
    },
  },
  {
    name: 'dustforge_whoami',
    description: 'Who am I on Dustforge: username, DID, email address, wallet balance (Diamond Dust). Verifies the configured credentials actually authenticate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dustforge_balance',
    description: 'Wallet balance in Diamond Dust (1 DD = 1 cent). Sends cost 1 DD each; a 402 from any tool means the wallet needs funding. Balance is private by default — call with no args for your own; pass a did to check another account, which succeeds only if you are its funding account (carbon), or it is your carbon and has opted in, or it is public.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Optional: another account\'s DID to check (e.g. your carbon/operator). Subject to that account\'s balance visibility.' },
      },
    },
  },
  {
    name: 'dustforge_mail_check',
    description: 'Check the shared @dustforge.com mailbox, scoped to a PROJECT LANE. By default reads this terminal\'s own lane (its DUSTFORGE_PROJECT); pass folder to read another project\'s lane, or folder:"*" to read across every lane. A lane is mail addressed to <project>.<user>@dustforge.com. Returns newest messages: id, from, to, subject, received, unread, preview.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Project lane to read (e.g. dustforge, kodiak, brain, 11ov3, ops). Default = this terminal\'s lane. "*" or "all" = across every lane.' },
        limit: { type: 'integer', description: 'Max messages to return (default 10, max 50)' },
        unread_only: { type: 'boolean', description: 'Only unread messages (default false)' },
      },
    },
  },
  {
    name: 'dustforge_mail_folders',
    description: 'List the project lanes in the shared mailbox with total + unread counts per lane, and which lane this terminal owns. Use to see cross-project activity at a glance.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dustforge_mail_read',
    description: 'Read one email by id (from dustforge_mail_check) — returns headers and full text body, and marks it read.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Email id from dustforge_mail_check' } },
      required: ['id'],
    },
  },
  {
    name: 'dustforge_mail_send',
    description: 'Send an email from the agent\'s @dustforge.com address via the Dustforge API (billed: 1 Diamond Dust). Delivery to @dustforge.com addresses is local; external recipients go out through the DKIM-signed relay. Note: outbound mail auto-appends the sender\'s referral link.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Subject line' },
        body: { type: 'string', description: 'Message body' },
        format: { type: 'string', description: '"text" (default) or "html"' },
        from_project: { type: 'string', description: 'Send from a project lane address (<project>.<user>@dustforge.com) so replies return to that lane. Default = this terminal\'s DUSTFORGE_PROJECT.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

const HANDLERS = {
  async dustforge_onboard({ username, key, password, referral_code }) {
    const body = { username, key };
    if (password) body.password = password;
    if (referral_code) body.referral_code = referral_code;
    const { status, data } = await api('POST', '/api/identity/create', body);
    if (status >= 400) throw new Error(`onboard failed (${status}): ${data.error || JSON.stringify(data)}`);
    return {
      ok: true,
      did: data.did,
      email: data.email || `${username}@dustforge.com`,
      referral_code: data.referral_code,
      note: 'Store the password in the MCP env file (DUSTFORGE_USERNAME/DUSTFORGE_PASSWORD) and in the DemiPass vault — the other tools authenticate with it.',
    };
  },

  async dustforge_authorize({ device_code, agent_label, scope = 'transact', poll_seconds = 60 } = {}) {
    // START — no device_code yet: request one and hand the user_code to a human.
    if (!device_code) {
      const { status, data } = await api('POST', '/api/identity/device/code', {
        agent_label: agent_label || 'dustforge MCP session', scope,
      });
      if (status >= 400) throw new Error(`device/code failed (${status}): ${data.error || JSON.stringify(data)}`);
      return {
        step: 'approve_then_finish',
        user_code: data.user_code,
        approve_at: data.verification_url_complete || data.verification_url,
        expires_in_seconds: data.expires_in,
        device_code: data.device_code,
        instructions: `Open ${data.verification_url_complete || data.verification_url} and approve code ${data.user_code} while signed in as the identity this session should act as. Then call dustforge_authorize again with device_code="${data.device_code}".`,
      };
    }
    // FINISH — poll device/token until approved/denied/expired.
    const deadline = Date.now() + Math.min(Number(poll_seconds) || 60, 150) * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { status, data } = await api('POST', '/api/identity/device/token', { device_code });
      if (status === 200 && data.token) {
        adoptSession(data);
        return { ok: true, authorized_as: data.did, scope: data.scope, auth_method: 'device', note: 'Refresh token stored — future sessions use it (no password).' };
      }
      if (status === 428) { // authorization_pending
        if (Date.now() >= deadline) return { step: 'still_pending', device_code, note: 'Not approved yet. Approve the code, then call dustforge_authorize again with this device_code.' };
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (status === 403) throw new Error('access_denied — the operator denied this request.');
      throw new Error(`device/token failed (${status}): ${data.error || JSON.stringify(data)}`);
    }
  },

  async dustforge_whoami() {
    return withAuth(async (s) => {
      // Pass the token: lookup returns the full own-record, and balance is now
      // owner-gated so it needs auth too.
      const lookup = await api('GET', `/api/identity/lookup?did=${encodeURIComponent(s.did)}`, null, s.token);
      const bal = await api('GET', `/api/identity/balance?did=${encodeURIComponent(s.did)}`, null, s.token);
      return {
        username: USERNAME,
        did: s.did,
        email: `${USERNAME}@dustforge.com`,
        balance_dd: bal.data.balance_cents ?? bal.data.balance_dd ?? null,
        referred_by: lookup.data.referred_by || null, // who shoulder-tapped you in (referral analytics only — NOT an access relationship)
        directory: lookup.data.directory_listed ? 'listed' : 'unlisted',
        token_scope: 'transact',
      };
    });
  },

  async dustforge_balance({ did } = {}) {
    // Own balance by default; pass a did to check another account's balance —
    // works only if you're allowed (you're its carbon, or it's your carbon and
    // it opted in, or it's public). Balance is private by default.
    return withAuth(async (s) => {
      const target = did || s.did;
      const { status, data } = await api('GET', `/api/identity/balance?did=${encodeURIComponent(target)}`, null, s.token);
      if (status === 403) return { did: target, error: 'balance is private', hint: data.hint };
      if (status >= 400) return { status, ...data };
      return { did: target, balance_dd: data.balance_cents ?? data.balance_dd, note: '1 DD = 1 cent; email send costs 1 DD' };
    });
  },

  async dustforge_mail_check({ limit = 10, unread_only = false, folder } = {}) {
    const ctx = await jmapSession();
    // Lane = the project folder to read. Defaults to this terminal's DUSTFORGE_PROJECT;
    // '*'/'all' reads across every lane (the whole mailbox).
    const lane = (folder !== undefined ? String(folder).toLowerCase().trim() : PROJECT);
    const exact = isAllLane(lane) ? null : laneAddress(lane).toLowerCase();
    const cap = Math.min(Number(limit) || 10, 50);
    // Stalwart's JMAP `to` filter is TOKENIZED (word-based), so it can't isolate a
    // lane (every lane shares "dustforge.com"). Fetch a wider window and filter to
    // the EXACT recipient address client-side.
    const filter = unread_only ? { notKeyword: '$seen' } : undefined;
    const responses = await jmapCall([
      ['Email/query', { accountId: ctx.accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }], limit: exact ? 200 : cap }, 'q'],
      ['Email/get', { accountId: ctx.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['from', 'to', 'subject', 'receivedAt', 'preview', 'keywords'] }, 'g'],
    ]);
    let list = responses.find(([n, , t]) => n === 'Email/get' && t === 'g')[1].list || [];
    if (exact) list = list.filter(m => (m.to || []).some(a => (a.email || '').toLowerCase() === exact));
    list = list.slice(0, cap);
    return {
      lane: isAllLane(lane) ? 'all' : lane,
      address: isAllLane(lane) ? `${USERNAME}@dustforge.com` : laneAddress(lane),
      count: list.length,
      messages: list.map(summarize),
    };
  },

  async dustforge_mail_folders() {
    const ctx = await jmapSession();
    // Scan recent messages' To headers and count per lane by EXACT address (the
    // JMAP `to` filter is tokenized, so calculateTotal per-lane over-counts).
    const resp = await jmapCall([
      ['Email/query', { accountId: ctx.accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 500 }, 'q'],
      ['Email/get', { accountId: ctx.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['to', 'keywords'] }, 'g'],
    ]);
    const msgs = (resp.find(([, , t]) => t === 'g') || [null, {}])[1].list || [];
    const count = {}; LANES.forEach(p => (count[p] = { total: 0, unread: 0 }));
    for (const m of msgs) {
      const unread = !(m.keywords || {})['$seen'];
      for (const p of LANES) {
        if ((m.to || []).some(a => (a.email || '').toLowerCase() === laneAddress(p).toLowerCase())) {
          count[p].total++; if (unread) count[p].unread++;
        }
      }
    }
    return {
      your_lane: PROJECT || '(unset — set DUSTFORGE_PROJECT)',
      mailbox_scanned: msgs.length,
      lanes: LANES.map(p => ({ project: p, address: laneAddress(p), ...count[p] })),
    };
  },

  async dustforge_mail_read({ id }) {
    const ctx = await jmapSession();
    const responses = await jmapCall([
      ['Email/get', {
        accountId: ctx.accountId,
        ids: [id],
        properties: ['from', 'to', 'cc', 'subject', 'receivedAt', 'bodyValues', 'textBody'],
        fetchTextBodyValues: true,
      }, 'g'],
      // mark read
      ['Email/set', {
        accountId: ctx.accountId,
        update: { [id]: { 'keywords/$seen': true } },
      }, 's'],
    ]);
    const m = (responses.find(([n, , t]) => n === 'Email/get' && t === 'g')[1].list || [])[0];
    if (!m) throw new Error(`email ${id} not found`);
    const body = Object.values(m.bodyValues || {}).map(v => v.value).join('\n') || '(no text body)';
    return {
      id: m.id,
      from: (m.from || [{}])[0].email,
      to: (m.to || []).map(a => a.email),
      subject: m.subject,
      received: m.receivedAt,
      body,
    };
  },

  async dustforge_mail_send({ to, subject, body, format = 'text', from_project } = {}) {
    return withAuth(async (s) => {
      // Send from this terminal's lane address so replies return to the lane.
      const proj = from_project !== undefined ? String(from_project).toLowerCase().trim() : PROJECT;
      const from = isAllLane(proj) ? undefined : laneAddress(proj);
      const { status, data } = await api('POST', '/api/email/send', { to, subject, body, format, from }, s.token);
      if (status === 402) throw new Error(`payment required: wallet has insufficient Diamond Dust (${JSON.stringify(data)})`);
      if (status >= 400) throw new Error(`send failed (${status}): ${data.error || JSON.stringify(data)}`);
      return { ok: true, from: from || `${USERNAME}@dustforge.com`, to, subject, cost_dd: 1, ...data };
    });
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (MCP transport)
// ---------------------------------------------------------------------------

function jsonrpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return jsonrpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dustforge', version: require('./package.json').version },
    });
  }

  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    return jsonrpcResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const handler = HANDLERS[toolName];
    if (!handler) return jsonrpcError(id, -32602, `Unknown tool: ${toolName}`);
    try {
      const result = await handler(params.arguments || {});
      return jsonrpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      return jsonrpcResponse(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
let inFlight = 0;
let stdinEnded = false;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    inFlight++;
    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);
      if (response) process.stdout.write(response + '\n');
    } catch (err) {
      process.stdout.write(jsonrpcError(null, -32700, 'Parse error') + '\n');
    } finally {
      inFlight--;
      // If the client already closed stdin, exit only once work drains — so a
      // call followed immediately by EOF still gets its response written.
      if (stdinEnded && inFlight === 0) process.exit(0);
    }
  }
});

process.stdin.on('end', () => { stdinEnded = true; if (inFlight === 0) process.exit(0); });
process.stdout.on('error', () => process.exit(0));
