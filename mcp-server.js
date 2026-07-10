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

async function login() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('DUSTFORGE_USERNAME / DUSTFORGE_PASSWORD not configured — onboard first (dustforge_onboard), then set the env file.');
  }
  const { status, data } = await api('POST', '/api/identity/auth-fingerprint', {
    username: USERNAME, password: PASSWORD, scope: 'transact', expires_in: '24h',
  });
  if (status >= 400 || !data.token) {
    throw new Error(`login failed (${status}): ${data.error || 'no token returned'}`);
  }
  session = { token: data.token, did: data.did, at: Date.now() };
  return session;
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
    name: 'dustforge_whoami',
    description: 'Who am I on Dustforge: username, DID, email address, wallet balance (Diamond Dust). Verifies the configured credentials actually authenticate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dustforge_balance',
    description: 'Wallet balance in Diamond Dust (1 DD = 1 cent). Sends cost 1 DD each; a 402 from any tool means the wallet needs funding.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dustforge_mail_check',
    description: 'Check the agent\'s @dustforge.com inbox. Returns newest messages: id, from, subject, received, unread, preview. Use dustforge_mail_read with an id for the full body.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max messages to return (default 10, max 50)' },
        unread_only: { type: 'boolean', description: 'Only unread messages (default false)' },
      },
    },
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

  async dustforge_whoami() {
    return withAuth(async (s) => {
      const lookup = await api('GET', `/api/identity/lookup?did=${encodeURIComponent(s.did)}`);
      const bal = await api('GET', `/api/identity/balance?did=${encodeURIComponent(s.did)}`);
      return {
        username: USERNAME,
        did: s.did,
        email: `${USERNAME}@dustforge.com`,
        balance_dd: bal.data.balance_cents ?? bal.data.balance_dd ?? null,
        directory: lookup.data.username ? 'listed' : 'unlisted',
        token_scope: 'transact',
      };
    });
  },

  async dustforge_balance() {
    return withAuth(async (s) => {
      const { status, data } = await api('GET', `/api/identity/balance?did=${encodeURIComponent(s.did)}`);
      if (status >= 400) return { status, ...data };
      return { balance_dd: data.balance_cents ?? data.balance_dd, note: '1 DD = 1 cent; email send costs 1 DD' };
    });
  },

  async dustforge_mail_check({ limit = 10, unread_only = false } = {}) {
    const ctx = await jmapSession();
    const filter = unread_only ? { notKeyword: '$seen' } : undefined;
    const responses = await jmapCall([
      ['Email/query', {
        accountId: ctx.accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: Math.min(Number(limit) || 10, 50),
      }, 'q'],
      ['Email/get', {
        accountId: ctx.accountId,
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['from', 'subject', 'receivedAt', 'preview', 'keywords'],
      }, 'g'],
    ]);
    const list = responses.find(([n, , t]) => n === 'Email/get' && t === 'g')[1].list || [];
    return { address: `${USERNAME}@dustforge.com`, count: list.length, messages: list.map(summarize) };
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

  async dustforge_mail_send({ to, subject, body, format = 'text' }) {
    return withAuth(async (s) => {
      const { status, data } = await api('POST', '/api/email/send', { to, subject, body, format }, s.token);
      if (status === 402) throw new Error(`payment required: wallet has insufficient Diamond Dust (${JSON.stringify(data)})`);
      if (status >= 400) throw new Error(`send failed (${status}): ${data.error || JSON.stringify(data)}`);
      return { ok: true, to, subject, cost_dd: 1, ...data };
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
