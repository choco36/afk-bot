const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const mineflayer = require('mineflayer');

// Basic config
const PORT = process.env.PORT || 8080;
const MAX_BOTS = Number(process.env.MAX_BOTS || 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function parseHostPort(hostString) {
  // Accept "host" or "host:port"
  const parts = (hostString || '').trim().split(':');
  return { host: parts[0] || 'localhost', port: parts[1] ? Number(parts[1]) : 25565 };
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch(e) { /* ignore */ }
}

class BotWrapper {
  constructor(id, options, broadcast) {
    this.id = id;
    this.options = options; // snapshot of spawn options
    this.broadcast = broadcast;
    this.bot = null;
    this.reconnectTimer = null;
    this.loginTimer = null;
    this.antiAfkTimer = null;
    this.manual = false;
    const { server, version, loginMessage, worldChangeMessage, loginDelay, flags, mode, username } = this.options;
  }

  log(level, msg, data = {}) {
    this.broadcast({ type: 'log', level, msg, accountId: this.id, data });
  }

  spawn() {
    // new spawn resets manual flag
    this.manual = false
    const { host, port } = parseHostPort(server);

    const create = () => {
      // Build mineflayer options
      const opts = {
        host,
        port,
        version: version && version !== 'auto' ? version : undefined,
        // For offline/cracked accounts
        username: mode === 'offline' ? (username || 'Player_' + this.id.slice(0, 6)) : 'afk-client',
        // For Microsoft auth
        auth: mode === 'offline' ? 'offline' : 'microsoft',
        onMsaCode: (data) => {
          // data: {user_code, device_code, verification_uri, expires_in, interval, message}
          this.broadcast({
            type: 'deviceCode',
            accountId: this.id,
            userCode: data.user_code,
            verificationUri: data.verification_uri,
            expiresIn: data.expires_in,
            message: data.message
          });
          this.log('info', `Device code issued: ${data.user_code} — ${data.verification_uri}`);
        }
      };

      try {
        this.bot = mineflayer.createBot(opts);
      } catch (e) {
        this.log('error', 'Failed to create bot: ' + e.message);
        return;
      }

      // Events
      this.bot.once('login', () => this.log('info', 'Logging in...'));
      this.bot.once('spawn', () => {
        this.log('success', 'Spawned in world');
        if (flags?.sneak) this.bot.setControlState('sneak', true);
        if (loginMessage) this.bot.chat(loginMessage);
        if (worldChangeMessage) setTimeout(() => this.bot.chat(worldChangeMessage), 1200);

        if (flags?.antiAfk) this.startAntiAfk();
      });

      this.bot.on('message', (jsonMsg) => {
        // Convert chat object to string safely
        let text = '';
        try { text = jsonMsg.toString(); } catch { text = String(jsonMsg); }
        this.broadcast({ type: 'chat', accountId: this.id, text });
      });

      this.bot.on('kicked', (reason) => {
        this.log('warn', 'Kicked', { reason });
      });

      this.bot.on('end', (reason) => {
        this.log('warn', 'Disconnected', { reason });
        this.stopAntiAfk();
        this.bot = null;
        const wantAuto = !!(this.options.flags?.autoReconnect);
        if (wantAuto && !this.manual) {
          this.scheduleReconnect();
        }
      });

      this.bot.on('error', (err) => {
        this.log('error', 'Bot error: ' + (err?.message || err));
      });
    };

    const delay = Math.max(0, Number(loginDelay || 0));
    if (delay) {
      this.log('info', `Delaying login by ${delay}ms`);
      if (this.loginTimer) clearTimeout(this.loginTimer);
      this.loginTimer = setTimeout(() => { this.loginTimer = null; create(); }, delay);
    } else {
      create();
    }
  }

  startAntiAfk() {
    this.stopAntiAfk();
    const bot = this.bot;
    if (!bot) return;
    let step = 0;
    this.antiAfkTimer = setInterval(() => {
      if (!this.bot) return;
      step++;
      // gentle camera rotation and periodic jump
      const yaw = (step % 360) * (Math.PI / 180);
      try {
        this.bot.look(yaw, 0, true);
        if (step % 10 === 0) {
          this.bot.setControlState('jump', true);
          setTimeout(() => this.bot && this.bot.setControlState('jump', false), 200);
        }
      } catch {}
    }, 1000);
  }

  stopAntiAfk() {
    if (this.antiAfkTimer) clearInterval(this.antiAfkTimer);
    this.antiAfkTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const backoff = Math.floor(3000 + Math.random()*4000);
    this.log('info', `Reconnecting in ${backoff}ms`);
    if (this.manual) return;
    this.reconnectTimer = setTimeout(() => { if (!this.manual) this.spawn(); }, backoff);
  }

  say(text) {
    if (this.bot) try { this.bot.chat(text); } catch {}
  }

  dropAll() {
    const bot = this.bot;
    if (!bot) return;
    const items = bot.inventory?.items() || [];
    const tossNext = () => {
      if (!items.length) return;
      const it = items.shift();
      bot.tossStack(it).then(tossNext).catch(() => tossNext());
    };
    tossNext();
  }

  setSneak(enabled) {
    if (this.bot) this.bot.setControlState('sneak', !!enabled);
  }

  disconnect() {
    this.manual = true;
    this.stopAntiAfk();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    if (this.bot) {
      try { this.bot.end('manual'); } catch {}
      this.bot = null;
    }
  }
}

class BotManager {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.bots = new Map(); // id -> BotWrapper
  }

  spawnBot(spawnOptions) {
    if (this.bots.size >= MAX_BOTS) return { error: 'MAX_BOTS_LIMIT' };
    const id = spawnOptions.accountId || uuidv4();
    const wrapper = new BotWrapper(id, spawnOptions, this.broadcast);
    this.bots.set(id, wrapper);
    wrapper.spawn();
    return { accountId: id };
  }

  byId(id) { return this.bots.get(id); }

  remove(id) {
    const w = this.bots.get(id);
    if (!w) return;
    w.disconnect();
    this.bots.delete(id);
  }

  list() {
    return Array.from(this.bots.keys());
  }
}

