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
  constructor(){ this.sessions=new Map(); this.listeners=new Set() }
  on(fn){ this.listeners.add(fn); return ()=>this.listeners.delete(fn) }
  push(type,payload){ for(const fn of this.listeners){ try{ fn({type,payload}) }catch{} } }
  list(){ return [...this.sessions.values()].map(s=>({
    id:s.id,status:s.status,host:s.cfg.host,port:s.cfg.port,
    username:s.bot?.username||s.cfg.username,auth:s.cfg.auth,
    createdAt:s.createdAt,afkMode:s.cfg.afkMode||'jitter'
  }))}
  log(id,level,msg){ const s=this.sessions.get(id); if(!s) return
    const entry={ts:Date.now(),level,msg}; s.logs.push(entry)
    if(s.logs.length>600) s.logs.splice(0,s.logs.length-600); this.push('log',{id,entry})
  }
  _anti(s){ const b=s.bot,c=s.cfg; if(c.loginOnly) return
    const mode=c.afkMode||'jitter', iv=Math.max(15000,Number(c.afkIntervalMs||60000)); const R=(a,b)=>a+Math.random()*(b-a)
    s.afkTimer=setInterval(()=>{ try{
      if(!b?.entity) return
      b.look((b.entity.yaw||0)+R(-Math.PI/8,Math.PI/8),R(-.2,.2),true)
      if(c.keepAliveCmd && Math.random()<.2) b.chat(c.keepAliveCmd)
      if(mode==='jitter'){ b.setControlState('jump',true); setTimeout(()=>b.setControlState('jump',false),250) }
      else if(mode==='circle'){ b.setControlState('forward',true); setTimeout(()=>b.setControlState('forward',false),1200) }
      else if(mode==='strafe'){ const side=Math.random()<.5?'left':'right'; b.setControlState(side,true); setTimeout(()=>b.setControlState(side,false),700) }
      else if(mode==='walkabout'){ const dir=Math.random()<.5?'forward':'back'; b.setControlState(dir,true); setTimeout(()=>b.setControlState(dir,false),700) }
      this.log(s.id,'trace','Anti-AFK '+mode)
    }catch(e){ this.log(s.id,'warn','Anti-AFK error: '+(e?.message||e)) } },iv)
  }
  async start(cfg){
    const id=uuidv4(); const s={id,cfg,createdAt:Date.now(),status:'starting',logs:[],bot:null,afkTimer:null,reTimer:null}
    this.sessions.set(id,s); this.push('sessions',this.list())
    const go=()=>{
      this.log(id,'info',`Connecting ${cfg.host}:${cfg.port} (${cfg.auth})`)
      const bot=mineflayer.createBot({
        host:cfg.host, port:Number(cfg.port||25565), auth:cfg.auth||'microsoft',
        username: cfg.auth==='offline' ? (cfg.username||'Player') : undefined,
        onMsaCode: (data)=>{ try{
          const uri = data.verification_uri || 'https://www.microsoft.com/link'
          const code = data.user_code || ''
          this.log(id,'auth', `Go to ${uri} and use code ${code}`)
        }catch{} }
      })
      s.bot=bot; const set=st=>{ s.status=st; this.push('sessions',this.list()) }
      bot.once('login',()=>{ set('online'); this.log(id,'ok','Logged as '+bot.username); if(cfg.loginOnly){ setTimeout(()=>{try{bot.quit('login-only')}catch{}},500) } })
      bot.once('spawn',()=>{ this.log(id,'ok','Spawned'); if(cfg.joinCmd){ this.log(id,'info','join '+cfg.joinCmd); bot.chat(cfg.joinCmd) } this._anti(s) })
      bot.on('messagestr',m=>this.log(id,'chat',m))
      bot.on('message',m=>this.log(id,'chat',m?.toString?m.toString():String(m)))
      bot.on('kicked',r=>{ set('kicked'); this.log(id,'warn','KICKED '+r) })
      bot.on('end',()=>{ set('ended'); this.log(id,'info','Disconnected')
        if(s.afkTimer){clearInterval(s.afkTimer); s.afkTimer=null}
        if(cfg.autoReconnect && !cfg.loginOnly){ const d=Number(cfg.reconnectDelayMs||10000); this.log(id,'info','Reconnecting in '+Math.round(d/1000)+'s'); s.reTimer=setTimeout(()=>{ set('reconnecting'); go() }, d) }
        else { this.sessions.delete(id); this.push('sessions',this.list()) }
      })
      bot.on('error',e=>this.log(id,'error',e?.message||String(e)))
    }
    go(); return {id}
  }
  stop(id){ const s=this.sessions.get(id); if(!s) throw new Error('Session not found')
    if(s.reTimer) clearTimeout(s.reTimer); if(s.afkTimer) clearInterval(s.afkTimer); if(s.bot) try{s.bot.quit('Stopped by user')}catch{}
    this.sessions.delete(id); this.push('sessions',this.list())
  }
  logs(id){ const s=this.sessions.get(id); return s? s.logs : [] }
}
const M=new BotManager()

