const $=s=>document.querySelector(s), tokenKey='afk.token'
function setLockUI(locked){ $('#lockDot').className='w-3 h-3 rounded-full '+(locked?'bg-red-500':'bg-green-500'); $('#lockText').textContent=locked?'מצב: נעול – צריך להזין טוקן':'מצב: פתוח – הטוקן נשמר' }
function authHeaders(){ const t=localStorage.getItem(tokenKey); return t?{'Authorization':'Bearer '+t}:{} }
async function checkLock(){ try{ const r=await fetch('/api/me'); const {tokenRequired}=await r.json(); setLockUI(!!tokenRequired && !localStorage.getItem(tokenKey)) }catch{} }
$('#saveToken').onclick=()=>{ localStorage.setItem(tokenKey,$('#token').value.trim()); alert('נשמר'); checkLock() }
$('#stopAll').onclick=async()=>{ if(!confirm('לעצור את כל הסשנים?')) return; await fetch('/api/sessions/stop-all',{method:'POST',headers:authHeaders()}); await refreshSessions() }
checkLock()

// --- Microsoft login modal ---
const msaModal = document.getElementById('msaModal')
const msaCodeEl = document.getElementById('msaCode')
const msaOpen = document.getElementById('msaOpen')
const msaCopy = document.getElementById('msaCopy')
const msaClose = document.getElementById('msaClose')
let lastAuth = { code: '', url: '' }
function parseAuthMsg(msg){
  const url = (msg.match(/https?:\/\/\S+/i)||[])[0] || 'https://www.microsoft.com/link'
  const codeMatch = msg.match(/code\s+([A-Z0-9]{4,})/i) || msg.match(/\b([A-Z0-9]{4,})\b(?!.*\b[A-Z0-9]{4,}\b)/)
  const code = (codeMatch && codeMatch[1]) ? codeMatch[1].toUpperCase() : ''
  return { url, code }
}
function showMsaModal(url, code){
  lastAuth = { url, code }
  if(msaCodeEl) msaCodeEl.textContent = code || '—'
  if(msaOpen){ msaOpen.href = url; msaOpen.textContent = url }
  if(msaModal) msaModal.classList.remove('hidden')
}
if(msaCopy){ msaCopy.onclick = async ()=>{ try{ await navigator.clipboard.writeText(msaCodeEl.textContent.trim()) }catch{} } }
if(msaClose){ msaClose.onclick = ()=> msaModal.classList.add('hidden') }


const authBanner = document.getElementById('authBanner')
function showAuthBanner(text){
  if(!authBanner) return
  authBanner.innerHTML = `<div class="m-2 p-3 rounded bg-amber-100 text-amber-900 border border-amber-300 text-sm">${text}</div>`
  authBanner.classList.remove('hidden')
}


