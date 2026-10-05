# Usage dashboard

A small self-hosted page showing how much of your **Claude Code** and **Codex** subscription limits you've used: the 5-hour session, the weekly limits, when each one resets, and whether you're burning through them faster than they reset.

It reads the logins Claude Code and Codex already saved on the server and asks Anthropic and OpenAI for the same numbers you'd see with `/usage` (Claude) or `/status` (Codex). It refreshes every minute.

> **Heads-up:** neither company publishes an official API for subscription usage. This uses the endpoints the official CLIs use. If they change, the affected card shows an error until the app is updated. Your other card keeps working.

## Setup (Docker)

1. **Log in on the server** (one-off, as your normal user, not root):
   - Claude Code: run `claude` and sign in with your subscription.
   - Codex, on a headless server: run `codex login --device-auth`, then open the link it prints on your phone or laptop and enter the code.
     Alternative: log in with `codex login` on your laptop and copy `~/.codex/auth.json` into `~/.codex/` on the server.
2. **Get the code:** `git clone https://github.com/BaconRollz14/usage-dashboard && cd usage-dashboard`
3. **Configure:** `cp .env.example .env`, then edit `.env`:
   - `CLAUDE_HOME` / `CODEX_HOME`: the full paths to `.claude` and `.codex` in your home folder (e.g. `/home/matt/.claude`).
   - `PUID` / `PGID`: the output of `id -u` and `id -g`.
   - `DASHBOARD_PASSWORD`: strongly recommended.
4. **Start it:** `docker compose up -d --build`
5. Open `http://<server-ip>:8787`.

To update later: `git pull && docker compose up -d --build`.

## Things to know

- **Keep it private.** The container can read your Claude and Codex logins. Keep it on your home network, behind your VPN or behind your existing reverse-proxy login, and set a password. Don't port-forward it to the internet.
- **Login renewal.** Logins expire after a few hours. When one does, the dashboard renews it and saves the new login back to the same file, so Claude Code and Codex keep working too. If you'd rather it only ever reads your logins, set `ALLOW_TOKEN_REFRESH=false`. It will then show "expired" until you next use the CLI on the server.
- **Only one card set up?** That's fine. The other card shows what's missing and how to fix it.
- **The black tick on each bar** marks how far through the window you are. If the coloured fill is past it, you're on course to hit the limit before it resets.

## Running without Docker

Node 20 or newer: `npm start`. It reads `~/.claude` and `~/.codex` by default (or set `CLAUDE_DIR` / `CODEX_DIR`). `npm test` runs the checks.
