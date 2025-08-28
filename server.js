import express from 'express'
import http from 'http'
import cors from 'cors'
import cookie from 'cookie'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'
import mineflayer from 'mineflayer'
import fs from 'fs'

// FIX: prismarine-auth is CommonJS
import PrismAuth from 'prismarine-auth'
const { Authflow, Titles } = PrismAuth

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TOKENS_DIR = path.join(__dirname, 'tokens')
if(!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR)

const wsByUid = new Map() // uid -> Set<ws>
function sendToUid(uid, msg){
  const set = wsByUid.get(uid)
  if(!set) return
  const data = JSON.stringify(msg)
  for(const ws of set){ try{ ws.send(data) }catch{} }
}

class BotManager{
  constructor(){ this.sessions=new Map(); this.listeners=new Set() }
  on(fn){ this.listeners.add(fn); return ()=>this.listeners.delete(fn) }
  push(type,payload){ for(const f of this.listeners){ try{ f({type,payload}) }catch{} } }
  list(){ return [...this.sessions.values()].map(s=>({
    id:s.id,status:s.status,host:s.cfg.host,port:s.cfg.port,
    username:s.bot?.username||s.cfg.username,auth:s.cfg.auth,
    createdAt:s.createdAt,afkMode:s.cfg.afkMode||'jitter'
  }))}
  log(id,level,msg){ const s=this.sessions.get(id); if(!s) return
    const e={ts:Date.now(),level,msg}; s.logs.push(e); if(s.logs.length>600) s.logs.splice(0,s.logs.length-600); this.push('log',{id,entry:e})
  }
  _anti(s){
    const b=s.bot,c=s.cfg; if(c.loginOnly) return
    const m=c.afkMode||'jitter', iv=Math.max(15000,Number(c.afkIntervalMs||60000)); const R=(a,b)=>a+Math.random()*(b-a)
    s.afkTimer=setInterval(()=>{ try{
      if(!b?.entity) return
      b.look((b.entity.yaw||0)+R(-Math.PI/8,Math.PI/8),R(-.2,.2),true)
      if(c.keepAliveCmd && Math.random()<.2) b.chat(c.keepAliveCmd)
      if(m==='jitter'){ b.setControlState('jump',true); setTimeout(()=>b.setControlState('jump',false),250) }
      else if(m==='circle'){ b.setControlState('forward',true); setTimeout(()=>b.setControlState('forward',false),1200) }
      else if(m==='strafe'){ const side=Math.random()<.5?'left':'right'; b.setControlState(side,true); setTimeout(()=>b.setControlState(side,false),700) }
      else if(m==='walkabout'){ const dir=Math.random()<.5?'forward':'back'; b.setControlState(dir,true); setTimeout(()=>b.setControlState(dir,false),700) }
      this.log(s.id,'trace','Anti-AFK '+m)
    }catch(e){ this.log(s.id,'warn','Anti-AFK error: '+(e?.message||e)) } }, iv)
  }
  async start(cfg, uid){
    const id=uuidv4()
    const s={id,cfg,status:'starting',logs:[],createdAt:Date.now(),bot:null,afkTimer:null,reTimer:null}
    this.sessions.set(id,s); this.push('sessions',this.list())

    const profilesFolder = path.join(TOKENS_DIR, uid||'default')
    if(!fs.existsSync(profilesFolder)) fs.mkdirSync(profilesFolder, { recursive:true })

    const go=()=>{
      this.log(id,'info',`Connecting ${cfg.host}:${cfg.port} (${cfg.auth})`)
      const bot=mineflayer.createBot({
        host:cfg.host, port:Number(cfg.port||25565), auth:cfg.auth||'microsoft',
        username: cfg.auth==='offline' ? (cfg.username||'Player') : undefined,
        profilesFolder,
        onMsaCode: (data)=>{ try{
          const uri=data.verification_uri || 'https://www.microsoft.com/link'
          const code=data.user_code || ''
          this.log(id,'auth',`Go to ${uri} and use code ${code}`)
          sendToUid(uid, { type:'ms_code', payload:{ uri, code } })
        }catch{} }
      })
      s.bot=bot; const set=x=>{ s.status=x; this.push('sessions',this.list()) }
      bot.once('login',()=>{ set('online'); this.log(id,'ok','Logged as '+bot.username); if(cfg.loginOnly){ setTimeout(()=>{ try{bot.quit('login-only')}catch{} },500) } })
      bot.once('spawn',()=>{ this.log(id,'ok','Spawned'); if(cfg.joinCmd){ this.log(id,'info','join '+cfg.joinCmd); bot.chat(cfg.joinCmd) } this._anti(s) })
      bot.on('messagestr',m=>this.log(id,'chat',m)); bot.on('message',m=>this.log(id,'chat',m?.toString?m.toString():String(m)))
      bot.on('kicked',r=>{ set('kicked'); this.log(id,'warn','KICKED '+r) })
      bot.on('end',()=>{ set('ended'); this.log(id,'info','Disconnected'); if(s.afkTimer){clearInterval(s.afkTimer); s.afkTimer=null}
        if(cfg.autoReconnect && !cfg.loginOnly){ const d=Number(cfg.reconnectDelayMs||10000); this.log(id,'info','Reconnecting in '+Math.round(d/1000)+'s'); s.reTimer=setTimeout(()=>{ set('reconnecting'); go() }, d) }
        else { this.sessions.delete(id); this.push('sessions',this.list()) } })
      bot.on('error',e=>this.log(id,'error',e?.message||String(e)))
    }
    go(); return {id}
  }
  stop(id){ const s=this.sessions.get(id); if(!s) throw new Error('Session not found')
    if(s.reTimer) clearTimeout(s.reTimer); if(s.afkTimer) clearInterval(s.afkTimer); if(s.bot) try{s.bot.quit('Stopped by user')}catch{}; this.sessions.delete(id); this.push('sessions',this.list())
  }
  logs(id){ const s=this.sessions.get(id); return s? s.logs:[] }
}
const M=new BotManager()