// API
const api = {
  async list(){ const r=await fetch('/api/sessions',{headers:authHeaders()}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async create(cfg){ const r=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(cfg)}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async stop(id){ const r=await fetch(`/api/sessions/${id}/stop`,{method:'POST',headers:authHeaders()}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async chat(id,text){ const r=await fetch(`/api/sessions/${id}/chat`,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({text})}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async logs(id){ const r=await fetch(`/api/sessions/${id}/logs`,{headers:authHeaders()}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
}

// Sessions list (Accounts)
const sessionsBox=$('#sessions'), chatSel=$('#chatSession')
function renderSessions(list){
  sessionsBox.innerHTML=''
  if(!list.length){ sessionsBox.innerHTML='<div class="text-sm text-neutral-500">אין סשנים</div>'; chatSel.innerHTML='<option value="">בחר סשן…</option>'; return }
  list.forEach(s=>{
    const div=document.createElement('div')
    div.className='p-2 border rounded flex items-center justify-between gap-2'
    div.innerHTML=`<div class="min-w-0"><div class="font-medium truncate">${s.username||'(auth…)'} @ ${s.host}:${s.port}</div><div class="text-xs text-neutral-500">מצב: ${s.status} • ${s.auth}</div></div><div class="flex gap-2"><button class="btn-stop px-2 py-1 rounded bg-red-600 text-white">עצור</button></div>`
    sessionsBox.appendChild(div)
    div.querySelector('.btn-stop').onclick=async()=>{ if(!confirm('לעצור?')) return; await api.stop(s.id); await refreshSessions() }
  })
  const old=chatSel.value
  chatSel.innerHTML='<option value="">בחר סשן…</option>'+list.map(s=>`<option value="${s.id}">${s.username||'(auth…)'} @ ${s.host}</option>`).join('')
  if(list.some(s=>s.id===old)) chatSel.value=old
}
async function refreshSessions(){ try{ renderSessions(await api.list()) }catch(e){ sessionsBox.innerHTML='<div class="text-sm text-red-600">שגיאת הרשאה</div>' } }
$('#refreshSessions').onclick=refreshSessions

// New session form (Settings)
$('#auth').onchange=()=> $('#username').classList.toggle('hidden', $('#auth').value!=='offline')
$('#sessionForm').onsubmit=async e=>{
  e.preventDefault()
  const cfg={ host:$('#host').value.trim(), port:Number($('#port').value||25565), auth:$('#auth').value, username:$('#auth').value==='offline'?$('#username').value.trim():undefined, joinCmd:$('#joinCmd').value.trim(), keepAliveCmd:$('#keepAliveCmd').value.trim(), afkMode:$('#afkMode').value, afkIntervalMs:Number($('#afkIntervalMs').value||60000), autoReconnect:true, reconnectDelayMs:Number($('#reconnectDelayMs').value||10000) }
  try{ await api.create(cfg); await refreshSessions() }catch(e2){ alert('שגיאה: '+(e2?.message||e2)) }
}

// Console (Chat) with trim + parsing
const chatBox=$('#chatBox')
let chatLines = [] // bounded buffer on client
function appendChat(line){
  chatLines.push(line); if(chatLines.length>500) chatLines.splice(0, chatLines.length-500)
  chatBox.innerHTML = chatLines.map(renderLine).join('')
  chatBox.scrollTop = chatBox.scrollHeight
}
function renderLine(l){
  const t = new Date(l.ts).toLocaleTimeString()
  // try to parse "user: message" or "<user> message"
  let user='System', msg=l.msg, cls='msg-sys'
  const m1 = l.msg.match(/^<(.+?)>\s*(.*)$/) // <user> text
  const m2 = l.msg.match(/^(\w+):\s*(.*)$/)  // user: text
  if(l.level==='you'){ user='You'; msg=l.msg; cls='msg-you' }
  else if(m1){ user=m1[1]; msg=m1[2]; cls='msg-user' }
  else if(m2){ user=m2[1]; msg=m2[2]; cls='msg-user' }
  return `<div><span class="text-neutral-500">[${t}]</span> <span class="${cls}">&lt;${escapeHtml(user)}&gt;</span> <span>${escapeHtml(msg)}</span></div>`
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])) }

$('#chatSend').onclick=async()=>{
  const id=chatSel.value, text=$('#chatInput').value.trim()
  if(!id) return alert('בחר סשן')
  if(!text) return
  try{ await api.chat(id, text); $('#chatInput').value=''; }catch(e){ alert('שגיאה: '+(e?.message||e)) }
}

// Live updates
try{
  const proto=location.protocol==='https:'?'wss://':'ws://', tok=localStorage.getItem(tokenKey)||''
  const ws=new WebSocket(proto+location.host+'/ws'+(tok?('?token='+encodeURIComponent(tok)):'') )
  ws.onmessage=(ev)=>{
    try{
      const {type,payload}=JSON.parse(ev.data)
      if(type==='sessions'){ renderSessions(payload) }
      else if(type==='log'){
        if(payload.entry.level==='auth'){ const {url, code} = parseAuthMsg(payload.entry.msg); showMsaModal(url, code) }
        if(payload.entry.level==='chat' || payload.entry.level==='you' || payload.entry.level==='ok' || payload.entry.level==='warn' || payload.entry.level==='error' || payload.entry.level==='auth'){
          appendChat({ ts: payload.entry.ts, msg: payload.entry.msg, level: payload.entry.level })
        }
      }
    }catch{}
  }
}catch{}

refreshSessions()
