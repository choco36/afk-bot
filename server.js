import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'
import mineflayer from 'mineflayer'
import url from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

class BotManager {
  constructor() {
    this.sessions = new Map()
    this.listeners = new Set()
  }
  onBroadcast(fn){
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  broadcast(type, payload){
    for (const fn of this.listeners){
      try { fn({ type, payload }) } catch (e) {}
    }
  }
  list(){
    return [...this.sessions.values()].map(s => ({
      id: s.id, status: s.status, host: s.config.host, port: s.config.port,
      username: s.bot?.username || s.config.username, auth: s.config.auth,
      createdAt: s.createdAt, lastEvent: s.lastEvent,
      afkMode: s.config.afkMode || 'jitter'
    }))
  }
  log(id, level, msg){
    const s = this.sessions.get(id); if(!s) return
    const entry = { ts: Date.now(), level, msg }
    s.logs.push(entry)
    if (s.logs.length > 800) s.logs.splice(0, s.logs.length - 800)
    this.broadcast('log', { id, entry })
  }
  _startAntiAfk(session){
    const bot = session.bot, cfg = session.config
    if (cfg.loginOnly) return
    const mode = cfg.afkMode || 'jitter'
    const interval = Math.max(15000, Number(cfg.afkIntervalMs || 60000))
    const rand = (a,b)=>a+Math.random()*(b-a)
    session.antiAfkTimer = setInterval(() => {
      try{
        if(!bot?.entity) return
        bot.look((bot.entity.yaw||0)+rand(-Math.PI/8,Math.PI/8), rand(-.2,.2), true)
        if(cfg.keepAliveCmd && Math.random()<.2) bot.chat(cfg.keepAliveCmd)
        if(mode==='jitter'){
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 250)
          if(Math.random()<.5) bot.swingArm('right')
        } else if(mode==='circle'){
          bot.setControlState('forward', true)
          setTimeout(() => bot.setControlState('forward', false), 1200)
        } else if(mode==='strafe'){
          const side = Math.random()<.5 ? 'left':'right'
          bot.setControlState(side, true)
          setTimeout(() => bot.setControlState(side, false), 700)
        } else if(mode==='walkabout'){
          const dir = Math.random()<.5 ? 'forward':'back'
          bot.setControlState(dir, true)
          setTimeout(() => bot.setControlState(dir, false), 700)
        }
        this.log(session.id, 'trace', `Anti-AFK tick (${mode})`)
      }catch(e){
        this.log(session.id, 'warn', 'Anti-AFK error: ' + (e?.message||e))
      }
    }, interval)
  }
  async start(config){
    const id = uuidv4()
    const s = { id, config, status:'starting', logs:[], createdAt:Date.now(), lastEvent:'init', bot:null, antiAfkTimer:null, reconnectTimer:null }
    this.sessions.set(id, s)
    this.broadcast('sessions', this.list())

    const startBot = ()=>{
      this.log(id,'info', `Connecting ${config.host}:${config.port} (${config.auth})`)
      const bot = mineflayer.createBot({
        host: config.host, port: Number(config.port||25565),
        auth: config.auth || 'microsoft',
        username: config.auth==='offline' ? (config.username||'Player') : undefined
      })
      s.bot = bot
      const set = (st)=>{ s.status=st; this.broadcast('sessions', this.list()) }

      bot.once('login', ()=>{
        set('online')
        this.log(id,'ok', `Logged in as ${bot.username}`)
        if (config.loginOnly) {
          this.log(id,'info','Login-only mode: quitting after successful sign-in…')
          setTimeout(()=>{ try{ bot.quit('login-only complete') }catch{} }, 500)
        }
      })
      bot.once('spawn', ()=>{
        this.log(id,'ok','Spawned')
        if(config.joinCmd){ this.log(id,'info','join '+config.joinCmd); bot.chat(config.joinCmd) }
        this._startAntiAfk(s)
      })
      bot.on('messagestr', m => this.log(id,'chat', m))
      bot.on('message', m => this.log(id,'chat', m?.toString ? m.toString() : String(m)))
      bot.on('kicked', r=>{ set('kicked'); this.log(id,'warn','KICKED: '+r) })
      bot.on('end', ()=>{
        set('ended'); this.log(id,'info','Disconnected')
        if(s.antiAfkTimer){ clearInterval(s.antiAfkTimer); s.antiAfkTimer=null }
        if(config.autoReconnect && !config.loginOnly){
          const d = Number(config.reconnectDelayMs||10000)
          this.log(id,'info','Reconnecting in '+Math.round(d/1000)+'s')
          s.reconnectTimer=setTimeout(()=>{ set('reconnecting'); startBot() }, d)
        } else {
          this.sessions.delete(id)
          this.broadcast('sessions', this.list())
        }
      })
      bot.on('error', e => this.log(id,'error', e?.message||String(e)))
    }
    startBot()
    this.log(id,'hint','If Microsoft auth: watch the Login tab for device-code link.')
    return { id }
  }
  stop(id){
    const s = this.sessions.get(id); if(!s) throw new Error('Session not found')
    if(s.reconnectTimer){ clearTimeout(s.reconnectTimer); s.reconnectTimer=null }
    if(s.antiAfkTimer){ clearInterval(s.antiAfkTimer); s.antiAfkTimer=null }
    if(s.bot){ try{ s.bot.quit('Stopped by user') }catch{} }
    this.sessions.delete(id)
    this.broadcast('sessions', this.list())
  }
  logs(id){ const s=this.sessions.get(id); return s ? s.logs : [] }
}
const manager = new BotManager()

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname,'public')))

