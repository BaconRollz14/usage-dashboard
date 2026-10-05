import { join } from 'node:path';
import { readJson, writeJson, fetchJson, HttpError } from './credentials.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const LABELS = {
  five_hour: '5-hour session',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_oauth_apps: 'Weekly · connected apps',
  extra_usage: 'Extra usage',
};

const WINDOW_SECONDS = {
  five_hour: 5 * 3600,
};

function humanise(key) {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function normaliseClaude(usage) {
  const windows = [];
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (!value || typeof value !== 'object' || typeof value.utilization !== 'number') continue;
    if (key === 'extra_usage' && value.is_enabled === false) continue;
    windows.push({
      key,
      label: LABELS[key] ?? humanise(key),
      usedPercent: value.utilization,
      resetsAt: value.resets_at ? new Date(value.resets_at).toISOString() : null,
      windowSeconds: WINDOW_SECONDS[key] ?? (key.startsWith('seven_day') ? 7 * 86400 : null),
    });
  }
  return windows;
}

function planName(oauth) {
  const t = oauth?.subscriptionType;
  if (!t) return null;
  const tier = oauth.rateLimitTier?.match(/(\d+)x/)?.[1];
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${tier ? ` ${tier}x` : ''}`;
}

export function createClaudeProvider({ dir, allowRefresh }) {
  const file = join(dir, '.credentials.json');

  async function load() {
    let data;
    try {
      data = await readJson(file);
    } catch (err) {
      throw new Error(err.code === 'ENOENT'
        ? `No Claude login found at ${file}. Run "claude" on the server and sign in.`
        : `Could not read ${file}: ${err.message}`);
    }
    if (!data.claudeAiOauth?.accessToken) throw new Error('Claude credentials file has no subscription login in it.');
    return data;
  }

  async function refresh(force = false) {
    if (!allowRefresh) throw new Error('Claude login has expired. Run "claude" on the server once to renew it.');
    // Re-read first: the CLI may have renewed it since we last looked.
    const data = await load();
    const oauth = data.claudeAiOauth;
    if (!force && oauth.expiresAt && oauth.expiresAt > Date.now() + 60_000) return data;
    if (!oauth.refreshToken) throw new Error('Claude login has no refresh token. Sign in again with "claude".');

    let lastErr;
    for (const url of TOKEN_URLS) {
      try {
        const res = await fetchJson(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID }),
        });
        data.claudeAiOauth = {
          ...oauth,
          accessToken: res.access_token,
          refreshToken: res.refresh_token ?? oauth.refreshToken,
          expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
        };
        await writeJson(file, data);
        return data;
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 404) break;
      }
    }
    throw new Error(`Could not renew Claude login (${lastErr.message}). Run "claude" on the server to sign in again.`);
  }

  async function callUsage(token) {
    return fetchJson(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-code/2.1.0',
        accept: 'application/json',
      },
    });
  }

  return {
    id: 'claude',
    name: 'Claude Code',
    async fetch() {
      let data = await load();
      if (data.claudeAiOauth.expiresAt && data.claudeAiOauth.expiresAt < Date.now() + 60_000) {
        data = await refresh();
      }
      let usage;
      try {
        usage = await callUsage(data.claudeAiOauth.accessToken);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 401) throw err;
        const fresh = await load();
        data = fresh.claudeAiOauth.accessToken !== data.claudeAiOauth.accessToken ? fresh : await refresh(true);
        usage = await callUsage(data.claudeAiOauth.accessToken);
      }
      return { plan: planName(data.claudeAiOauth), windows: normaliseClaude(usage), notes: [] };
    },
  };
}
