import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normaliseClaude, createClaudeProvider } from '../lib/claude.js';
import { normaliseCodex, createCodexProvider } from '../lib/codex.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const handler = routes[url];
    if (!handler) return new Response('not found', { status: 404 });
    const { status = 200, body } = handler(opts, calls);
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

test('normaliseClaude maps known windows and skips nulls and disabled extras', () => {
  const w = normaliseClaude({
    five_hour: { utilization: 42.5, resets_at: '2026-10-05T15:00:00+00:00' },
    seven_day: { utilization: 10, resets_at: '2026-10-09T09:00:00+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: null },
    extra_usage: { is_enabled: false, utilization: null },
    something_new: { utilization: 7, resets_at: null },
  });
  assert.deepEqual(w.map((x) => x.key), ['five_hour', 'seven_day', 'seven_day_sonnet', 'something_new']);
  assert.equal(w[0].label, '5-hour session');
  assert.equal(w[0].windowSeconds, 18000);
  assert.equal(w[1].windowSeconds, 604800);
  assert.equal(w[3].label, 'Something new');
  assert.equal(w[0].resetsAt, '2026-10-05T15:00:00.000Z');
});

test('normaliseCodex reads primary/secondary windows, plan and credits', () => {
  const r = normaliseCodex({
    plan_type: 'plus',
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1791200000 },
      secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_after_seconds: 3600 },
    },
    code_review_rate_limit: null,
    credits: { has_credits: false, unlimited: false, balance: null },
  });
  assert.equal(r.plan, 'Plus');
  assert.deepEqual(r.windows.map((w) => w.label), ['5-hour session', 'Weekly']);
  assert.equal(r.windows[0].resetsAt, new Date(1791200000 * 1000).toISOString());
  assert.ok(r.windows[1].resetsAt);
  assert.deepEqual(r.notes, []);
});

test('Claude provider renews an expired login and saves it back without losing other fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-'));
  const file = join(dir, '.credentials.json');
  await writeFile(file, JSON.stringify({
    claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', scopes: ['user:inference'] },
    otherKey: 'keep me',
  }));
  const calls = mockFetch({
    'https://platform.claude.com/v1/oauth/token': () => ({ body: { access_token: 'new', refresh_token: 'r2', expires_in: 28800 } }),
    'https://api.anthropic.com/api/oauth/usage': (opts) => {
      assert.equal(opts.headers.authorization, 'Bearer new');
      return { body: { five_hour: { utilization: 12, resets_at: '2026-10-05T15:00:00Z' } } };
    },
  });

  const result = await createClaudeProvider({ dir, allowRefresh: true }).fetch();
  assert.equal(result.plan, 'Max 20x');
  assert.equal(result.windows[0].usedPercent, 12);
  assert.equal(calls.length, 2);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.otherKey, 'keep me');
  assert.equal(saved.claudeAiOauth.accessToken, 'new');
  assert.equal(saved.claudeAiOauth.refreshToken, 'r2');
  assert.deepEqual(saved.claudeAiOauth.scopes, ['user:inference']);
  assert.ok(saved.claudeAiOauth.expiresAt > Date.now());
});

test('Claude provider with renewal switched off reports expiry instead of touching the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-'));
  await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 } }));
  mockFetch({});
  await assert.rejects(createClaudeProvider({ dir, allowRefresh: false }).fetch(), /expired/);
});

test('Codex provider retries once with a renewed token after a 401', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-'));
  const file = join(dir, 'auth.json');
  const valid = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await writeFile(file, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { access_token: valid, refresh_token: 'r1', id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1' } }) },
  }));
  let usageCalls = 0;
  mockFetch({
    'https://chatgpt.com/backend-api/wham/usage': (opts) => {
      usageCalls++;
      assert.equal(opts.headers['chatgpt-account-id'], 'acc_1');
      return usageCalls === 1
        ? { status: 401, body: { error: 'expired' } }
        : { body: { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 100 } } } };
    },
    'https://auth.openai.com/oauth/token': () => ({ body: { access_token: 'fresh', refresh_token: 'r2', id_token: 'idt' } }),
  });

  const result = await createCodexProvider({ dir, allowRefresh: true }).fetch();
  assert.equal(result.plan, 'Pro');
  assert.equal(result.windows[0].usedPercent, 5);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tokens.access_token, 'fresh');
  assert.equal(saved.tokens.refresh_token, 'r2');
  assert.ok(saved.last_refresh);
  assert.equal(saved.OPENAI_API_KEY, null);
});

test('missing login files give a plain-English message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'none-'));
  await assert.rejects(createClaudeProvider({ dir, allowRefresh: true }).fetch(), /Run "claude"/);
  await assert.rejects(createCodexProvider({ dir, allowRefresh: true }).fetch(), /codex login/);
});