function assertAuth(req, res, next){
  if(!ADMIN_TOKEN) return next()
  const auth = req.headers.authorization || ''
  if(auth === `Bearer ${ADMIN_TOKEN}`) return next()
  return res.status(401).json({ error:'unauthorized' })
}

app.get('/api/me', (req,res)=> res.json({ tokenRequired: !!ADMIN_TOKEN }))
app.get('/api/sessions', assertAuth, (req,res)=> res.json(manager.list()))
app.post('/api/sessions', assertAuth, async (req,res)=>{
  const c = req.body || {}
  if(!c.host) return res.status(400).json({ error:'host is required' })
  if(!c.port) c.port = 25565
  if(!c.auth) c.auth = 'microsoft'
  try{
    const { id } = await manager.start({
      host: c.host, port: Number(c.port), auth: c.auth,
      username: c.username||'', joinCmd: c.joinCmd||'', keepAliveCmd: c.keepAliveCmd||'',
      afkIntervalMs: Number(c.afkIntervalMs||60000), afkMode: c.afkMode||'jitter',
      autoReconnect: Boolean(c.autoReconnect ?? true), reconnectDelayMs: Number(c.reconnectDelayMs||10000),
      loginOnly: Boolean(c.loginOnly ?? false)
    })
    res.json({ id })
  }catch(e){ res.status(500).json({ error: e?.message||String(e) }) }
})
app.post('/api/sessions/:id/stop', assertAuth, (req,res)=>{
  try{ manager.stop(req.params.id); res.json({ ok:true }) }
  catch(e){ res.status(404).json({ error: e?.message||String(e) }) }
})
app.post('/api/sessions/:id/chat', assertAuth, (req,res)=>{
  const { text } = req.body || {}
  if (!text || !text.trim()) return res.status(400).json({ error:'text required' })
  const s = manager.sessions.get(req.params.id)
  if (!s || !s.bot) return res.status(404).json({ error:'session/bot not found' })
  try { s.bot.chat(text.trim()); manager.log(s.id, 'you', text.trim()); res.json({ ok:true }) }
  catch(e){ res.status(500).json({ error:e?.message||String(e) }) }
})
app.post('/api/sessions/stop-all', assertAuth, (req,res)=>{
  const ids = [...manager.sessions.keys()]
  ids.forEach(id => { try{ manager.stop(id) }catch{} })
  res.json({ ok:true })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path:'/ws' })
wss.on('connection', (ws, req)=>{
  if(ADMIN_TOKEN){
    const q = url.parse(req.url, true).query
    if(q.token !== ADMIN_TOKEN){ ws.close(); return }
  }
  const send = (m)=>{ try{ ws.send(JSON.stringify(m)) }catch{} }
  send({ type:'sessions', payload: manager.list() })
  const off = manager.onBroadcast(send); ws.on('close', off)
})

const PORT = process.env.PORT || 3000
server.listen(PORT, ()=>{
  console.log('AFK Console PRO (HE) v1.3.1 listening on http://localhost:'+PORT)
  if(ADMIN_TOKEN) console.log('API protected with ADMIN_TOKEN')
})
