// === src/index.js ===
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

function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

function parseHostPort(hostString) {
  const s = String(hostString || '').trim();
  if (!s) return { host: '', port: 25565 };
  const i = s.lastIndexOf(':');
  if (i > -1 && i !== s.length - 1 && /^[0-9]+$/.test(s.slice(i + 1))) {
    return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
  }
  return { host: s, port: 25565 };
}

class BotWrapper {
  constructor(id, options, broadcast) {
    this.id = id;
    this.options = options;
    this.broadcast = broadcast;
    this.bot = null;
    this.reconnectTimer = null;
    this.loginTimer = null;
    this.antiAfkTimer = null;
    this.manual = false; // נהיה true כשמנתקים ידנית או על בעיית DNS
  }

  snapshot() {
    return {
      id: this.id,
      server: this.options.server,
      version: this.options.version || 'auto',
      mode: this.options.mode || 'microsoft',
      flags: this.options.flags || {},
      connected: !!this.bot,
      manual: !!this.manual
    };
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
      this.broadcast({ type: 'state', items: [ this.snapshot() ] });
      return;
    }

    const create = () => {
      const opts = {
        host,
        port,
        version: version && version !== 'auto' ? version : undefined,
        auth: mode === 'offline' ? 'offline' : 'microsoft',
        flow: mode === 'offline' ? undefined : 'live',   // 👈 חשוב ל-Microsoft
        authTitle: 'afk-console-client',                 // 👈 שומר טוקנים בקאש
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
        this.broadcast({ type: 'state', items: [ this.snapshot() ] });
        return;
      }

      this.bot.once('login', () => this.log('info', 'Logging in...'));

      this.bot.once('spawn', () => {
        this.log('success', 'Spawned in world');
        if (flags?.sneak) this.bot.setControlState('sneak', true);
        if (loginMessage) this.bot.chat(loginMessage);
        if (worldChangeMessage) setTimeout(() => this.bot && this.bot.chat(worldChangeMessage), 1200);
        if (flags?.antiAfk) this.startAntiAfk();
        this.broadcast({ type: 'state', items: [ this.snapshot() ] });
      });

      this.bot.on('message', (jsonMsg) => {
        let text = '';
        try { text = jsonMsg.toString(); } catch { text = String(jsonMsg); }
        this.broadcast({ type: 'chat', accountId: this.id, text });
      });

      this.bot.on('kicked', (reason) => this.log('warn', 'Kicked
