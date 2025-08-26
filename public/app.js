const $ = s => document.querySelector(s)
const tokenKey='afk.token'
function setLockUI(locked){ $('#lockDot').className = 'w-3 h-3 rounded-full inline-block ' + (locked ? 'bg-red-500' : 'bg-green-500'); $('#lockText').textContent = locked ? 'מצב: נעול – צריך להזין טוקן' : 'מצב: פתוח – הטוקן נשמר' }
function authHeaders(){ const t = localStorage.getItem(tokenKey); return t ? { 'Authorization':'Bearer '+t } : {} }
async function checkLock(){ try{ const r = await fetch('/api/me'); const { tokenRequired } = await r.json(); setLockUI(!!tokenRequired && !localStorage.getItem(tokenKey)) }catch{} }
$('#saveToken').onclick = ()=>{ localStorage.setItem(tokenKey, $('#token').value.trim()); alert('נשמר'); checkLock() }
$('#stopAll').onclick = async ()=>{ if(!confirm('לעצור את כל הסשנים?')) return; try{ const r = await fetch('/api/sessions/stop-all', { method:'POST', headers: authHeaders() }); if(!r.ok) throw new Error((await r.json()).error||r.statusText); alert('הכול נעצר'); await refreshSessions() }catch(e){ alert('נכשל לעצור הכל: '+(e?.message||e)) } }
$('#auth').onchange = ()=>{ $('#username').classList.toggle('hidden', $('#auth').value!=='offline') }

const api = {
  async list(){ const r = await fetch('/api/sessions', { headers: authHeaders() }); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async create(cfg){ const r = await fetch('/api/sessions', { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(cfg) }); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async stop(id){ const r = await fetch(`/api/sessions/${id}/stop`, { method:'POST', headers: authHeaders() }); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
  async logs(id){ const r = await fetch(`/api/sessions/${id}/logs`, { headers: authHeaders() }); if(!r.ok) throw new Error((await r.json()).error||r.statusText); return r.json() },
}

const sessionsBox = $('#sessions')
function renderSessions(list){
  sessionsBox.innerHTML = ''
  if(!list.length){ sessionsBox.innerHTML = '<div class="text-sm text-neutral-500">אין סשנים פעילים</div>'; return }
  list.forEach(s=>{
    const el = document.createElement('div')
    el.className = 'p-3 rounded-xl border bg-neutral-50 dark:bg-neutral-950 flex items-center justify-between gap-2'
    el.innerHTML = `<div class="min-w-0"><div class="font-medium truncate">${s.username||'(auth…)'} @ ${s.host}:${s.port}</div><div class="text-xs text-neutral-500">מצב: ${s.status} • ${s.auth} • AFK: ${s.afkMode}</div></div><div class="flex items-center gap-2"><button data-id="${s.id}" class="btn-stop px-3 py-2 rounded-lg bg-red-600 text-white">עצור</button><button class="copy-id px-3 py-2 rounded-lg border">העתק ID</button></div>`
    sessionsBox.appendChild(el)
    el.querySelector('.btn-stop').onclick = async ()=>{ if(!confirm('לעצור סשן זה?')) return; try{ await api.stop(s.id); await refreshSessions() }catch(e){ alert('נכשל: '+(e?.message||e)) } }
    el.querySelector('.copy-id').onclick = async ()=>{ await navigator.clipboard.writeText(s.id); alert('הועתק') }
  })
  const logSel = $('#logSession'); const old = logSel.value
  logSel.innerHTML = '<option value="">בחר סשן…</option>' + list.map(s=>`<option value="${s.id}">${s.username||'(auth…)'} @ ${s.host}</option>`).join('')
  if(list.some(s=>s.id===old)) logSel.value = old
}
async function refreshSessions(){ try{ renderSessions(await api.list()) }catch(e){ sessionsBox.innerHTML='<div class="text-sm text-red-600">שגיאת הרשאה (בדוק טוקן)</div>' } }
$('#refreshSessions').onclick = refreshSessions

const logBox = $('#logBox')
$('#logSession').onchange = async e=>{ const id=e.target.value; if(!id){ logBox.textContent='—'; return } try{ const rows=await api.logs(id); logBox.textContent=rows.map(r=>`[${new Date(r.ts).toLocaleTimeString()}] ${r.level.toUpperCase()} | ${r.msg}`).join('\\n'); logBox.scrollTop=logBox.scrollHeight }catch(e2){ logBox.textContent='שגיאה: '+(e2?.message||e2) } }

$('#sessionForm').onsubmit = async e=>{
  e.preventDefault()
  const cfg = { host: $('#host').value.trim(), port: Number($('#port').value||25565), auth: $('#auth').value, username: $('#auth').value==='offline' ? $('#username').value.trim() : undefined, joinCmd: $('#joinCmd').value.trim(), keepAliveCmd: $('#keepAliveCmd').value.trim(), afkMode: $('#afkMode').value, afkIntervalMs: Number($('#afkIntervalMs').value||60000), autoReconnect: $('#autoReconnect').checked, reconnectDelayMs: Number($('#reconnectDelayMs').value||10000) }
  if(!cfg.host) return alert('צריך למלא כתובת שרת'); if(cfg.auth==='offline'&&!cfg.username) return alert('Offline דורש שם משתמש')
  try{ const { id } = await api.create(cfg); alert('סשן התחיל: '+id+'\nאם Microsoft – חפש בלוגים של Koyeb קישור device code לאישור.'); await refreshSessions(); $('#logSession').value=id; const rows=await api.logs(id); logBox.textContent=rows.map(r=>`[${new Date(r.ts).toLocaleTimeString()}] ${r.level.toUpperCase()} | ${r.msg}`).join('\\n') }catch(e2){ alert('נכשל להתחיל: '+(e2?.message||e2)) }
}

checkLock(); refreshSessions()
