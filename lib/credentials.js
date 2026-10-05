import { readFile, writeFile } from 'node:fs/promises';

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Write in place rather than via temp file + rename, so the file keeps the
// owner and permissions the CLI gave it (rename would hand it to our user).
export async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, `${new URL(url).host} replied ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return text ? JSON.parse(text) : {};
}