const app=express(); app.use(cors()); app.use(express.json()); app.use(express.static(path.join(__dirname,'public')))

function normTok(x){
  if(!x) return ''
  try{ x = decodeURIComponent(String(x)) }catch{ x = String(x) }
  x = x.trim()
  if((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) x = x.slice(1,-1)
  return x.trim()
}
function guard(req,res,next){
  if(!ADMIN_TOKEN) return next()
  const hdrRaw = (req.headers.authorization||'')
  const hdr = normTok(hdrRaw.replace(/^Bearer\s+/i,''))
  const q = normTok((req.query && req.query.token) || '')
  const cookie = (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>/^admin_token=/.test(s))
  const cookieVal = cookie ? normTok(cookie.split('=',2)[1]) : ''
  const ok = [hdr,q,cookieVal].some(v => v && v === ADMIN_TOKEN)
  if(ok) return next()
  return res.status(401).json({error:'unauthorized'})
}
}

app.get('/api/me',(req,res)=>res.json({tokenRequired:!!ADMIN_TOKEN}))
app.post('/api/set-token',(req,res)=>{ const t=(req.body&&req.body.token)||''; if(!t) return res.status(400).json({error:'token required'})
  res.setHeader('Set-Cookie',`admin_token=${t}; Path=/; HttpOnly; SameSite=Lax`); res.json({ok:true})
})

app.get('/api/sessions',guard,(req,res)=>res.json(M.list()))
app.post('/api/sessions',guard,async(req,res)=>{
  const c=req.body||{}; if(!c.host) return res.status(400).json({error:'host is required'})
  if(!c.port) c.port=25565; if(!c.auth) c.auth='microsoft'
  try{ const {id}=await M.start({ host:c.host, port:Number(c.port), auth:c.auth, username:c.username||'', joinCmd:c.joinCmd||'', keepAliveCmd:c.keepAliveCmd||'', afkIntervalMs:Number(c.afkIntervalMs||60000), afkMode:c.afkMode||'jitter', autoReconnect:Boolean(c.autoReconnect??true), reconnectDelayMs:Number(c.reconnectDelayMs||10000), loginOnly:Boolean(c.loginOnly??false) }); res.json({id}) }
  catch(e){ res.status(500).json({error:e?.message||String(e)}) }
})
app.post('/api/sessions/:id/stop',guard,(req,res)=>{ try{ M.stop(req.params.id); res.json({ok:true}) }catch(e){ res.status(404).json({error:e?.message||String(e)}) } })
app.post('/api/sessions/:id/chat',guard,(req,res)=>{
  const {text}=req.body||{}; if(!text||!text.trim()) return res.status(400).json({error:'text required'})
  const s=M.sessions.get(req.params.id); if(!s||!s.bot) return res.status(404).json({error:'session/bot not found'})
  try{ s.bot.chat(text.trim()); M.log(s.id,'you',text.trim()); res.json({ok:true}) }catch(e){ res.status(500).json({error:e?.message||String(e)}) }
})
app.post('/api/sessions/stop-all',guard,(req,res)=>{ for(const id of [...M.sessions.keys()]){ try{ M.stop(id) }catch{} } res.json({ok:true}) })

const server=http.createServer(app); const wss=new WebSocketServer({server,path:'/ws'})
wss.on('connection',(ws,req)=>{
  if(ADMIN_TOKEN){ const q=url.parse(req.url,true).query; const tok = normTok(q.token||''); if(tok!==ADMIN_TOKEN){ ws.close(); return } }
  const send=m=>{ try{ ws.send(JSON.stringify(m)) }catch{} }; send({type:'sessions',payload:M.list()})
  const off=M.on(send); ws.on('close',off)
})

const PORT=process.env.PORT||3000; server.listen(PORT,()=>console.log('AFK Console PRO v1.3.6 on '+PORT))