const manager = new BotManager((msg) => {
  // Broadcast to all clients
  wss.clients.forEach((ws) => { if (ws.readyState === ws.OPEN) safeSend(ws, msg); });
});

wss.on('connection', (ws, req) => {
  // CORS for WS (basic allow)
  // (If you set ALLOWED_ORIGIN, you can enforce here based on req.headers.origin)
  safeSend(ws, { type: 'hello', msg: 'connected', maxBots: MAX_BOTS });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;

    if (t === 'spawn') {
      // Expected payload:
      // {type:'spawn', accountId?, mode:'microsoft'|'offline', username?, server, version, loginDelay, loginMessage, worldChangeMessage, flags:{autoReconnect, antiAfk, sneak} }
      const res = manager.spawnBot({
        accountId: msg.accountId,
        mode: msg.mode || 'microsoft',
        username: msg.username || null,
        server: msg.server,
        version: msg.version || 'auto',
        loginDelay: Number(msg.loginDelay || 0),
        loginMessage: msg.loginMessage || '',
        worldChangeMessage: msg.worldChangeMessage || '',
        flags: {
          autoReconnect: !!(msg.flags && msg.flags.autoReconnect),
          antiAfk: !!(msg.flags && msg.flags.antiAfk),
          sneak: !!(msg.flags && msg.flags.sneak)
        }
      });
      if (res.error) safeSend(ws, { type:'error', error: res.error });
      else safeSend(ws, { type:'spawned', accountId: res.accountId });
    }

    if (t === 'chat') {
      const w = manager.byId(msg.accountId);
      if (w && msg.text) w.say(msg.text);
    }

    if (t === 'dropAll') {
      const w = manager.byId(msg.accountId);
      if (w) w.dropAll();
    }

    if (t === 'toggleSneak') {
      const w = manager.byId(msg.accountId);
      if (w) w.setSneak(!!msg.enabled);
    }

    if (t === 'disconnect') {
      const w = manager.byId(msg.accountId);
      if (w) { w.disconnect(); safeSend(ws, { type:'disconnected', accountId: msg.accountId }); }
    }

    if (t === 'remove') {
      manager.remove(msg.accountId);
      safeSend(ws, { type:'removed', accountId: msg.accountId });
    }

    if (t === 'list') {
      safeSend(ws, { type: 'list', items: manager.list() });
    }
  });
});

server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
