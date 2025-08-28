# AFK Console Client (HTML + Node.js) — Koyeb-ready

A minimal AFK Console Client for **Minecraft Java Edition**, using `mineflayer` + `prismarine-auth` on the backend, 
and a simple HTML/JS frontend. Supports **Microsoft Device Code** flow (2FA-like screen), multi-accounts, 
Auto-reconnect, Sneak, Anti-AFK (gentle camera/jump), login/world-change messages, Drop-all, and live Chat/Logs via WebSocket.

> **Note:** Browsers cannot connect directly to Minecraft TCP. This app runs a backend that holds the real bot connections and exposes a WebSocket for the UI.

## Quick start (local)
```bash
npm i
npm start
# open http://localhost:8080
```

## Deploy on Koyeb
1. Push this repo to GitHub.
2. Create a new **Service** in Koyeb using **Dockerfile** from this repo.
3. Set **Environment Variables** (optional):
   - `JWT_SECRET` (optional) – any random string for lightweight auth to the dashboard.
   - `ALLOWED_ORIGIN` (optional) – allow a specific origin for WS/HTTP (defaults to `*` for demo).
   - `MAX_BOTS` (optional) – default 10.
4. (Optional) Attach a **Volume** if you want persistent JSON config/logs later.
5. Deploy. Open your Koyeb service URL and start adding accounts.

## Microsoft login
When you connect a Microsoft account, the backend will send a `deviceCode` message to the UI showing:
- `userCode` – short code like `4YRBBU8`.
- `verificationUri` – open it in a browser and enter the code.
After authorizing, the bot will join the server. Codes expire after ~15 minutes; just retry if needed.

## Offline/cracked
Only enable it for private servers that allow `offline` mode. Otherwise, you must use Microsoft auth.

## Bedrock
This repo targets **Java Edition**. For Bedrock, you'd use `bedrock-protocol`. The UI can stay the same; backend changes would be needed.

## Security
This demo stores nothing sensitive by default. Prefer Microsoft OAuth (device code). Do not store raw passwords.
Obey each server’s rules regarding bot/AFK usage.

## License
MIT
