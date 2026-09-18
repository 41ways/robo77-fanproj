'use strict';
/**
 * 로보77 — 판 진행과 방 관리.
 *  - 손패 · 합 · 판정 · 타이머 · 봇은 전부 서버가 쥔다(권위 서버).
 *    클라이언트는 "이 카드 낼래" 만 보내고 나머지는 서버가 정한다.
 *  - 통신 방식은 모른다. 소켓은 send(문자열) · close() · readyState 만 있으면 된다.
 *    Node 서버(server.js)와 Cloudflare(worker.js)가 이 파일을 똑같이 쓴다.
 */
const R = require('./rules');

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TURN_LIMITS = [5000, 10000, 15000, 0];   // 0 = 무제한
// 테스트는 판을 빨리 돌려야 해서 ROBO_FAST=1 로 뜸을 들이지 않게 한다
const FAST = typeof process !== 'undefined' && !!process.env && process.env.ROBO_FAST === '1';
const ROUND_PAUSE = FAST ? 60 : 3000;          // 라운드가 끝나고 다음 판이 열리기까지
const OVER_PAUSE = FAST ? 40 : 1200;           // 게임 끝났을 때 (아래 readMs 로 늘어난다)

/* 왜 졌는지 읽을 시간.
   한글 짧은 문구는 눈에 들어오는 데 0.8초 + 글자당 0.07초쯤 걸린다.
   상수로 박아 두면 이름이 길거나 문장이 길 때 모자라므로 글자 수를 세서 정한다. */
function readMs(text, floor) {
  if (FAST) return floor;
  const n = String(text || '').replace(/\s/g, '').length;
  return Math.max(floor, 800 + n * 70);
}
const notePause = (room, floor) =>
  readMs((room.note ? room.note.name + room.note.text : ''), floor);
const DC_GRACE = FAST ? 200 : 4000;            // 접속 끊긴 사람 차례를 넘기기까지
const LOBBY_GRACE = FAST ? 300 : 20_000;       // 대기실에서 끊긴 자리를 비우기까지 (새로고침은 이 안에 돌아온다)

const BOT_NAMES = ['깐돌이', '알밤이', '토실이', '방울이', '뽀리', '멍구'];
// 봇이 너무 빨리 두면 "누구 차례인지 · 몇 장을 내야 하는지"가 읽히기 전에 바뀐다.
// 계측 결과 0.8초짜리 안내가 있어 하한을 1.2초로 올렸다. 사람이 생각하는 속도이기도 하다.
const BOT_THINK = FAST ? [5, 20] : [1200, 2200];
const BOT_THINK_X2 = [1900, 2700];

/* ─────────────────────────── 유틸 ─────────────────────────── */

const pick = a => a[Math.floor(Math.random() * a.length)];
const rnd = (min, max) => min + Math.random() * (max - min);
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const token = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)),
  b => b.toString(16).padStart(2, '0')).join('');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ─────────────────────────── 방 ─────────────────────────── */

