'use strict';
/**
 * 로보77 — 클라이언트
 * 판정은 전부 서버가 한다. 여기서는 화면을 그리고 "이 카드 낼래" 만 보낸다.
 */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ─────────────────────────── 상태 ─────────────────────────── */

let ws = null;
let me = null;            // 내 player id
let S = null;             // 마지막으로 받은 state
let lastSum = 0;
let skew = 0;             // 서버 시계와의 차이
const store = window.sessionStorage;

/* 계측 도구(qa/scene.js)가 상태를 들여다볼 수 있게 최소한만 내놓는다 */
window.__S = () => S;
Object.defineProperty(window, '__me', { get: () => me });

/* ─────────────────────────── 접속 ─────────────────────────── */

/* 서버(Cloudflare 무료 플랜)는 켜져 있는 시간이 한도라서,
   20분 동안 아무 조작이 없으면 서버가 연결을 닫는다(4000). 그때는 스스로 다시 붙지 않고
   화면을 다시 만질 때 이어 붙는다. 켜 두기만 한 탭이 서버를 붙잡아 두지 않게. */
let pingT = null, resting = false, wokeUp = false;

function resume() {
  connect(() => {
    const code = store.getItem('code'), token = store.getItem('token');
    if (code && token) send({ t: 'resume', code, token });
  });
}

let restWhy = 0;
function wake(e) {
  if (!resting) return;
  if (e.type === 'visibilitychange' && (document.hidden || restWhy === 4001)) return;   // 넘겨준 자리는 눌러서만 되찾는다
  resting = false;
  $('#toast').classList.remove('on');
  if (store.getItem('code') && store.getItem('token')) { wokeUp = true; resume(); }
}
['pointerdown', 'keydown'].forEach(t => addEventListener(t, wake, true));
document.addEventListener('visibilitychange', wake);

function connect(onOpen) {
  if (ws && ws.readyState === 1) { onOpen && onOpen(); return; }
  // 붙는 중이던 옛 소켓(만들기 연타 등)은 손을 떼고 닫는다. 그대로 두면 나중에 그게 닫힐 때
  // 지금 소켓의 ping 을 꺼 버려서, 멀쩡한 연결이 75초 뒤 끊긴 것으로 처리된다.
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch (_) {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    if (sock !== ws) return;
    clearInterval(pingT);
    pingT = setInterval(() => send({ t: 'ping' }), 25_000);   // 서버가 끊긴 탭을 가려낼 수 있게
    onOpen && onOpen();
  };
  ws.onmessage = e => {
    if (sock !== ws) return;
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.t === 'moved' || m.t === 'idle') {             // 곧 닫힌다 — 닫힘 코드가 중간에 떨어져도 알 수 있게
      sock.why = m.t;
      sock.onclose({ code: m.t === 'moved' ? 4001 : 4000 });   // 닫힘이 늦게 오거나 안 와도 여기서 멈춘다
      ws = null;
      try { sock.close(); } catch (_) {}
      return;
    }
    handle(m);
  };
  ws.onclose = e => {
    if (sock !== ws) return;
    clearInterval(pingT);
    const code = sock.why === 'moved' ? 4001 : sock.why === 'idle' ? 4000 : e.code;
    // 4000: 오래 조작이 없어 서버가 닫음 · 4001: 다른 탭이 이 자리를 이어받음(탭 복제 등)
    // 둘 다 스스로 다시 붙지 않는다 — 붙으면 서로를 밀어내며 끝없이 오간다. 누를 때 다시 붙는다.
    if (code === 4000 || code === 4001) {
      resting = true; restWhy = code;
      const t = $('#toast');
      t.textContent = code === 4000
        ? '한동안 조작이 없어서 연결을 쉬고 있어요. 아무 곳이나 누르면 다시 붙어요.'
        : '다른 창에서 이 자리를 이어받았어요. 여기서 계속하려면 아무 곳이나 누르세요.';
      t.classList.add('on');
      clearTimeout(toastT);                    // 누를 때까지 떠 있게
      return;
    }
    if (store.getItem('code') && store.getItem('token')) {
      toast('연결이 끊겼어요. 다시 붙는 중…');
      setTimeout(() => connect(() => send({
        t: 'resume', code: store.getItem('code'), token: store.getItem('token'),
      })), 1200);
    } else {
      show('title');
    }
  };
}

