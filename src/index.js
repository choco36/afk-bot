const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const mineflayer = require('mineflayer');
const dns = require('dns').promises;

const PORT = process.env.PORT || 8080;
const MAX_BOTS = Number(process.env.MAX_BOTS || 10);

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = http.createServer(app);
server.on('error', (err) => console.error('[server error]', err && (err.stack || err)));
const wss = new WebSocketServer({ server, path: '/ws' });

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err && (err.stack || err)));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err && (err.stack || err)));

function parseHostPort(hostString) {
  const s = String(hostString || '').trim();
  if (!s) return { host: '', port: 25565 };
  const i = s.lastIndexOf(':');
  if (i > -1 && i !== s.length - 1 && /^[0-9]+$/.test(s.slice(i + 1))) {
    return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
  }
  return { host: s, port: 25565 };
}
function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

class BotWrapper {
  constructor(id, options, broadcast) {
    this.id = id;
    this.options = options;
    this.broadcast = broadcast;
    this.bot = null;
    this.reconnectTimer = null;
    this.loginTimer = null;
    this.antiAfkTimer = null;
    this.manual = false;
  }

  log(level, msg, data = {}) {
    this.broadcast({ type: 'log', level, msg, accountId: this.id, data });
  }

  spawn() {
    this.manual = false;
    const { server, version, loginMessage, worldChangeMessage, loginDelay, flags, mode, username } = this.options;
    const { host, port } = parseHostPort(server);

    if (!host || host === 'play.server.com') {
      this.log('error', 'Invalid server host. Set a real Server IP.');
      return;
    }

    const create = () => {
      const opts = {
        host,
        port,
        version: version && version !== 'auto' ? version : undefined,
        auth: mode === 'offline' ? 'offline' : 'microsoft',
        onMsaCode: (data) => {
          this.broadcast({
            type: 'deviceCode',
            accountId: this.id,
            userCode: data.user_code,
            verificationUri: data.verification_uri,
            expiresIn: data.expires_in,
            message: data.message
          });
          this.log('info', `Device code: ${data.user_code} — ${data.verification_uri}`);
        }
      };
      if (mode === 'offline') {
        opts.username = username || ('Player_' + this.id.slice(0, 6));
      }

      try {
        this.bot = mineflayer.createBot(opts);
      } catch (e) {
        this.log('error', 'Failed to create bot: ' + e.message);
        return;
      }

      this.bot.once('login', () => this.log('info', 'Logging in...'));
      this.bot.once('spawn', () => {
        this.log('success', 'Spawned in world');
        if (flags?.sneak) this.bot.setControlState('sneak', true);
        if (loginMessage) this.bot.chat(loginMessage);
        if (worldChangeMessage) setTimeout(() => this.bot && this.bot.chat(worldChangeMessage), 1200);
        if (flags?.antiAfk) this.startAntiAfk();
      });

      this.bot.on('message', (jsonMsg) => {
        let text = '';
        try { text = jsonMsg.toString(); } catch { text = String(jsonMsg); }
        this.broadcast({ type: 'chat', accountId: this.id, text });
      });

      this.bot.on('kicked', (reason) => this.log('warn', 'Kicked', { reason }));

      this.bot.on('end', (reason) => {
        this.log('warn', 'Disconnected', { reason });
        this.stopAntiAfk();
        this.bot = null;
        const wantAuto = !!(this.options.flags?.autoReconnect);
        if (wantAuto && !this.manual) this.scheduleReconnect();
      });

      this.bot.on('error', (err) => {
        const msg = String(err?.message || err || 'error');
        const code = err?.code || '';
        this.log('error', 'Bot error: ' + msg);
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo ENOTFOUND/i.test(msg)) {
          this.log('warn', 'DNS error detected — stopping auto-reconnect for this account.');
          this.manual = true;
          this.disconnect();
        }
      });
    };

    const schedule = () => {
      const delay = Math.max(0, Number(loginDelay || 0));
      if (delay) {
        this.log('info', `Delaying login by ${delay}ms`);
        if (this.loginTimer) clearTimeout(this.loginTimer);
        this.loginTimer = setTimeout(() => { this.loginTimer = null; create(); }, delay);
      } else {
        create();
      }
    };

    dns.lookup(host).then(() => schedule()).catch((err) => {
      this.log('error', `DNS lookup failed for ${host}: ${err && err.message ? err.message : err}`);
      this.manual = true;
    });
  }

  startAntiAfk() {
    this.stopAntiAfk();
    const bot = this.bot;
    if (!bot) return;
    let step = 0;
    this.antiAfkTimer = setInterval(() => {
      if (!this.bot) return;
      step++;
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
    const backoff = Math.floor(3000 + Math.random() * 4000);
    this.log('info', `Reconnecting in ${backoff}ms`);
    if (this.manual) return;
    this.reconnectTimer = setTimeout(() => { if (!this.manual) this.spawn(); }, backoff);
  }

  say(text) { if (this.bot) try { this.bot.chat(text); } catch {} }

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

  setSneak(enabled) { if (this.bot) this.bot.setControlState('sneak', !!enabled); }

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
    this.bots = new Map();
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
  remove(id) { const w = this.bots.get(id); if (!w) return; w.disconnect(); this.bots.delete(id); }
  list() { return Array.from(this.bots.keys()); }
}

const manager = new BotManager((msg) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState !== ws.OPEN) return;
    const id = msg && msg.accountId;
    if (!id || ws.subs?.has('ALL') || (id && ws.subs?.has(id))) safeSend(ws, msg);
  });
});

wss.on('connection', (ws) => {
  ws.subs = new Set();
  safeSend(ws, { type: 'hello', msg: 'connected', maxBots: MAX_BOTS });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;

    if (t === 'subscribe') {
      ws.subs.clear();
      if (msg.all) { ws.subs.add('ALL'); }
      else if (Array.isArray(msg.accounts)) { msg.accounts.forEach((id) => ws.subs.add(String(id))); }
      safeSend(ws, { type: 'subscribed', accounts: Array.from(ws.subs) });
    }

    if (t === 'spawn') {
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
      else { safeSend(ws, { type:'spawned', accountId: res.accountId }); try { ws.subs.add(res.accountId); } catch {} }
    }

    if (t === 'chat') { const w = manager.byId(msg.accountId); if (w && msg.text) w.say(msg.text); }
    if (t === 'dropAll') { const w = manager.byId(msg.accountId); if (w) w.dropAll(); }
    if (t === 'toggleSneak') { const w = manager.byId(msg.accountId); if (w) w.setSneak(!!msg.enabled); }
    if (t === 'disconnect') { const w = manager.byId(msg.accountId); if (w) { w.disconnect(); safeSend(ws, { type:'disconnected', accountId: msg.accountId }); } }
    if (t === 'remove') { manager.remove(msg.accountId); safeSend(ws, { type:'removed', accountId: msg.accountId }); }
    if (t === 'list') { safeSend(ws, { type: 'list', items: manager.list() }); }
  });
});

server.listen(PORT, () => console.log('Server listening on :' + PORT));