const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => pick(alphabet.split(''))).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom({ priv = false } = {}) {
  const room = {
    code: makeCode(),
    phase: 'lobby',            // lobby | playing | over
    hostId: null,
    players: [],
    nextId: 1,

    cfg: { showSum: true, turnLimit: 10000, priv: !!priv },   // priv — 열린 방 목록에 안 띄운다(코드로는 들어온다)

    round: 0,
    sum: 0,
    dir: 1,                    // 1 = 자리 순서대로, -1 = 거꾸로
    turn: null,                // 지금 낼 차례인 player id
    due: 1,                    // 이번 차례에 남은 장수 (×2 를 받으면 2)
    pendingDue: 1,             // 다음 사람이 내야 할 장수
    firstOfRound: true,
    top: null,                 // 맨 위에 놓인 카드
    starter: null,             // 이번 라운드의 선
    deck: [],
    discard: [],

    turnEndsAt: 0,
    reveal: false,             // 라운드가 끝나 합을 까 보이는 중
    note: null,                // 지금 화면 가운데 띄울 안내
    winner: null,

    timers: { turn: null, round: null, bot: null, dc: null, stuck: null, host: null },
    lastActive: Date.now(),
    madeAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, { name, bot }) {
  const p = {
    id: room.nextId++,
    token: token(),
    name: name || `플레이어 ${room.nextId - 1}`,
    bot: !!bot,
    ws: null,
    connected: !!bot,
    hand: [],
    hearts: R.START_HEARTS,
    out: false,
  };
  room.players.push(p);
  if (!p.bot && room.hostId == null) room.hostId = p.id;
  return p;
}

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  // 다음 차례와 다음 라운드의 선은 빼기 전에 정한다. 빼고 나서 찾으면 나간 사람의 자리를 몰라
  // 0번 자리부터 세게 되어, 차례가 엉뚱한 사람에게 간다.
  const wasTurn = room.phase === 'playing' && room.turn === id;
  const nextTurn = wasTurn ? nextAlive(room, id) : null;
  if (room.starter === id) {
    const n = room.players.length;
    const prev = room.players[(i - 1 + n) % n];
    room.starter = prev && prev.id !== id ? prev.id : null;   // 다음 선 = 이 사람의 왼쪽 = 나간 사람의 왼쪽
  }
  const [gone] = room.players.splice(i, 1);
  clearTimeout(gone.leaveT);
  listChanged();
  if (gone.hand.length) room.discard.push(...gone.hand);

  if (room.hostId === gone.id) {
    const next = room.players.find(p => !p.bot && p.connected) || room.players.find(p => !p.bot);
    room.hostId = next ? next.id : null;
  }
  if (room.phase === 'playing') {
    if (wasTurn) {
      // 나간 사람 차례면 판이 멈추지 않게 다음으로 넘긴다
      room.turn = nextTurn !== id ? nextTurn : null;
      room.due = 1; room.pendingDue = 1;
      startTurn(room);
    }
    if (alive(room).length < MIN_PLAYERS) finish(room);
  }
}

/* ─────────────────────────── 차례 ─────────────────────────── */

const alive = room => room.players.filter(p => !p.out);

/** fromId 기준으로 방향을 따라 다음 생존자 */
function nextAlive(room, fromId) {
  const n = room.players.length;
  if (!n) return null;
  let i = room.players.findIndex(p => p.id === fromId);
  if (i < 0) i = 0;
  for (let step = 1; step <= n; step++) {
    const j = ((i + room.dir * step) % n + n) % n;
    if (!room.players[j].out) return room.players[j].id;
  }
  return null;
}

const playerOf = (room, id) => room.players.find(p => p.id === id) || null;

/** 손패가 5장이 되게 채운다. 덱이 비면 버린 더미를 섞어 다시 쓴다. */
function refill(room, p) {
  while (p.hand.length < R.HAND_SIZE) {
    if (!room.deck.length) {
      if (!room.discard.length) break;
      room.deck = shuffle(room.discard.splice(0, room.discard.length));
    }
    p.hand.push(room.deck.pop());
  }
}

/** 지금 이 사람이 낼 수 있는 카드가 하나라도 있나 */
function hasPlayable(room, p) {
  const st = { sum: room.sum, firstOfRound: room.firstOfRound };
  return p.hand.some(c => R.playable(c, st));
}

