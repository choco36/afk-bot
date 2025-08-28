// === src/index.js (with authTitle) ===
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
const wss = new WebSocketServer({ server, path: '/ws' });

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
    this.manual = false;
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
  log(level, msg, data = {}) { this.broadcast({ type:'log', level, msg, accountId:this.id, data }); }
  spawn() {
    this.manual = false;
    const { server, version, loginMessage, worldChangeMessage, loginDelay, flags, mode, username } = this.options;
    const { host, port } = parseHostPort(server);
    if (!host || host === 'play.server.com') {
      this.log('error','Invalid server host.'); 
      this.broadcast({ type:'state', items:[this.snapshot()] }); return;
    }
    const create = () => {
      const opts = {
        host, port,
        version: version && version !== 'auto' ? version : undefined,
        auth: mode === 'offline' ? 'offline' : 'microsoft',
        authTitle: 'afk-console-client',
        onMsaCode: (data) => {
          this.broadcast({
            type:'deviceCode', accountId:this.id,
            userCode:data.user_code, verificationUri:data.verification_uri,
            expiresIn:data.expires_in, message:data.message
          });
        }
      };
      if (mode === 'offline') opts.username = username || ('Player_' + this.id.slice(0,6));
      try { this.bot = mineflayer.createBot(opts); } catch(e) {
        this.log('error','Failed create bot: '+e.message); return;
      }
      this.bot.once('spawn', () => {
        this.log('success','Spawned');
        if (flags?.sneak) this.bot.setControlState('sneak',true);
        if (loginMessage) this.bot.chat(loginMessage);
        if (worldChangeMessage) setTimeout(()=>this.bot && this.bot.chat(worldChangeMessage),1200);
        this.broadcast({ type:'state', items:[this.snapshot()] });
      });
      this.bot.on('end', ()=>{ this.bot=null; this.broadcast({type:'state',items:[this.snapshot()]}); });
      this.bot.on('error',(err)=>{ this.log('error', String(err)); });
      this.broadcast({ type:'state', items:[this.snapshot()] });
    };
    dns.lookup(host).then(()=>create()).catch(err=>{
      this.log('error','DNS failed '+err.message); this.manual=true;
      this.broadcast({ type:'state', items:[this.snapshot()] });
    });
  }
  disconnect(){ this.manual=true; if(this.bot){ try{this.bot.end('manual');}catch{} this.bot=null;} this.broadcast({type:'state',items:[this.snapshot()]}); }
}

class BotManager {
  constructor(broadcast){ this.broadcast=broadcast; this.bots=new Map(); }
  spawnBot(opts){ const id=opts.accountId||uuidv4(); let w=this.bots.get(id); if(!w){ w=new BotWrapper(id,opts,this.broadcast); this.bots.set(id,w);} w.options=opts; w.spawn(); return {accountId:id,snapshot:w.snapshot()}; }
  byId(id){ return this.bots.get(id); }
  remove(id){ const w=this.bots.get(id); if(w){ w.disconnect(); this.bots.delete(id); this.broadcast({type:'state',items:[{id,connected:false,removed:true}]}); } }
  list(){ return Array.from(this.bots.values()).map(b=>b.snapshot()); }
}
const manager=new BotManager((msg)=>{ wss.clients.forEach(ws=>{ if(ws.readyState===ws.OPEN) safeSend(ws,msg); }); });
wss.on('connection',(ws)=>{ safeSend(ws,{type:'hello'}); safeSend(ws,{type:'state',items:manager.list()}); ws.on('message',(raw)=>{ let msg; try{msg=JSON.parse(raw);}catch{return;} if(msg.type==='spawn'){ const r=manager.spawnBot(msg); safeSend(ws,{type:'state',items:[r.snapshot]}); } if(msg.type==='disconnect'){ const w=manager.byId(msg.accountId); if(w) w.disconnect(); } if(msg.type==='remove'){ manager.remove(msg.accountId); } if(msg.type==='list'){ safeSend(ws,{type:'state',items:manager.list()}); } }); });
server.listen(PORT,()=>console.log('Listening on',PORT));