const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

let leaving = false;          // 끊긴 채 나가느라 잠깐 붙은 동안 — 대기실 화면이 번쩍 뜨지 않게 흘려보낸다
function handle(m) {
  if (leaving) {
    if (m.t !== 'left' && m.t !== 'err') return;          // 떠나는 방의 상태·채팅은 받지 않는다
    leaving = false;
    if (m.t === 'err') return;
  }
  switch (m.t) {
    case 'welcome':
      wokeUp = false; entering = 0;
      if (m.code !== chatRoom) { chatRoom = m.code; chatReset(); }   // 다른 방이면 채팅을 비운다
      me = m.you;
      store.setItem('code', m.code);
      store.setItem('token', m.token);
      history.replaceState(null, '', `?r=${m.code}`);
      break;

    case 'chat':
      addChat(m.name, m.text, m.from === me);
      break;

    case 'state':
      if (S && (S.round !== m.round || S.phase !== m.phase)) handEls.clear();
      countGame(m);            // S 를 덮기 전에 — 직전 phase 가 있어야 전이를 잡는다
      S = m;
      me = m.you != null ? m.you : me;
      if (m.now) skew = m.now - Date.now();   // 서버 시계에 맞춰 남은 시간을 센다
      render();
      break;

    case 'ev':
      if (m.kind === 'joined' && m.by !== me) toast('누가 들어왔어요');
      break;

    case 'err':
      entering = 0;
      // 오래 쉬다 돌아왔는데 그사이 방이 정리된 경우 — 무엇 때문인지 알려 준다
      toast(m.fatal && wokeUp ? '오래 비워 둔 사이 방이 정리됐어요. 새로 만들어 주세요.' : m.msg);
      if (m.fatal) { store.removeItem('code'); store.removeItem('token'); show('title'); }
      wokeUp = false;
      break;

    case 'left':
      store.removeItem('code'); store.removeItem('token');
      history.replaceState(null, '', location.pathname);
      show('title');
      break;
  }
}

/* ─────────────────────────── 화면 ─────────────────────────── */

function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  // 방 밖에서는 채팅이 갈 곳이 없다 — 버튼과 창을 접고 전 방의 말도 비운다
  if (id === 'title' || id === 'setup') { chatRoom = null; chatReset(); $('#chatBtn').hidden = true; }
}

let toastT = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 2400);
}

/* 카드 한 장의 겉모습 */
function cardFace(c) {
  if (c.t === 'x2')  return { cls: 'x2',  v: '×2', n: '다음 2장' };
  if (c.t === 'rev') return { cls: 'rev', v: '↺',  n: '방향전환' };
  if (c.tag === 'minus') return { cls: 'minus', v: '-10', n: '빼기' };
  if (c.tag === 's76')   return { cls: 's76',   v: '76',  n: '76 더하기' };
  if (c.tag === 'big')   return { cls: 'big',   v: String(c.v), n: '11의 배수' };
  if (c.tag === 'zero')  return { cls: 'zero',  v: '0',   n: '그대로' };
  return { cls: 'plain', v: String(c.v), n: '' };
}

function cardEl(c, { button = false, disabled = false } = {}) {
  const f = cardFace(c);
  const el = document.createElement(button ? 'button' : 'div');
  el.className = `card ${f.cls}`;
  if (button) { el.disabled = disabled; el.dataset.id = c.id; }
  el.innerHTML = `<span class="v">${f.v}</span>${f.n ? `<span class="n">${f.n}</span>` : ''}`;
  return el;
}

const heartsHTML = h => {
  let s = '';
  for (let i = 0; i < 3; i++) s += `<span class="${i < h ? 'on' : 'off'}">♥</span>`;
  return s;
};