function startTurn(room) {
  clearTimeout(room.timers.stuck); room.timers.stuck = null;
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.bot); room.timers.bot = null;
  clearTimeout(room.timers.dc); room.timers.dc = null;

  const p = playerOf(room, room.turn);
  if (!p || p.out) { pushState(room); return; }

  // 낼 수 있는 카드가 하나도 없으면(라운드 첫 장인데 ×2·방향전환만 쥔 경우) 그대로 하트를 잃는다
  if (!hasPlayable(room, p)) {
    room.turnEndsAt = 0;
    pushState(room);
    room.timers.stuck = setTimeout(() => { if (room.phase === 'playing' && room.turn === p.id) endRound(room, p, 'stuck'); }, 900);
    return;
  }

  room.turnEndsAt = room.cfg.turnLimit ? Date.now() + room.cfg.turnLimit : 0;
  pushState(room);

  if (room.cfg.turnLimit) {
    room.timers.turn = setTimeout(() => {
      if (room.phase === 'playing' && room.turn === p.id) endRound(room, p, 'time');
    }, room.cfg.turnLimit + 250);
  }

  if (p.bot) {
    // ×2 를 맞은 차례는 안내가 길다("알밤이 차례 — 2장을 내야 해요", 읽는 데 1.7초쯤).
    // 1.2초 만에 내 버리면 무엇 때문에 두 장을 내는지 읽기 전에 안내가 바뀐다.
    const [lo, hi] = room.due === 2 && !FAST ? BOT_THINK_X2 : BOT_THINK;
    room.timers.bot = setTimeout(() => botMove(room, p.id), rnd(lo, hi));
  } else if (!p.connected) {
    room.timers.dc = setTimeout(() => {
      if (room.phase === 'playing' && room.turn === p.id) autoPlay(room, p);
    }, DC_GRACE);
  }
}

/* ─────────────────────────── 라운드 ─────────────────────────── */

function newRound(room, starterId) {
  room.round++;
  room.deck = shuffle(R.makeDeck());
  room.discard = [];
  room.sum = 0;
  room.dir = 1;
  room.due = 1;
  room.pendingDue = 1;
  room.firstOfRound = true;
  room.top = null;
  room.reveal = false;
  room.note = null;

  for (const p of room.players) { p.hand = []; if (!p.out) refill(room, p); }

  const living = alive(room);
  let s = playerOf(room, starterId);
  if (!s || s.out) s = living[0];
  room.starter = s ? s.id : null;
  room.turn = room.starter;
  startTurn(room);
}

const LOSS_TEXT = {
  bust:   sum => `합이 ${sum} — 77 이상이 됐다`,
  eleven: sum => `합이 ${sum} — 11의 배수를 밟았다`,
  time:   () => '시간 초과',
  stuck:  () => '낼 수 있는 카드가 없다',
};

/** 하트를 하나 잃고 라운드를 접는다. 하트가 없는 상태에서 잃으면 탈락. */
function endRound(room, p, reason) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.bot); room.timers.bot = null;
  clearTimeout(room.timers.dc); room.timers.dc = null;

  if (p.hearts > 0) p.hearts--;
  else p.out = true;

  room.reveal = true;   // 왜 죽었는지 보이도록 합을 깐다
  room.turn = null;     // 결과를 보는 동안은 아무의 차례도 아니다
  room.turnEndsAt = 0;
  room.note = { who: p.id, name: p.name, reason, text: LOSS_TEXT[reason](room.sum), out: p.out };
  ev(room, { kind: 'lose', by: p.id, reason, sum: room.sum, out: p.out });
  pushState(room);

  if (alive(room).length < MIN_PLAYERS) {
    // 마지막 라운드다. 여기서 결과 화면으로 서둘러 넘어가면
    // 왜 졌는지를 읽지 못한 채 판이 끝나 버린다.
    room.timers.round = setTimeout(() => finish(room), notePause(room, 2600));
    return;
  }

  // 다음 라운드의 선은 직전 선의 왼쪽 사람 (방향과 무관하게 자리 순서대로).
  // 결과를 보는 사이에 그 사람이 나갈 수 있으므로 라운드를 여는 순간에 정한다
  // (나간 선의 자리는 removePlayer 가 그 앞 사람으로 옮겨 두어, "왼쪽 사람"이 그대로 맞다).
  room.timers.round = setTimeout(() => {
    if (room.phase !== 'playing') return;
    const n = room.players.length;
    let i = room.players.findIndex(x => x.id === room.starter);
    if (i < 0) i = 0;
    let nextStarter = null;
    for (let step = 1; step <= n; step++) {
      const cand = room.players[(i + step) % n];
      if (!cand.out) { nextStarter = cand.id; break; }
    }
    newRound(room, nextStarter);
  }, notePause(room, ROUND_PAUSE));
}