const app=express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname,'public')))

// assign uid cookie if missing
app.use((req,res,next)=>{
  const cookies = cookie.parse(req.headers.cookie || '')
  let uid = cookies.afk_uid
  if(!uid){ uid = uuidv4(); res.setHeader('Set-Cookie', `afk_uid=${uid}; Path=/; SameSite=Lax; Max-Age=315360000`) }
  req.uid = uid
  next()
})

// Microsoft LOGIN ONLY (no IP) — caches tokens for this uid
app.post('/api/ms/start', async (req,res)=>{
  const uid = req.uid
  const cacheDir = path.join(TOKENS_DIR, uid)
  if(!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive:true })

  ;(async()=>{
    try{
      const flow = new Authflow(null, cacheDir, {
        authTitle: Titles.MinecraftJava,
        deviceType: 'Win32',
        // prismarine-auth uses callback name 'authTitle'/'deviceType' and emits 'msal' device code through internal code path
        // we'll just use Authflow with cached tokens so next bot.start won't prompt.
      })
      await flow.getMinecraftJavaToken()
      sendToUid(uid, { type:'ms_done' })
    }catch(e){
      sendToUid(uid, { type:'ms_error', payload: (e?.message||String(e)) })
    }
  })()

  res.json({ok:true})
})

// sessions API
app.get('/api/sessions',(req,res)=>res.json(M.list()))
app.post('/api/sessions',async(req,res)=>{
  const c=req.body||{}; if(!c.host) return res.status(400).json({error:'host is required'})
  try{
    const {id}=await M.start({
      host:c.host, port:Number(c.port||25565), auth:c.auth||'microsoft',
      username:c.username||'', joinCmd:c.joinCmd||'', keepAliveCmd:c.keepAliveCmd||'',
      afkIntervalMs:Number(c.afkIntervalMs||60000), afkMode:c.afkMode||'jitter',
      autoReconnect:Boolean(c.autoReconnect??true), reconnectDelayMs:Number(c.reconnectDelayMs||10000),
      loginOnly:Boolean(c.loginOnly??false)
    }, req.uid)
    res.json({id})
  }catch(e){ res.status(500).json({error:e?.message||String(e)}) }
})
app.post('/api/sessions/:id/stop',(req,res)=>{ try{ M.stop(req.params.id); res.json({ok:true}) }catch(e){ res.status(404).json({error:e?.message||String(e)}) } })
app.post('/api/sessions/stop-all',(req,res)=>{ for(const id of [...M.sessions.keys()]){ try{ M.stop(id) }catch{} } res.json({ok:true}) })
app.post('/api/sessions/:id/chat',(req,res)=>{
  const {text}=req.body||{}; if(!text||!text.trim()) return res.status(400).json({error:'text required'})
  const s=M.sessions.get(req.params.id); if(!s||!s.bot) return res.status(404).json({error:'session/bot not found'})
  try{ s.bot.chat(text.trim()); M.log(s.id,'you',text.trim()); res.json({ok:true}) }catch(e){ res.status(500).json({error:e?.message||String(e)}) }
})

// ws
const server=http.createServer(app)
const wss=new WebSocketServer({server, path:'/ws'})
wss.on('connection',(ws,req)=>{
  const cookies = cookie.parse(req.headers.cookie || '')
  const uid = cookies.afk_uid || 'default'
  if(!wsByUid.has(uid)) wsByUid.set(uid,new Set())
  wsByUid.get(uid).add(ws)
  ws.on('close',()=>{ const set=wsByUid.get(uid); if(set){ set.delete(ws); if(set.size===0) wsByUid.delete(uid) } })
  ws.send(JSON.stringify({type:'sessions',payload:M.list()}))
})

const PORT=process.env.PORT||3000
server.listen(PORT,()=>console.log('AFK Console PRO v1.3.7-2 (no-token, ms-login) on '+PORT))