/* ─────────────────────────── 채팅 ───────────────────────────
   같은 방 사람끼리만 오간다. 판정과는 무관하고 어디에도 저장되지 않는다.
   봇만 있는 방에서는 아예 뜨지 않는다. */

let chatUnread = 0;
let chatRoom = null;       // 지금 채팅이 속한 방 — 방이 바뀌면 이전 방의 말을 들고 가지 않는다

/** 새 방에 들어오면 채팅을 비운다. 안 그러면 전 방에서 오간 말이 새 방 채팅창에 그대로 남는다. */
function chatReset() {
  $('#chatLog').textContent = '';
  $('#chat').hidden = true;
  chatUnread = 0; chatBadge(); chatPeekOff();
  chatAway = 0; chatTitle();
}

function chatOpen(on) {
  $('#chat').hidden = !on;
  if (!on) return;
  chatUnread = 0; chatBadge(); chatPeekOff();
  $('#chatText').focus();
  const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
}

function addChat(name, text, mine) {
  const log = $('#chatLog');
  const d = document.createElement('p');
  d.className = 'chat-msg' + (mine ? ' mine' : '');
  d.innerHTML = `<b>${esc(name)}</b> ${esc(text)}`;
  log.appendChild(d);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;

  if (mine) return;
  if ($('#chat').hidden) { chatUnread++; chatBadge(); chatPeek(name, text); }
  if (document.hidden || !document.hasFocus()) { chatAway++; chatTitle(); }
}

/* 접어 둔 동안 온 말은 세 군데로 알린다 — 버튼의 빨간 숫자(늘 때마다 통 튄다),
   버튼 옆 말풍선(읽을 만큼 떠 있다 사라진다), 다른 탭·창에 가 있으면 탭 제목 앞의 (n). */
let chatAway = 0, chatPeekT = 0;
const chatTitle0 = document.title;

function chatBadge() {
  const n = $('#chatN');
  n.textContent = chatUnread > 99 ? '99+' : chatUnread;
  n.hidden = !chatUnread;
  $('#chatBtn').setAttribute('aria-label', chatUnread ? `채팅 열기 — 안 읽은 말 ${chatUnread}개` : '채팅 열기');
  if (!chatUnread) return;
  n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop');
}

function chatPeek(name, text) {
  const p = $('#chatPeek');
  p.innerHTML = `<b>${esc(name)}</b>${esc(text)}`;
  p.classList.remove('bye'); p.hidden = false;
  p.style.animation = 'none'; void p.offsetWidth; p.style.animation = '';
  clearTimeout(chatPeekT);
  chatPeekT = setTimeout(() => {
    p.classList.add('bye');
    chatPeekT = setTimeout(chatPeekOff, 260);
  }, Math.min(6000, Math.max(3000, 1200 + 70 * text.length)));
}

function chatPeekOff() {
  clearTimeout(chatPeekT);
  const p = $('#chatPeek'); p.hidden = true; p.classList.remove('bye');
}

function chatTitle() {
  document.title = (chatAway ? `(${chatAway > 99 ? '99+' : chatAway}) ` : '') + chatTitle0;
}

function chatBack() {
  if (chatAway && !document.hidden && document.hasFocus()) { chatAway = 0; chatTitle(); }
}
document.addEventListener('visibilitychange', chatBack);
window.addEventListener('focus', chatBack);

/** 사람이 나 말고 또 있을 때만 채팅을 내놓는다 */
function syncChatVisible() {
  const humans = S ? S.players.filter(p => !p.bot).length : 0;
  const on = humans > 1;
  $('#chatBtn').hidden = !on;
  if (!on) { $('#chat').hidden = true; chatPeekOff(); }
  else $('#chatWho').textContent = `${humans}명`;
}

$('#chatBtn').onclick = () => chatOpen($('#chat').hidden);
$('#chatPeek').onclick = () => chatOpen(true);
$('#chatX').onclick = () => chatOpen(false);
$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const box = $('#chatText');
  const text = box.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  box.value = '';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#chat').hidden) chatOpen(false);
});

/* ─────────────────────────── 그리기 ─────────────────────────── */