function finish(room) {
  clearAll(room);
  room.phase = 'over';
  const left = alive(room);
  room.winner = left.length === 1 ? left[0].id : null;
  room.turn = null;
  room.turnEndsAt = 0;
  room.reveal = true;
  pushState(room);
}

/* ─────────────────────────── 카드 내기 ─────────────────────────── */

function playCard(room, p, cardId) {
  if (room.phase !== 'playing' || room.reveal) return;
  if (room.turn !== p.id) {
    // 내 차례가 아닌데 냈다 — 룰 2번
    if (!p.out) return send(p.ws, { t: 'err', msg: '아직 내 차례가 아니에요.' });
    return;
  }
  const i = p.hand.findIndex(c => c.id === cardId);
  if (i < 0) return;
  const card = p.hand[i];

  if (!R.playable(card, { sum: room.sum, firstOfRound: room.firstOfRound })) {
    return send(p.ws, { t: 'err', msg: '×2와 방향전환은 라운드 첫 장으로 낼 수 없어요.' });
  }

  p.hand.splice(i, 1);
  room.discard.push(card);
  room.top = card;
  room.firstOfRound = false;

  const res = R.resolve(card, { sum: room.sum, dir: room.dir });
  room.sum = res.sum;
  room.dir = res.dir;
  if (res.nextDue === 2) room.pendingDue = 2;

  refill(room, p);
  ev(room, { kind: 'play', by: p.id, card, sum: room.sum });

  if (res.lost) return endRound(room, p, res.lost);

  room.due--;
  if (room.due > 0) {           // ×2 를 맞아 아직 더 내야 한다
    startTurn(room);
  } else {
    room.turn = nextAlive(room, p.id);
    room.due = room.pendingDue;
    room.pendingDue = 1;
    startTurn(room);
  }
}

/** 접속이 끊긴 사람 대신 가장 무난한 카드를 낸다 */
function autoPlay(room, p) {
  const choice = chooseCard(room, p);
  if (choice) playCard(room, p, choice.id);
  else endRound(room, p, 'stuck');
}

/* ─────────────────────────── 봇 ─────────────────────────── */

/**
 * 봇의 수 고르기.
 *  1) 죽지 않는 수만 추린다
 *  2) 없으면 어차피 죽으니 아무거나 (76 자폭 포함 — 그게 이 게임의 맛)
 *  3) 남는 수 중에서는 합을 낮게 유지하고 특수 카드를 아끼는 쪽
 */
