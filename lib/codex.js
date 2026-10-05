import { join } from 'node:path';
import { readJson, writeJson, fetchJson, decodeJwt, HttpError } from './credentials.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function windowLabel(seconds, fallback) {
  if (!seconds) return fallback;
  if (seconds === 604800) return 'Weekly';
  if (seconds % 86400 === 0) return `${seconds / 86400}-day window`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour session`;
  return `${Math.round(seconds / 60)}-minute window`;
}

function toWindow(key, w, fallbackLabel, prefix = '') {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = null;
  if (typeof w.reset_at === 'number') resetsAt = new Date(w.reset_at * 1000).toISOString();
  else if (typeof w.reset_after_seconds === 'number') resetsAt = new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
  return {
    key,
    label: prefix + windowLabel(w.limit_window_seconds, fallbackLabel),
    usedPercent: w.used_percent,
    resetsAt,
    windowSeconds: w.limit_window_seconds ?? null,
  };
}

export function normaliseCodex(usage) {
  const windows = [];
  const rl = usage?.rate_limit;
  windows.push(
    toWindow('primary', rl?.primary_window, 'Session'),
    toWindow('secondary', rl?.secondary_window, 'Weekly'),
  );
  const cr = usage?.code_review_rate_limit;
  windows.push(
    toWindow('review_primary', cr?.primary_window, 'Session', 'Code review · '),
    toWindow('review_secondary', cr?.secondary_window, 'Weekly', 'Code review · '),
  );
  for (const [i, extra] of (usage?.additional_rate_limits ?? []).entries()) {
    const name = extra?.limit_name ?? extra?.metered_feature ?? `Extra limit ${i + 1}`;
    const r = extra?.rate_limit ?? extra;
    windows.push(
      toWindow(`extra_${i}_primary`, r?.primary_window, 'Session', `${name} · `),
      toWindow(`extra_${i}_secondary`, r?.secondary_window, 'Weekly', `${name} · `),
    );
  }

  const notes = [];
  const credits = usage?.credits;
  if (credits?.unlimited) notes.push('Unlimited credits');
  else if (credits?.has_credits && credits.balance != null) notes.push(`Credits balance: ${credits.balance}`);
  if (rl?.limit_reached) notes.push('Limit reached');

  const plan = usage?.plan_type ? usage.plan_type.charAt(0).toUpperCase() + usage.plan_type.slice(1) : null;
  return { plan, windows: windows.filter(Boolean), notes };
}

function accountId(tokens) {
  if (tokens.account_id) return tokens.account_id;
  const claims = decodeJwt(tokens.id_token ?? '') ?? decodeJwt(tokens.access_token ?? '');
  return claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
}

function expiresSoon(token) {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' && exp * 1000 < Date.now() + 60_000;
}

export function createCodexProvider({ dir, allowRefresh }) {
  const file = join(dir, 'auth.json');

  async function load() {
    let data;
    try {
      data = await readJson(file);
    } catch (err) {
      throw new Error(err.code === 'ENOENT'
        ? `No Codex login found at ${file}. Run "codex login" on the server.`
        : `Could not read ${file}: ${err.message}`);
    }
    if (!data.tokens?.access_token) {
      throw new Error('Codex is signed in with an API key, not a ChatGPT plan, so there are no plan limits to show.');
    }
    return data;
  }

  async function refresh(force = false) {
    if (!allowRefresh) throw new Error('Codex login has expired. Run "codex" on the server once to renew it.');
    const data = await load();
    if (!force && !expiresSoon(data.tokens.access_token)) return data;
    if (!data.tokens.refresh_token) throw new Error('Codex login has no refresh token. Run "codex login" again.');
    try {
      const res = await fetchJson(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: data.tokens.refresh_token,
          scope: 'openid profile email',
        }),
      });
      data.tokens = {
        ...data.tokens,
        account_id: accountId(data.tokens) ?? undefined,
        access_token: res.access_token ?? data.tokens.access_token,
        id_token: res.id_token ?? data.tokens.id_token,
        refresh_token: res.refresh_token ?? data.tokens.refresh_token,
      };
      data.last_refresh = new Date().toISOString();
      await writeJson(file, data);
      return data;
    } catch (err) {
      throw new Error(`Could not renew Codex login (${err.message}). Run "codex login" on the server.`);
    }
  }

  async function callUsage(tokens) {
    const headers = {
      authorization: `Bearer ${tokens.access_token}`,
      'user-agent': 'codex_cli_rs',
      accept: 'application/json',
    };
    const id = accountId(tokens);
    if (id) headers['chatgpt-account-id'] = id;
    return fetchJson(USAGE_URL, { headers });
  }

  return {
    id: 'codex',
    name: 'Codex',
    async fetch() {
      let data = await load();
      if (expiresSoon(data.tokens.access_token)) data = await refresh();
      let usage;
      try {
        usage = await callUsage(data.tokens);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 401) throw err;
        const fresh = await load();
        data = fresh.tokens.access_token !== data.tokens.access_token ? fresh : await refresh(true);
        usage = await callUsage(data.tokens);
      }
      return normaliseCodex(usage);
    },
  };
}
