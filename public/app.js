const $=s=>document.querySelector(s)

const api = {
  async list(){ const r=await fetch('/api/sessions'); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async create(cfg){ const r=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async stop(id){ const r=await fetch('/api/sessions/'+id+'/stop',{method:'POST'}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async chat(id,text){ const r=await fetch('/api/sessions/'+id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async msStart(){ const r=await fetch('/api/ms/start',{method:'POST'}); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() }
}

const sessionsBox=$('#sessions'), chatSel=$('#chatSession')
function renderSessions(list){
  sessionsBox.innerHTML=''
  if(!list.length){ sessionsBox.innerHTML='<div class="text-sm text-neutral-500">אין סשנים</div>'; chatSel.innerHTML='<option value=\"\">בחר סשן…</option>'; return }
  list.forEach(s=>{
    const div=document.createElement('div')
    div.className='p-2 border rounded flex items-center justify-between gap-2'
    div.innerHTML=`<div class="min-w-0"><div class="font-medium truncate">${s.username||'(auth…)'} @ ${s.host}:${s.port}</div><div class="text-xs text-neutral-500">מצב: ${s.status} • ${s.auth}</div></div><div class="flex gap-2"><button class="btn-stop px-2 py-1 rounded bg-red-600 text-white">עצור</button></div>`
    sessionsBox.appendChild(div)
    div.querySelector('.btn-stop').onclick=async()=>{ if(!confirm('לעצור?')) return; await api.stop(s.id); await refreshSessions() }
  })
  const old=chatSel.value
  chatSel.innerHTML='<option value=\"\">בחר סשן…</option>'+list.map(s=>`<option value="${s.id}">${s.username||'(auth…)'} @ ${s.host}</option>`).join('')
  if(list.some(s=>s.id===old)) chatSel.value=old
}
async function refreshSessions(){ try{ renderSessions(await api.list()) }catch(e){ sessionsBox.innerHTML='<div class="text-sm text-red-600">שגיאה: '+(e?.message||e)+'</div>' } }
document.getElementById('refreshSessions').onclick=refreshSessions

const presetEl=document.getElementById('preset'), hostEl=document.getElementById('host'), portEl=document.getElementById('port')
if(presetEl){
  const applyPreset=v=>{
    if(v==='custom'){ hostEl.disabled=false; portEl.disabled=false; return }
    const [h,p]=v.split(':'); hostEl.value=h; portEl.value=Number(p||25565); hostEl.disabled=true; portEl.disabled=true; localStorage.setItem('afk.preset',v)
  }
  presetEl.onchange=()=>applyPreset(presetEl.value)
  const saved=localStorage.getItem('afk.preset')||'donutsmp.net:25565'; presetEl.value=saved; applyPreset(saved)
}
document.getElementById('auth').onchange=()=> document.getElementById('username').classList.toggle('hidden', document.getElementById('auth').value!=='offline')
document.getElementById('sessionForm').onsubmit=async e=>{
  e.preventDefault()
  const cfg={
    host:hostEl.value.trim(),
    port:Number(portEl.value||25565),
    auth:document.getElementById('auth').value,
    username:document.getElementById('auth').value==='offline'?document.getElementById('username').value.trim():undefined,
    joinCmd:document.getElementById('joinCmd').value.trim(),
    keepAliveCmd:document.getElementById('keepAliveCmd').value.trim(),
    afkMode:document.getElementById('afkMode').value,
    afkIntervalMs:Number(document.getElementById('afkIntervalMs').value||60000),
    autoReconnect:document.getElementById('autoReconnect').checked,
    reconnectDelayMs:Number(document.getElementById('reconnectDelayMs').value||10000)
  }
  try{ await api.create(cfg); await refreshSessions() }catch(e2){ alert('שגיאה: '+(e2?.message||e2)) }
}

const chatBox=$('#chatBox'); let chatLines=[]
function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', \"'\":'&#39;' }[m])) }
function renderLine(l){
  const t=new Date(l.ts).toLocaleTimeString()
  let user='System', msg=l.msg, cls='msg-sys'
  const m1=l.msg.match(/^<(.+?)>\\s*(.*)$/)
  const m2=l.msg.match(/^(\\w+):\\s*(.*)$/)
  if(l.level==='you'){ user='You'; msg=l.msg; cls='msg-you' }
  else if(m1){ user=m1[1]; msg=m1[2]; cls='msg-user' }
  else if(m2){ user=m2[1]; msg=m2[2]; cls='msg-user' }
  return `<div><span class="text-neutral-500">[${t}]</span> <span class="${cls}">&lt;${escapeHtml(user)}&gt;</span> <span>${escapeHtml(msg)}</span></div>`
}
function appendChat(line){ chatLines.push(line); if(chatLines.length>500) chatLines.splice(0,chatLines.length-500); chatBox.innerHTML=chatLines.map(renderLine).join(''); chatBox.scrollTop=chatBox.scrollHeight }
document.getElementById('chatSend').onclick=async()=>{
  const id=chatSel.value, text=document.getElementById('chatInput').value.trim()
  if(!id) return alert('בחר סשן'); if(!text) return
  try{ await api.chat(id,text); document.getElementById('chatInput').value='' }catch(e){ alert('שגיאה: '+(e?.message||e)) }
}

document.getElementById('stopAll').onclick=async()=>{ try{ await fetch('/api/sessions/stop-all',{method:'POST'}); await refreshSessions() }catch(e){ alert('שגיאה: '+(e?.message||e)) } }

const authBanner=document.getElementById('authBanner')
function showAuthBanner(text){ if(!authBanner) return; authBanner.innerHTML=`<div class="m-2 p-3 rounded bg-amber-100 text-amber-900 border border-amber-300 text-sm">${text}</div>`; authBanner.classList.remove('hidden') }
const msaModal=document.getElementById('msaModal'), msaCodeEl=document.getElementById('msaCode'), msaOpen=document.getElementById('msaOpen'), msaCopy=document.getElementById('msaCopy'), msaClose=document.getElementById('msaClose')
function showMsaModal(url,code){ if(msaCodeEl) msaCodeEl.textContent=code||'—'; if(msaOpen){ msaOpen.href=url; msaOpen.textContent=url } if(msaModal) msaModal.classList.remove('hidden') }
if(msaCopy){ msaCopy.onclick=async()=>{ try{ await navigator.clipboard.writeText(msaCodeEl.textContent.trim()) }catch{} } }
if(msaClose){ msaClose.onclick=()=> msaModal.classList.add('hidden') }
document.getElementById('btnMsLogin').onclick=async()=>{ try{ await api.msStart(); showAuthBanner('Waiting for Microsoft confirmation…'); }catch(e){ alert('שגיאה: '+(e?.message||e)) } }

try{
  const proto=location.protocol==='https:'?'wss://':'ws://'
  const ws=new WebSocket(proto+location.host+'/ws')
  ws.onmessage=(ev)=>{
    try{
      const {type,payload}=JSON.parse(ev.data)
      if(type==='sessions'){ renderSessions(payload) }
      else if(type==='ms_code'){ showMsaModal(payload.uri, payload.code); try{ window.open(payload.uri,'_blank','noopener') }catch{} }
      else if(type==='ms_done'){ showAuthBanner('Microsoft login success ✔'); if(msaModal) msaModal.classList.add('hidden') }
      else if(type==='ms_error'){ showAuthBanner('Microsoft login failed: '+payload) }
      else if(type==='log'){ if(['chat','you','ok','info','warn','error','trace'].includes(payload.entry.level)){ appendChat(payload.entry) } }
    }catch{}
  }
}catch{}

refreshSessions()