function chooseCard(room, p) {
  const st = { sum: room.sum, firstOfRound: room.firstOfRound };
  const legal = p.hand.filter(c => R.playable(c, st));
  if (!legal.length) return null;

  const scored = legal.map(c => {
    const res = R.resolve(c, { sum: room.sum, dir: room.dir });
    let score = 0;
    if (res.lost) score -= 1000;
    score -= res.sum * 1.2;                                   // 합은 낮을수록 좋다
    if (c.t === 'x2' || c.t === 'rev') score -= 14;           // 특수 카드는 아껴 둔다
    if (c.tag === 'minus') score -= room.sum < 33 ? 24 : 6;   // 여유 있을 때 쓰면 정작 위기에 없다
    if (c.tag === 'big' && room.sum < 40) score += 22;        // 큰 카드는 여유 있을 때 털어낸다
    if (c.tag === 's76') score -= 40;
    return { c, score: score + Math.random() * 6 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}

function botMove(room, id) {
  const p = playerOf(room, id);
  if (!p || room.phase !== 'playing' || room.turn !== id || room.reveal) return;
  const choice = chooseCard(room, p);
  if (choice) playCard(room, p, choice.id);
  else endRound(room, p, 'stuck');
}

/* ─────────────────────────── 통신 ─────────────────────────── */

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

/** 합을 지금 보여줘도 되나 — 토글이 꺼져 있으면 라운드가 끝날 때만 깐다 */
const sumVisible = room => room.cfg.showSum || room.reveal || room.phase === 'over';

function stateFor(room, me) {
  const st = { sum: room.sum, firstOfRound: room.firstOfRound };
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    cfg: room.cfg,
    max: MAX_PLAYERS,          // 인원 상한은 서버 값 하나만 쓴다 (화면 표기가 어긋나지 않게)
    min: MIN_PLAYERS,
    round: room.round,
    turn: room.turn,
    due: room.due,
    dir: room.dir,
    top: room.top,
    firstOfRound: room.firstOfRound,
    sum: sumVisible(room) ? room.sum : null,
    reveal: room.reveal,
    note: room.note,
    winner: room.winner,
    turnEndsAt: room.turnEndsAt,
    deck: room.deck.length,        // 화면에 덱을 그려 주려고 — 카드가 어디서 오는지 보이게
    discard: room.discard.length,
    now: Date.now(),
    you: me ? me.id : null,
    hand: me ? me.hand.map(c => Object.assign({ ok: R.playable(c, st) }, c)) : [],
    players: room.players.map(p => ({
      id: p.id, name: p.name, bot: p.bot, connected: p.connected,
      hearts: p.hearts, out: p.out, hand: p.hand.length,
    })),
  };
}

function pushState(room) {
  for (const p of room.players) if (!p.bot) send(p.ws, stateFor(room, p));
}
function broadcast(room, obj) {
  for (const p of room.players) if (!p.bot) send(p.ws, obj);
}
const ev = (room, obj) => broadcast(room, Object.assign({ t: 'ev' }, obj));

/* ─────────────────────────── 열린 방 목록 ───────────────────────────
   코드를 몰라도 들어올 수 있게, 방 고르기 화면을 보는 소켓(watchers)에 목록을 밀어 준다.
   방에 앉으면(attach) 명단에서 빠진다. 여러 번 바뀌어도 300ms 에 한 번만 보낸다. */

const watchers = new Set();
let listT = null;

function listChanged() {
  if (listT || !watchers.size) return;
  listT = setTimeout(() => { listT = null; pushList(); }, 300);
}

/** 비공개 방과 사람이 아무도 붙어 있지 않은 방은 뺀다. 들어갈 수 있는 방(wait)이 먼저, 그 안에서는 새 방이 먼저. */
function roomList() {
  const rs = [];
  for (const r of rooms.values()) {
    if (r.cfg.priv || !r.players.some(p => !p.bot && p.connected)) continue;
    const state = r.phase !== 'lobby' ? 'playing' : r.players.length >= MAX_PLAYERS ? 'full' : 'wait';
    rs.push({ r, state });
  }
  rs.sort((a, b) => (a.state === 'wait' ? 0 : 1) - (b.state === 'wait' ? 0 : 1) || b.r.madeAt - a.r.madeAt);
  const list = rs.slice(0, 20).map(({ r, state }) => {
    const host = playerOf(r, r.hostId);
    return { code: r.code, host: host ? host.name : '', n: r.players.length, max: MAX_PLAYERS, state };
  });
  return { t: 'rooms', list };
}

function pushList() {
  if (!watchers.size) return;
  const text = JSON.stringify(roomList());
  for (const ws of watchers) {
    if (ws.readyState !== 1) { watchers.delete(ws); continue; }
    try { ws.send(text); } catch (_) { watchers.delete(ws); }
  }
}

function clearAll(room) {
  clearTimeout(room.timers.stuck); room.timers.stuck = null;
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.round); room.timers.round = null;
  clearTimeout(room.timers.bot); room.timers.bot = null;
  clearTimeout(room.timers.dc); room.timers.dc = null;
}

/* ─────────────────────────── 메시지 처리 ─────────────────────────── */

function attach(room, p, ws) {
  clearTimeout(p.leaveT);
  watchers.delete(ws);           // 방에 들어왔으니 목록은 그만 받는다
  p.ws = ws; p.connected = true;
  // 방장이 자리를 비운 채면(모두 끊겼다 이 사람이 먼저 돌아온 경우 등) 돌아온 사람이 방장을 맡는다
  const host = playerOf(room, room.hostId);
  if (!host || (!host.connected && host !== p)) room.hostId = p.id;
  ws.roomCode = room.code; ws.playerId = p.id;
  send(ws, { t: 'welcome', you: p.id, token: p.token, code: room.code });
  pushState(room);
  listChanged();
}

/** 이 소켓이 이미 어느 자리에 앉아 있으면 거기서 떼어 낸다. create/join 을 연달아 받으면 앞 자리가
 *  소켓을 쥔 채 "접속 중" 으로 영영 남아서, 그 자리 차례에서 판이 멈추고 방도 치워지지 않았다. */
function detach(ws) {
  const room = rooms.get(ws.roomCode);
  if (room) {
    const p = playerOf(room, ws.playerId);
    if (p && p.ws === ws) {
      if (room.phase === 'lobby') {
        removePlayer(room, p.id);
        if (!room.players.some(x => !x.bot)) { clearAll(room); rooms.delete(room.code); }   // 빈 방은 곧바로 치운다
        else pushState(room);
      } else disconnect(ws);
    }
  }
  ws.roomCode = null; ws.playerId = null;
}

function handle(ws, msg) {
  if ((msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') && ws.roomCode) detach(ws);
  switch (msg.t) {
    // 열린 방 목록 구독 — 방 고르기 화면을 보는 동안만. 방에 앉아 있으면 받지 않는다.
    case 'rooms':
      if (!ws.roomCode) { watchers.add(ws); send(ws, roomList()); }
      return;
    case 'unwatch':
      watchers.delete(ws);
      return;
    case 'create': {
      const r = createRoom({ priv: msg.priv === true });
      const p = addPlayer(r, { name: clean(msg.name, 12) || '플레이어 1' });
      attach(r, p, ws);
      return;
    }
    case 'join': {
      const code = clean(msg.code, 8).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
      if (r.phase !== 'lobby') return send(ws, { t: 'err', msg: '이미 시작한 방이에요.' });
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
      const p = addPlayer(r, { name: clean(msg.name, 12) || `플레이어 ${r.players.length + 1}` });
      attach(r, p, ws);
      ev(r, { kind: 'joined', by: p.id });
      return;
    }
    case 'resume': {
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '방이 사라졌어요.', fatal: true });
      const p = r.players.find(x => x.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '자리를 찾을 수 없어요.', fatal: true });
      // 먼저 붙어 있던 소켓(복제한 탭 등)은 4001 로 닫는다. 그 탭은 스스로 다시 붙지 않으므로
      // 두 탭이 서로를 밀어내며 끝없이 다시 붙는 일이 없다.
      // 닫는 코드(4001)는 중간 프록시(예: Render)가 떨궈 버리기도 해서, 알림 메시지를 먼저 보낸다.
      if (p.ws && p.ws !== ws) { send(p.ws, { t: 'moved' }); try { p.ws.close(4001, 'moved'); } catch (_) {} }
      attach(r, p, ws);
      // 내 차례에 끊겼다 돌아왔으면 대신 내려던 예약만 거둔다. startTurn 을 다시 부르면
      // 제한시간이 처음부터 다시 돌아서, 새로고침만으로 시간을 무한히 벌 수 있었다.
      if (r.phase === 'playing' && r.turn === p.id) { clearTimeout(r.timers.dc); r.timers.dc = null; }
      return;
    }
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const me = playerOf(room, ws.playerId);
  if (!me) return;
  const isHost = room.hostId === me.id;
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'name':
      me.name = clean(msg.name, 12) || me.name;
      pushState(room);
      if (isHost) listChanged();
      break;

    case 'cfg': {
      if (!isHost || room.phase === 'playing') return;
      if (typeof msg.showSum === 'boolean') room.cfg.showSum = msg.showSum;
      if (TURN_LIMITS.includes(msg.turnLimit)) room.cfg.turnLimit = msg.turnLimit;
      if (typeof msg.priv === 'boolean' && msg.priv !== room.cfg.priv) { room.cfg.priv = msg.priv; listChanged(); }
      pushState(room);
      break;
    }

    case 'addBot': {
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '자리가 없어요.' });
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `봇 ${room.players.length + 1}`;
      addPlayer(room, { name, bot: true });
      pushState(room);
      listChanged();
      break;
    }

    case 'kick': {
      if (!isHost || room.phase === 'playing') return;
      const target = playerOf(room, msg.id);
      if (!target || target.id === room.hostId) return;
      if (target.ws) send(target.ws, { t: 'err', msg: '방장이 내보냈어요.', fatal: true });
      removePlayer(room, target.id);
      pushState(room);
      break;
    }

    case 'start': {
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length < MIN_PLAYERS) {
        return send(ws, { t: 'err', msg: '두 명은 있어야 시작할 수 있어요.' });
      }
      clearAll(room);
      room.phase = 'playing';
      room.round = 0;
      room.winner = null;
      for (const p of room.players) { p.hearts = R.START_HEARTS; p.out = false; p.hand = []; }
      newRound(room, room.players[0].id);
      listChanged();           // 시작한 방은 목록에서 '게임 중' 으로
      break;
    }

    case 'play':
      playCard(room, me, msg.id | 0);
      break;

    // 같은 방 사람끼리 하는 잡담. 판정에는 아무 영향이 없고 서버는 저장하지 않는다.
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const now = Date.now();
      if (now - (me.lastChat || 0) < 400) return;      // 도배 막기
      me.lastChat = now;
      broadcast(room, { t: 'chat', from: me.id, name: me.name, text });
      break;
    }

    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      clearAll(room);
      room.phase = 'lobby';
      room.winner = null;
      room.round = 0;
      room.top = null;
      room.reveal = false;
      room.note = null;
      room.turn = null;
      for (const p of room.players) { p.hearts = R.START_HEARTS; p.out = false; p.hand = []; }
      // 판 중에 떠난 사람은 대기실 떠나기 예약이 없어 다음 판에 유령 자리로 남았다
      for (const p of room.players) if (!p.bot && !p.connected) armLeave(room, p);
      pushState(room);
      listChanged();           // 다시 대기실 — 목록에서 다시 들어갈 수 있게
      break;
    }

    case 'leave':
      removePlayer(room, me.id);
      ws.roomCode = null; ws.playerId = null;
      send(ws, { t: 'left' });
      pushState(room);
      break;
  }
}