/* 판 수 세기 — 방장 화면에서만 보낸다. 사람마다 보내면 한 판이 인원수만큼 세어진다. */
let gameAt = 0;
function countGame(m) {
  const my = m.you != null ? m.you : me;
  if (!window.norara || !m.players || m.hostId !== my) return;
  const humans = m.players.filter(p => !p.bot).length;
  if (m.phase === 'playing' && (!S || S.phase !== 'playing')) {
    gameAt = Date.now();
    norara.ev('start', { n: humans });
  } else if (m.phase === 'over' && (!S || S.phase !== 'over') && gameAt) {
    norara.ev('end', { n: humans, sec: Math.round((Date.now() - gameAt) / 1000) });
    gameAt = 0;
  }
}

function render() {
  if (!S) return;
  syncChatVisible();
  if (S.phase === 'lobby') { show('lobby'); renderLobby(); }
  else if (S.phase === 'playing') { show('game'); renderGame(); }
  else if (S.phase === 'over') { show('over'); renderOver(); }
}

function renderLobby() {
  $('#lCode').textContent = S.code;
  $('#lCount').textContent = `${S.players.length} / ${S.max}명`;
  const isHost = S.hostId === me;

  const ul = $('#lPlayers');
  ul.innerHTML = '';
  for (const p of S.players) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="av">${esc((p.name || '?').slice(0, 1))}</span>
      <span class="nm">${esc(p.name)}</span>
      ${p.id === S.hostId ? '<span class="badge host">방장</span>' : ''}
      ${p.bot ? '<span class="badge">봇</span>' : ''}
      ${!p.bot && !p.connected ? '<span class="badge off">끊김</span>' : ''}
      ${p.id === me ? '<span class="badge">나</span>' : ''}`;
    if (isHost && p.id !== S.hostId) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = '내보내기';
      x.onclick = () => send({ t: 'kick', id: p.id });
      li.appendChild(x);
    }
    ul.appendChild(li);
  }

  $('#lHostBox').classList.toggle('hidden', !isHost);
  $('#lWait').classList.toggle('hidden', isHost);

  $('#tSum').setAttribute('aria-checked', String(S.cfg.showSum));
  $('#sumDesc').textContent = S.cfg.showSum
    ? '합이 화면에 뜬다. 처음이라면 켜 두는 쪽.'
    : '합이 안 보인다. 나온 카드를 보고 직접 세야 한다.';
  $$('#segTime button').forEach(b => b.classList.toggle('on', Number(b.dataset.ms) === S.cfg.turnLimit));

  $('#bStart').disabled = S.players.length < S.min;
  $('#bBot').disabled = S.players.length >= S.max;
}

/* ── 카드가 오가는 모습 ──
   손패를 통째로 다시 그리면 낸 카드도 뽑은 카드도 그냥 "생겨난다".
   id 로 맞춰서 남아 있는 카드는 그대로 두고, 나간 카드는 더미로 날려 보내고,
   새로 들어온 카드는 덱에서 뽑혀 오게 한다. */

const handEls = new Map();     // 카드 id -> 화면 요소
let landAt = 0;                // 날아가는 카드가 더미에 닿는 시각
let topTimer = null;

function renderTop() {
  const top = $('#gTop');
  const draw = () => {
    top.innerHTML = '';
    // 빈 더미를 카드 뒷면으로 그리면 옆의 덱과 똑같이 보여 헷갈린다.
    top.appendChild(S.top ? cardEl(S.top) : Object.assign(document.createElement('div'), {
      className: 'slot-empty', textContent: '아직 없음',
    }));
  };
  clearTimeout(topTimer);
  const wait = landAt - Date.now();
  // 날아가는 카드와 더미 위의 카드가 동시에 보이면 같은 장이 둘로 보인다.
  if (wait > 0) topTimer = setTimeout(draw, wait);
  else draw();
}

/** 왜 지금 못 내는지 — 로보77에서 막히는 경우는 둘뿐이다 */
function whyNotPlayable(c) {
  if (c.t === 'x2')  return '라운드 첫 장으로는 ×2를 낼 수 없어요.';
  if (c.t === 'rev') return '라운드 첫 장으로는 방향전환을 낼 수 없어요.';
  return '지금은 낼 수 없는 카드예요.';
}

function renderHand(myTurn) {
  const wrap = $('#gHand');
  wrap.classList.toggle('off', !myTurn);

  // 손에 카드가 없을 때 — 탈락했거나 라운드 사이다.
  // 자리를 통째로 비워 두면 화면 아래가 허전하니, 남은 사람들의 손패를 뒷면으로 보여 준다.
  if (!S.hand.length) {
    handEls.clear();
    const alive = S.players.filter(p => !p.out);
    wrap.innerHTML =
      '<div class="watch">' +
      alive.map(p =>
        '<div class="watch-p' + (p.id === S.turn ? ' now' : '') + '">' +
        '<p class="watch-n">' + esc(p.name) + '</p>' +
        '<div class="watch-c">' + '<i></i>'.repeat(Math.min(p.hand, 8)) + '</div>' +
        '</div>').join('') +
      '</div>';
    return;
  }
  if (wrap.querySelector('.watch')) wrap.innerHTML = '';

  const now = new Set(S.hand.map(c => c.id));
  for (const [id, el] of Array.from(handEls)) {
    if (now.has(id)) continue;
    handEls.delete(id);
    flyToPile(el);
  }

  let fresh = 0;
  for (const c of S.hand) {
    let el = handEls.get(c.id);
    if (!el) {
      el = cardEl(c, { button: true });
      // 낼 수 없는 카드도 눌리게 두고 왜 안 되는지 말해 준다.
      // 회색 카드를 눌렀는데 아무 반응이 없으면 규칙을 배울 길이 없다.
      // 손패 요소는 여러 판에 걸쳐 재사용되므로, 누른 순간의 상태를 다시 읽는다.
      el.onclick = () => {
        if (!S) return;
        const cur = S.hand.find(x => x.id === c.id);
        const mine = S.turn === me && !S.reveal;
        if (!cur || !mine) return;                 // 남의 차례에는 조용히
        if (cur.ok) { send({ t: 'play', id: cur.id }); return; }
        toast(whyNotPlayable(cur));
      };
      el.classList.add('dealt');
      el.style.setProperty('--dl', (fresh++ * 70) + 'ms');
      // 연출이 끝나면 표시를 지운다 — 남겨 두면 상태가 지저분해진다
      el.addEventListener('animationend', () => el.classList.remove('dealt'), { once: true });
      handEls.set(c.id, el);
    }
    // disabled 를 걸면 클릭 자체가 안 잡혀 이유를 말해 줄 수 없다.
    // 보이기는 똑같이 흐리게 두되, 누를 수는 있게 한다.
    el.disabled = false;
    const canPlay = myTurn && c.ok;
    el.classList.toggle('cant', !canPlay);
    el.setAttribute('aria-disabled', String(!canPlay));
    wrap.appendChild(el);                 // 이미 있으면 자리만 옮긴다
  }

  // 라운드가 바뀌어 기억을 비웠을 때 남아 있던 낱장을 치운다
  const keep = new Set(handEls.values());
  for (const child of Array.from(wrap.children)) if (!keep.has(child)) child.remove();
}

function flyToPile(el) {
  const from = el.getBoundingClientRect();
  const slot = $('#gTop').getBoundingClientRect();
  el.remove();
  if (!from.width || !slot.width) return;

  const g = el.cloneNode(true);
  g.classList.remove('dealt');
  g.classList.add('flying');
  g.disabled = true;
  g.style.cssText = 'position:fixed;margin:0;left:' + from.left + 'px;top:' + from.top +
                    'px;width:' + from.width + 'px;height:' + from.height + 'px';
  document.body.appendChild(g);

  const dx = (slot.left + slot.width / 2) - (from.left + from.width / 2);
  const dy = (slot.top + slot.height / 2) - (from.top + from.height / 2);
  const sc = slot.width / from.width;
  const MS = 380;
  landAt = Date.now() + MS - 40;          // 도착 직전에 더미를 바꾼다
  requestAnimationFrame(() => {
    g.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ') rotate(5deg)';
  });
  setTimeout(() => g.remove(), MS + 40);
}

function renderGame() {
  $('#gRound').textContent = `${S.round}라운드`;
  $('#gDir').textContent = S.dir === 1 ? '↻ 정방향' : '↺ 역방향';

  // ×2 로 생긴 "몇 장 내야 함"은 한 사람 차례로 끝나지 않고 이어지는 의무다.
  // 안내 한 줄에 끼워 넣으면 차례가 바뀔 때마다 같이 사라져 읽히지 않는다. 따로 세워 둔다.
  const due = $('#gDue');
  if (due) {
    const on = S.due > 1;
    due.hidden = !on;
    // 좁은 화면에서는 긴 문구가 윗줄을 두 줄로 밀어 ×2 차례마다 판이 출렁였다
    if (on) due.textContent = innerWidth <= 560 ? `×2 · ${S.due}장` : `×2 — ${S.due}장 내야 함`;
  }

  // 자리 — 나를 맨 앞으로 돌려서 순서를 읽기 쉽게 한다
  const list = S.players.slice();
  const i = list.findIndex(p => p.id === me);
  const ordered = i >= 0 ? list.slice(i).concat(list.slice(0, i)) : list;

  const seats = $('#seats');
  seats.innerHTML = '';
  for (const p of ordered) {
    const el = document.createElement('div');
    el.className = 'seat'
      + (p.id === S.turn ? ' turn' : '')
      + (p.out ? ' out' : '')
      + (p.id === me ? ' me' : '');
    el.innerHTML = `
      <span class="av">${esc((p.name || '?').slice(0, 1))}</span>
      <div class="col">
        <p class="nm">${esc(p.name)}${p.id === me ? ' (나)' : ''}</p>
        <p class="hearts">${p.out ? '<span class="off">탈락</span>' : heartsHTML(p.hearts)}</p>
        <p class="mini-hand" title="손패 ${p.hand}장">${'<i></i>'.repeat(p.hand)}</p>
        ${!p.bot && !p.connected && !p.out ? '<p class="dc">접속 끊김</p>' : ''}
      </div>`;
    seats.appendChild(el);
  }

  // 합
  const sumEl = $('#gSum');
  if (S.sum == null) {
    sumEl.textContent = '?';
    sumEl.className = 'sum hide';
  } else {
    sumEl.textContent = String(S.sum);
    sumEl.className = 'sum' + (S.sum >= 67 ? ' danger' : '');
    if (S.sum !== lastSum) { sumEl.classList.add('pop'); setTimeout(() => sumEl.classList.remove('pop'), 320); }
    lastSum = S.sum;
  }

  // 덱 — 카드가 어디서 오는지 보이게
  const deckEl = $('#gDeck');
  if (deckEl) {
    deckEl.querySelector('.deck-n').textContent = S.deck != null ? S.deck : '';
    deckEl.classList.toggle('empty', S.deck === 0);
  }

  // 손패를 먼저 그린다.
  // 여기서 낸 카드가 날아가기 시작해야, 그 다음 renderTop 이 도착 시각을 알고 기다린다.
  // 순서가 반대면 더미에 카드가 먼저 뜨고 같은 장이 공중에도 떠 있어 둘로 보인다.
  const mine = S.players.find(p => p.id === me);
  const myTurn = S.turn === me && !S.reveal;
  renderHand(myTurn);

  // 맨 위 카드 — 날아가는 카드가 도착한 뒤에 바꾼다
  renderTop();

  // 안내 한 줄
  const cur = S.players.find(p => p.id === S.turn);
  let hint;
  if (mine && mine.out) hint = '탈락했어요. 남은 판을 구경하는 중.';
  else if (myTurn) {
    hint = S.due > 1 ? `<b>내 차례</b> — ×2를 받아서 ${S.due}장을 내야 해요`
                     : '<b>내 차례</b> — 카드를 한 장 고르세요';
    if (S.firstOfRound) hint += ' · 라운드 첫 장이라 ×2·방향전환은 못 내요';
  } else if (cur) {
    hint = `${esc(cur.name)} 차례` + (S.due > 1 ? ` — ${S.due}장을 내야 해요` : '');
  } else hint = '';
  $('#gHint').innerHTML = hint;

  // 라운드 결과
  const note = $('#gNote');
  if (S.note && S.reveal) {
    note.classList.remove('hidden');
    note.querySelector('.note-title').textContent =
      `${S.note.name} ${S.note.out ? '탈락!' : '하트 -1'}`;
    note.querySelector('.note-sub').textContent =
      S.note.text + (S.note.out ? '' : ' · 곧 새 라운드가 시작돼요');
  } else {
    note.classList.add('hidden');
  }
}

function renderOver() {
  $('#gNote').classList.add('hidden');
  const w = S.players.find(p => p.id === S.winner);
  $('#oWinner').textContent = w ? `${w.name} 승리` : '게임 끝';
  $('#oSub').textContent = w && w.id === me ? '끝까지 살아남았어요.' : `${S.round}라운드까지 갔어요.`;
  $('#bAgain').classList.toggle('hidden', S.hostId !== me);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ─────────────────────────── 타이머 링 ─────────────────────────── */

const RING = 2 * Math.PI * 54;

function tick() {
  requestAnimationFrame(tick);
  const fg = $('.ring-fg');
  if (!S || S.phase !== 'playing' || !S.turnEndsAt || S.reveal) {
    fg.style.opacity = '0';   // 무제한이면 링 자체를 지운다 (끝점 점이 남지 않게)
    hideClock();              // 안 지우면 마지막 숫자가 얼어붙은 채 남는다
    return;
  }
  fg.style.opacity = '1';
  const total = S.cfg.turnLimit || 1;
  const left = Math.max(0, S.turnEndsAt - (Date.now() + skew));
  const p = Math.min(1, left / total);
  fg.style.strokeDashoffset = String(RING * (1 - p));
  fg.classList.toggle('warn', p <= .5 && p > .25);
  fg.classList.toggle('hot', p <= .25);

  // 링은 판 한가운데에 있는데, 내 차례에는 눈이 아래 손패에 가 있다.
  // 시간이 끝나가는 걸 못 보고 하트를 잃지 않도록 손패 바로 위에도 남은 초를 둔다.
  const clock = $('#gClock');
  const mine = S.turn === me && !S.reveal;
  if (mine && S.cfg.turnLimit) {
    const sec = Math.max(0, Math.ceil(left / 1000));
    if (clock.dataset.s !== String(sec)) { clock.dataset.s = String(sec); clock.textContent = sec + '초'; }
    clock.hidden = false;
    clock.classList.toggle('warn', p <= .5 && p > .25);
    clock.classList.toggle('hot', p <= .25);
  } else {
    hideClock();
  }
}

function hideClock() {
  const c = $('#gClock');
  if (!c || c.hidden) return;
  c.hidden = true;
  c.dataset.s = '';
  c.classList.remove('warn', 'hot');
}
requestAnimationFrame(tick);

/* ─────────────────────────── 테마 ─────────────────────────── */

/** 라이트가 기본. 고른 값은 다음에 와도 그대로 남는다. */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (_) {}
  const light = t !== 'dark';
  $('#tTheme').setAttribute('aria-checked', String(light));
  $$('[data-theme-toggle]').forEach(b => { b.textContent = light ? '☾' : '☀'; });
}
const curTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const flipTheme = () => setTheme(curTheme() === 'dark' ? 'light' : 'dark');

$('#tTheme').onclick = flipTheme;
$$('[data-theme-toggle]').forEach(b => { b.onclick = flipTheme; });

/* ─────────────────────────── 조작 ─────────────────────────── */

const myName = () => ($('#gName').value || '').trim().slice(0, 12);

$('#bBegin').onclick = () => {
  show('setup');
  setTimeout(() => $('#gName').focus(), 60);
};
$('#bBack').onclick = () => show('title');

// 만들기·참가를 연달아 누르면(더블탭 · Enter 와 클릭) 자리가 둘 생긴다. 답이 올 때까지 한 번만 보낸다.
let entering = 0;
function enter(msg) {
  if (Date.now() - entering < 4000) return;
  entering = Date.now();
  store.removeItem('code'); store.removeItem('token');
  localStorage.setItem('name', myName());
  connect(() => send(msg));
}
$('#bCreate').onclick = () => enter({ t: 'create', name: myName() });

function doJoin() {
  const code = ($('#gCode').value || '').trim().toUpperCase();
  if (code.length !== 4) return toast('네 글자 코드를 넣어 주세요.');
  enter({ t: 'join', code, name: myName() });
}
$('#bJoin').onclick = doJoin;
$('#gCode').onkeydown = e => { if (e.key === 'Enter') doJoin(); };
$('#gName').onkeydown = e => { if (e.key === 'Enter') $('#bCreate').click(); };

$('#bCopy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?r=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요'); }
  catch (_) { toast(url); }
};

$('#tSum').onclick = () => send({ t: 'cfg', showSum: S.cfg.showSum !== true });
$$('#segTime button').forEach(b => {
  b.onclick = () => send({ t: 'cfg', turnLimit: Number(b.dataset.ms) });
});
$('#bBot').onclick = () => send({ t: 'addBot' });
$('#bStart').onclick = () => send({ t: 'start' });
$('#bAgain').onclick = () => send({ t: 'again' });

const leave = () => {
  const code = store.getItem('code'), token = store.getItem('token');
  store.removeItem('code'); store.removeItem('token');
  resting = false; wokeUp = false;
  $('#toast').classList.remove('on');
  if (ws && ws.readyState === 1) send({ t: 'leave' });
  else if (code && token) {
    // 끊겨 있으면 잠깐 붙어서 자리를 비우고 나온다. 안 그러면 서버에는 자리가 그대로 남는다.
    leaving = true;
    connect(() => { send({ t: 'resume', code, token }); send({ t: 'leave' }); });
  }
  history.replaceState(null, '', location.pathname);
  show('title');
};
$('#bLeave1').onclick = leave;
$('#bLeave2').onclick = () => { if (confirm('정말 나갈까요?')) leave(); };
$('#bLeave3').onclick = leave;

/* 도움말 */
const openHelp = () => $('#help').classList.remove('hidden');
$$('[data-help]').forEach(b => b.onclick = openHelp);
$('#bHelpX').onclick = () => $('#help').classList.add('hidden');
$('#help').onclick = e => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('#help').classList.add('hidden');
  // 글을 치는 중에는 단축키로 받지 않는다 — 채팅에 "?" 를 치면 도움말이 열렸다
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) openHelp();
});
$$('#helpTabs button').forEach(b => {
  b.onclick = () => {
    $$('#helpTabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tabpage').forEach(p => p.classList.toggle('on', p.dataset.page === b.dataset.tab));
  };
});

/* 숫자키로도 카드를 낼 수 있게 */
document.addEventListener('keydown', e => {
  if (!S || S.phase !== 'playing' || S.turn !== me || S.reveal) return;
  if (e.target.tagName === 'INPUT') return;
  const n = Number(e.key);
  if (!n || n < 1 || n > S.hand.length) return;
  const c = S.hand[n - 1];
  if (c && c.ok) send({ t: 'play', id: c.id });
});

/* ─────────────────────────── 시작 ─────────────────────────── */

setTheme(localStorage.getItem('theme') || 'light');
$('#gName').value = localStorage.getItem('name') || '';

const invited = new URLSearchParams(location.search).get('r');
if (invited) $('#gCode').value = invited.toUpperCase().slice(0, 4);

// 새로고침해도 자리를 지킨다
if (store.getItem('code') && store.getItem('token')) {
  connect(() => send({ t: 'resume', code: store.getItem('code'), token: store.getItem('token') }));
} else if (invited) {
  show('setup');   // 초대 링크로 왔으면 코드가 채워진 채로 바로 방 고르기
} else {
  show('title');
}
