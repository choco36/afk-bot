(function(){
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // WS
  const WS_URL = (location.origin.replace('http', 'ws') + '/ws');
  const ws = new WebSocket(WS_URL);

  const accounts = new Map(); // id -> {id, label, mode}
  let selectedAccount = 'all';
  let onlineCount = 0;

  const consoleEl = $('#console');
// --- Shards tracker ---
const SHARDS_INTERVAL_MS = 10000;
let shardsTimer = null;
let shardsAccountId = 'auto';
let latestShards = 0;
const shardsCountEl = $('#shardsCount');
const shardsAccountSel = $('#shardsAccount');
const shardsAutoChk = $('#shardsAuto');
// Convert strings like "1.25K", "12,345", "2M" to integer count (optional usage)
function humanNumberToInt(s) {
  if (!s) return null;
  let t = String(s).trim().toUpperCase().replace(/,/g, '');
  let mult = 1;
  if (t.endsWith('K')) { mult = 1e3; t = t.slice(0, -1); }
  else if (t.endsWith('M')) { mult = 1e6; t = t.slice(0, -1); }
  else if (t.endsWith('B')) { mult = 1e9; t = t.slice(0, -1); }
  const n = parseFloat(t);
  if (Number.isNaN(n)) return null;
  return Math.round(n * mult);
}


function setShards(n) {
  latestShards = n;
  shardsCountEl.textContent = String(n);
}

function chooseShardsAccount() {
  const sel = shardsAccountSel.value;
  if (sel === 'auto') {
    // prefer selectedAccount if not 'all', otherwise first online account
    if (selectedAccount !== 'all') return selectedAccount;
    for (const [id, acc] of accounts) {
      if (acc.status === 'online') return id;
    }
    // fallback: any account id
    const keys = Array.from(accounts.keys());
    if (keys.length) return keys[0];
    return null;
  }
  return sel;
}

function refreshShardsDropdown() {
  const prev = shardsAccountSel.value;
  shardsAccountSel.innerHTML = '<option value="auto">auto</option>';
  accounts.forEach((acc, id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = acc.label.slice(0, 18) + (acc.status === 'online' ? ' •' : '');
    shardsAccountSel.appendChild(opt);
  });
  if ([...accounts.keys()].includes(prev) || prev === 'auto') shardsAccountSel.value = prev;
}

function startShardsLoop() {
  stopShardsLoop();
  if (!shardsAutoChk.checked) return;
  shardsTimer = setInterval(() => {
    const id = chooseShardsAccount();
    if (!id) return;
    // ask server for shards
    ws.send(JSON.stringify({ type:'chat', accountId:id, text:'/shards' }));
  }, SHARDS_INTERVAL_MS);
}

function stopShardsLoop() {
  if (shardsTimer) clearInterval(shardsTimer);
  shardsTimer = null;
}

shardsAutoChk?.addEventListener('change', startShardsLoop);
shardsAccountSel?.addEventListener('change', startShardsLoop);

  const LOG_MAX_LINES = 600; // keep last 600 lines
  const CLEAN_EVERY_MS = 10000; // trim every 10s

  function appendLine(text, level='info') {
    const div = document.createElement('div');
    div.className = 'line ' + (level || 'info');
    div.textContent = text;
    consoleEl.appendChild(div);
    while (consoleEl.childElementCount > LOG_MAX_LINES) {
      consoleEl.removeChild(consoleEl.firstChild);
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function log(line, level='info') {
    const prefix = level === 'success' ? '✓' : level === 'warn' ? '!' : level === 'error' ? '✕' : '•';
    appendLine(`[${new Date().toLocaleTimeString()}] ${prefix} ${line}`, level);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  ws.addEventListener('open', () => { log('Connected to backend'); startShardsLoop(); });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello') {
      log('Backend hello. Max bots: ' + msg.maxBots);
    }
    if (msg.type === 'log') {
      if (selectedAccount === 'all' || selectedAccount === msg.accountId) {
        log(`#${(msg.accountId||'').slice(0,6)}: ${msg.msg}`, msg.level||'info');
      }
    }
    if (msg.type === 'chat') {
      // parse shards count
      const mShards = /Your\s+shards:\s*([0-9][0-9,\.]*\s*[KMB]?)/i.exec(msg.text);
      if (mShards) setShards(mShards[1]);
      if ($('#showChat').checked && (selectedAccount === 'all' || selectedAccount === msg.accountId)) {
        appendLine(`${msg.text}`, 'chat');
      }
    }
    if (msg.type === 'deviceCode') {
      const dialog = $('#deviceModal');
      $('#userCode').textContent = msg.userCode;
      const link = $('#verifyLink');
      link.href = msg.verificationUri;
      link.textContent = msg.verificationUri;
      dialog.showModal();
    }
    if (msg.type === 'spawned') {
      const id = msg.accountId;
      if (accounts.has(id)) {
        accounts.get(id).status = 'online';
      }
      updateAccountsUI();
    }
    if (msg.type === 'disconnected' || msg.type === 'removed') {
      if (accounts.has(msg.accountId)) accounts.get(msg.accountId).status = 'offline';
      updateAccountsUI();
    }
  });

  // UI hooks
  $('#closeModal').addEventListener('click', () => $('#deviceModal').close());

  $('#btnAdd').addEventListener('click', () => {
    const label = $('#accLabel').value.trim();
    const mode = $('#accMode').value;
    if (!label) return alert('Enter a label/username/email');
    const id = crypto.randomUUID();
    accounts.set(id, { id, label, mode, status: 'offline' });
    $('#accLabel').value = '';
    updateAccountsUI();
  });

  $('#btnConnectAll').addEventListener('click', () => {
    accounts.forEach(acc => spawn(acc.id));
  });

  $('#btnDisconnectAll').addEventListener('click', () => {
    accounts.forEach(acc => disconnect(acc.id));
  });

  $('#btnDropAll').addEventListener('click', () => {
    targetAccounts().forEach(id => ws.send(JSON.stringify({ type:'dropAll', accountId:id })));
  });

  $('#btnSend').addEventListener('click', () => {
    const text = $('#chatInput').value;
    if (!text) return;
    targetAccounts().forEach(id => ws.send(JSON.stringify({ type:'chat', accountId:id, text })));
    $('#chatInput').value = '';
  });

  $('#btnClear').addEventListener('click', () => { consoleEl.textContent = ''; });

  $('#selectAccount').addEventListener('change', (e) => {
    selectedAccount = e.target.value;
  });

  function targetAccounts() {
    if (selectedAccount === 'all') return Array.from(accounts.keys());
    return [selectedAccount];
  }

  function spawn(id) {
    const acc = accounts.get(id);
    if (!acc) return;
    const payload = {
      type: 'spawn',
      accountId: id,
      mode: acc.mode === 'offline' || $('#offlineMode').checked ? 'offline' : 'microsoft',
      username: acc.label,
      server: $('#serverIp').value.trim(),
      version: $('#serverVersion').value,
      loginDelay: Number($('#loginDelay').value || 0),
      loginMessage: $('#loginMsg').value.trim(),
      worldChangeMessage: $('#worldMsg').value.trim(),
      flags: {
        autoReconnect: $('#autoReconnect').checked,
        antiAfk: $('#antiAfk').checked,
        sneak: $('#sneak').checked
      }
    };
    ws.send(JSON.stringify(payload));
  }

  function disconnect(id) {
    ws.send(JSON.stringify({ type:'disconnect', accountId:id }));
  }

  function remove(id) {
    ws.send(JSON.stringify({ type:'remove', accountId:id }));
    accounts.delete(id);
    updateAccountsUI();
  }

  function updateAccountsUI() {
    const ul = $('#accounts');
    ul.innerHTML = '';
    onlineCount = 0;

    const select = $('#selectAccount');
    const previous = select.value;
    select.innerHTML = '<option value="all">All accounts</option>';

    accounts.forEach(acc => {
      if (acc.status === 'online') onlineCount++;
      const li = document.createElement('li');
      const left = document.createElement('div');
      const badge = document.createElement('span');
      badge.className = 'badge ' + (acc.status === 'online' ? 'green' : 'gray');
      const label = document.createElement('span');
      label.textContent = acc.label + (acc.mode === 'offline' ? ' (offline)' : '');
      left.appendChild(badge);
      left.appendChild(label);

      const right = document.createElement('div');
      const btnConn = document.createElement('button');
      btnConn.textContent = acc.status === 'online' ? 'Disconnect' : 'Connect';
      btnConn.addEventListener('click', () => {
        if (acc.status === 'online') disconnect(acc.id); else spawn(acc.id);
      });
      const btnDel = document.createElement('button');
      btnDel.textContent = '🗑';
      btnDel.title = 'Remove';
      btnDel.addEventListener('click', () => remove(acc.id));

      right.appendChild(btnConn);
      right.appendChild(btnDel);

      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);

      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.label.slice(0, 18) + (acc.status === 'online' ? ' •' : '');
      select.appendChild(opt);
    });

    if ([...accounts.keys()].includes(previous)) select.value = previous;
    $('#onlineCount').textContent = 'Online: ' + onlineCount + '/' + accounts.size;
  }

  // periodic trim to avoid memory bloat
  setInterval(() => {
    if (consoleEl.childElementCount > LOG_MAX_LINES) {
      const excess = consoleEl.childElementCount - LOG_MAX_LINES;
      for (let i = 0; i < excess; i++) {
        if (consoleEl.firstChild) consoleEl.removeChild(consoleEl.firstChild);
      }
    }
  }, CLEAN_EVERY_MS);

  // initial
  updateAccountsUI();
})();