/** 대기실에서 끊긴 자리를 잠깐 뒤에 비운다 — 그 사이 돌아오면(attach) 취소된다 */
function armLeave(room, p) {
  clearTimeout(p.leaveT);
  p.leaveT = setTimeout(() => {
    if (p.connected || room.phase !== 'lobby' || rooms.get(room.code) !== room) return;
    removePlayer(room, p.id);
    pushState(room);
  }, LOBBY_GRACE);
}

/** 소켓이 닫혔다. 그 사이 같은 자리가 새 소켓으로 다시 붙었으면(새로고침) 건드리지 않는다.
 *  keepSeat — 서버가 스스로 끊은 경우(오래 조작 없음 · 소식 없음). 사람은 나간 게 아니라서
 *  대기실 자리를 지워 버리면 "누르면 다시 붙어요" 가 거짓말이 된다. 자리는 두고 방장만 넘긴다. */
function disconnect(ws, { keepSeat = false } = {}) {
  watchers.delete(ws);
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = playerOf(room, ws.playerId);
  if (!p || p.ws !== ws) return;
  p.connected = false; p.ws = null;
  listChanged();                             // 사람이 모두 끊긴 방은 목록에서 빠진다
  room.lastActive = Date.now();              // 빈 방 청소는 마지막 사람이 떠난 때부터 센다

  // 방장이 끊기면 잠깐 기다렸다가 붙어 있는 사람에게 넘긴다 — 판 중이든 끝난 뒤든.
  // 곧바로 넘기면 새로고침 한 번에 방장을 영영 잃는다. 안 넘기면 '시작'·'다시 하기'를 누를 사람이 없다.
  if (room.hostId === p.id) {
    clearTimeout(room.timers.host);
    room.timers.host = setTimeout(() => {
      const h = playerOf(room, room.hostId);
      if (h && h.connected) return;
      const next = room.players.find(x => !x.bot && x.connected);
      if (next) { room.hostId = next.id; pushState(room); }
    }, LOBBY_GRACE);
  }

  if (room.phase === 'lobby') {
    // 새로고침·앱 전환은 소켓이 먼저 닫히고 곧바로 다시 붙는다. 그 사이에 자리를 지우면
    // 돌아왔을 때 "자리를 찾을 수 없어요" 로 쫓겨난다. 잠깐 기다렸다가 그래도 없으면 뺀다.
    // 서버가 스스로 끊은 경우(keepSeat)는 사람이 나간 게 아니므로 자리를 그대로 둔다.
    clearTimeout(p.leaveT);
    if (!keepSeat) armLeave(room, p);
  } else if (room.phase === 'playing' && room.turn === p.id) {
    clearTimeout(room.timers.dc);
    room.timers.dc = setTimeout(() => {
      if (room.phase === 'playing' && room.turn === p.id) autoPlay(room, p);
    }, DC_GRACE);
  }
  pushState(room);
}

