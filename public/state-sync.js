// === public/state-sync.js ===
(function(){
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  let ws = window.ws instanceof WebSocket ? window.ws : null;
  function ensureWS(){
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    if (!ws || ws.readyState > 1) ws = new WebSocket(WS_URL);
    ws.addEventListener('open', ()=>{
      safeSend({type:'subscribe', all:true});
      safeSend({type:'list'});
    });
    ws.addEventListener('message', onMsg);
    window.ws = ws;
    return ws;
  }
  function safeSend(obj){ try { ensureWS().send(JSON.stringify(obj)); } catch{} }

  const sessions = new Map();
  function upsert(items){
    (items||[]).forEach(s => sessions.set(s.id, s));
    render();
  }

  function el(tag, cls, txt){
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt) e.textContent = txt;
    return e;
  }

  const panel = el('div', 'sess-panel');
  const style = document.createElement('style');
  style.textContent = `
  .sess-panel{position:fixed;right:12px;bottom:12px;background:#0f172aee;color:#e2e8f0;
    border:1px solid #334155;border-radius:12px;backdrop-filter:blur(6px);
    width:min(420px,calc(100vw - 24px));max-height:min(50vh,420px);overflow:auto;z-index:9999;}
  .sess-panel h3{margin:10px 12px;font-size:14px;font-weight:700;letter-spacing:.3px}
  .sess-list{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}
  .sess-item{display:flex;justify-content:space-between;align-items:center;
    gap:8px;padding:8px;border:1px solid #334155;border-radius:10px;background:#0b1220;}
  .sess-item .meta{display:flex;flex-direction:column;font-size:12px;line-height:1.2}
  .badge{font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid #475569}
  .ok{color:#10b981;border-color:#10b981}
  .off{color:#ef4444;border-color:#ef4444}
  .actions{display:flex;gap:6px}
  .btn{font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid #475569;background:#111827;color:#e5e7eb;cursor:pointer}
  .btn:hover{background:#1f2937}
  `;
  document.head.appendChild(style);
  panel.appendChild(el('h3', null, 'Sessions'));
  const list = el('div','sess-list'); panel.appendChild(list);
  document.body.appendChild(panel);

  function render(){
    list.innerHTML = '';
    if (sessions.size === 0) { list.appendChild(el('div', 'sess-item', 'No active sessions')); return; }
    for (const s of sessions.values()){
      const row = el('div','sess-item');
      const meta = el('div','meta');
      meta.appendChild(el('div',null,`ID: ${s.id}`));
      meta.appendChild(el('div',null,`Server: ${s.server}`));
      row.appendChild(meta);
      const status = el('span','badge ' + (s.connected ? 'ok':'off'), s.connected ? 'ONLINE':'OFFLINE');
      row.appendChild(status);
      const actions = el('div','actions');
      const disc = el('button','btn','Disconnect');
      disc.onclick = ()=> safeSend({type:'disconnect', accountId:s.id});
      const rem = el('button','btn','Remove');
      rem.onclick = ()=> safeSend({type:'remove', accountId:s.id});
      actions.appendChild(disc); actions.appendChild(rem);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  function onMsg(ev){
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') upsert(msg.items);
  }

  ensureWS();
})();