/** 사람이 다 떠난 방을 치운다. 통신 쪽이 30초마다 부른다.
 *  대기실에 자리만 남은 사람이 있으면(서버가 오래 조작 없는 연결을 닫은 경우) 10분까지 기다려 준다. */
function sweepRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    const seated = room.phase === 'lobby' && room.players.some(p => !p.bot);
    if (humans === 0 && now - room.lastActive > (seated ? 10 * 60_000 : 90_000)) {
      clearAll(room);
      rooms.delete(code);
    }
  }
}

/** 덱 구성이 어긋나면 게임 도중이 아니라 켤 때 바로 터지게 한다 */
function selfCheck() {
  const deck = R.makeDeck();
  if (deck.length !== 56) throw new Error(`덱이 ${deck.length}장입니다 (56장이어야 함)`);
  const by = {};
  for (const c of deck) by[c.tag] = (by[c.tag] || 0) + 1;
  const want = { plain: 32, zero: 4, big: 6, s76: 1, minus: 4, x2: 4, rev: 5 };
  for (const k of Object.keys(want)) {
    if (by[k] !== want[k]) throw new Error(`${k} 카드가 ${by[k] || 0}장입니다 (${want[k]}장이어야 함)`);
  }
  if (MAX_PLAYERS * R.HAND_SIZE > deck.length) throw new Error('최대 인원의 손패가 덱보다 많습니다');
  console.log(`  카드 ${deck.length}장 · 최대 ${MAX_PLAYERS}인 · 하트 ${R.START_HEARTS}개`);
}

module.exports = { rooms, handle, disconnect, sweepRooms, selfCheck, MAX_PLAYERS };
