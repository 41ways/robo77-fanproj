'use strict';
/**
 * 관전자 — node test/spectate.js
 * 서버를 띄우지 않고 game.js 에 가짜 소켓을 붙여 본다 (Node 서버와 Cloudflare 가 같은 모양으로 붙는다).
 *  - 시작했거나 가득 찬 방에 들어오면 관전자 · 관전을 막은 방은 지금처럼 거절
 *  - 관전자의 게임 행동은 무시 · 다음 판(대기실)에 빈 자리가 있으면 앉는다
 *  - 관전자가 받는 메시지에는 남의 손패도, 남의 토큰도 없다
 */
process.env.ROBO_FAST = '1';
const assert = require('assert');
const game = require('../game');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 가짜 소켓. auto 면 내 차례에 낼 수 있는 카드를 알아서 낸다(사람 대신). */
function sock({ auto = false } = {}) {
  const s = {
    readyState: 1, inbox: [],
    send(t) {
      const m = JSON.parse(t);
      this.inbox.push(m);
      if (auto && m.t === 'state' && m.phase === 'playing' && m.turn === m.you && !m.reveal) {
        const c = m.hand.find(x => x.ok);
        if (c) setTimeout(() => { if (this.readyState === 1) game.handle(this, { t: 'play', id: c.id }); }, 5);
      }
    },
    close() { this.readyState = 3; },
  };
  return s;
}
const last = (ws, t) => { const l = ws.inbox.filter(m => m.t === t); return l[l.length - 1] || null; };
const welcome = ws => ws.inbox.find(m => m.t === 'welcome');
const codeOf = ws => welcome(ws).code;
const roomOf = ws => game.rooms.get(codeOf(ws));
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('시간 안에 안 됨'); await sleep(10); }
};
const FLUSH = 380;

/** 방장 + 봇 n 개로 방을 만든다 */
function makeRoom(name, bots, extra = {}, opt = {}) {
  const h = sock(opt);
  game.handle(h, Object.assign({ t: 'create', name }, extra));
  for (let i = 0; i < bots; i++) game.handle(h, { t: 'addBot' });
  return h;
}

/** 관전자가 받은 메시지에서 숨은 정보를 찾는다. 카드 모양 객체는 맨 위 카드(top)와 낸 카드(ev.card)에만 있어야 하고,
 *  손패는 비어 있어야 하고, 다른 사람의 토큰이 있으면 안 된다. */
function leaks(msgs, tokens) {
  const bad = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    if (!v || typeof v !== 'object') return;
    if ('tag' in v && !/(^|\.)(top|card)$/.test(path)) bad.push('카드가 ' + path + ' 에 있음');
    for (const k of Object.keys(v)) walk(v[k], path ? path + '.' + k : k);
  };
  for (const m of msgs) {
    walk(m, '');
    if (m.t === 'state') {
      if (m.hand.length) bad.push('관전자 state 에 손패가 있음');
      if (m.role !== 'spec' || m.you !== null) bad.push('관전자 state 의 role/you 가 이상함');
      for (const p of m.players) if (typeof p.hand !== 'number') bad.push('남의 손패가 숫자가 아님');
    }
    const text = JSON.stringify(m);
    for (const t of tokens) if (text.includes(t)) bad.push('다른 사람의 토큰이 샘');
  }
  return bad;
}

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' — ' + (e.stack || e.message)); process.exit(1); }
}

(async () => {
  console.log('관전자');

  await check('시작한 방에 들어오면 관전자 — role:spec · 토큰 없음 · 방 인원은 그대로', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    const w = welcome(v);
    assert.strictEqual(w.role, 'spec');
    assert.strictEqual(w.you, null);
    assert.ok(!('token' in w), '관전자에게 토큰이 감');
    const st = last(v, 'state');
    assert.strictEqual(st.role, 'spec');
    assert.strictEqual(st.you, null);
    assert.deepStrictEqual(st.specs, ['구경']);
    assert.strictEqual(st.players.length, 2);
    assert.deepStrictEqual(last(h, 'state').specs, ['구경'], '플레이어가 관전자를 모름');
    assert.strictEqual(last(h, 'state').role, 'player');
    assert.strictEqual(roomOf(h).specs.length, 1);
    assert.ok(!roomOf(h).players.some(p => p.name === '구경'), '관전자가 players 에 섞임');
  });

  await check('관전자의 행동(play · start · cfg · addBot · kick · again)은 조용히 무시된다', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    const r = roomOf(h);
    const before = JSON.stringify({ n: r.players.length, hands: r.players.map(p => p.hand.map(c => c.id)), sum: r.sum, turn: r.turn, cfg: r.cfg, host: r.hostId });
    const inbox = v.inbox.length;
    for (const p of r.players) {
      for (const c of p.hand) game.handle(v, { t: 'play', id: c.id });
    }
    game.handle(v, { t: 'start' });
    game.handle(v, { t: 'cfg', showSum: false, turnLimit: 0, priv: true, spec: false });
    game.handle(v, { t: 'addBot' });
    game.handle(v, { t: 'kick', id: r.hostId });
    game.handle(v, { t: 'again' });
    game.handle(v, { t: 'name', name: '바꿈' });
    const after = JSON.stringify({ n: r.players.length, hands: r.players.map(p => p.hand.map(c => c.id)), sum: r.sum, turn: r.turn, cfg: r.cfg, host: r.hostId });
    assert.strictEqual(after, before, '관전자가 판을 건드림');
    assert.strictEqual(v.inbox.filter(m => m.t === 'err').length, 0, '무시하지 않고 오류를 보냄');
    assert.ok(v.inbox.length >= inbox);
    assert.strictEqual(r.specs[0].name, '구경');
  });

  await check('가득 찬 대기실에 들어오면 관전자', async () => {
    const h = makeRoom('가나', game.MAX_PLAYERS - 1);
    assert.strictEqual(roomOf(h).players.length, game.MAX_PLAYERS);
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    assert.strictEqual(welcome(v).role, 'spec');
    assert.strictEqual(roomOf(h).phase, 'lobby');
    assert.strictEqual(roomOf(h).players.length, game.MAX_PLAYERS);
    assert.strictEqual(last(v, 'state').phase, 'lobby');
  });

  await check('spec:false 방은 시작했거나 가득 차면 지금처럼 거절한다', async () => {
    const h = makeRoom('가나', game.MAX_PLAYERS - 1, { spec: false });
    assert.strictEqual(roomOf(h).cfg.spec, false);
    const full = sock();
    game.handle(full, { t: 'join', code: codeOf(h), name: '만석' });
    assert.ok(/방이 가득 찼어요/.test(last(full, 'err').msg));
    assert.ok(!welcome(full));
    game.handle(h, { t: 'start' });
    const late = sock();
    game.handle(late, { t: 'join', code: codeOf(h), name: '늦음' });
    assert.ok(/이미 시작한 방이에요/.test(last(late, 'err').msg));
    assert.ok(!welcome(late));
    assert.strictEqual(roomOf(h).specs.length, 0);
  });

  await check('관전석은 10명까지, 넘으면 거절', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    for (let i = 0; i < game.MAX_SPECS; i++) {
      const v = sock();
      game.handle(v, { t: 'join', code: codeOf(h), name: '구경' + i });
      assert.strictEqual(welcome(v).role, 'spec');
    }
    const extra = sock();
    game.handle(extra, { t: 'join', code: codeOf(h), name: '넘침' });
    assert.strictEqual(last(extra, 'err').msg, '관전석이 가득 찼어요.');
    assert.strictEqual(roomOf(h).specs.length, game.MAX_SPECS);
  });

  await check('방장이 대기실에서 관전 허용을 바꾼다 — 방장만, 판 중엔 거절', async () => {
    const h = makeRoom('가나', 1);
    const g = sock();
    game.handle(g, { t: 'join', code: codeOf(h), name: '손님' });
    game.handle(g, { t: 'cfg', spec: false });
    assert.strictEqual(roomOf(h).cfg.spec, true, '방장이 아닌데 바뀜');
    game.handle(h, { t: 'cfg', spec: false });
    assert.strictEqual(roomOf(h).cfg.spec, false);
    assert.strictEqual(last(g, 'state').cfg.spec, false);
    game.handle(h, { t: 'cfg', spec: 'no' });
    assert.strictEqual(roomOf(h).cfg.spec, false, '불린이 아닌 값이 들어감');
    game.handle(h, { t: 'cfg', spec: true });
    game.handle(h, { t: 'start' });
    game.handle(h, { t: 'cfg', spec: false });
    assert.strictEqual(roomOf(h).cfg.spec, true, '판 중에 바뀜');
  });

  await check('관전자와 플레이어의 채팅이 서로에게 가고 이름으로 구분된다', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    game.handle(v, { t: 'chat', text: '안녕' });
    const m = last(h, 'chat');
    assert.ok(m && m.text === '안녕' && m.name === '구경' && m.spec === true);
    assert.strictEqual(last(v, 'chat').from, welcome(v).specId);
    await sleep(450);
    game.handle(h, { t: 'chat', text: '어서 와' });
    const back = last(v, 'chat');
    assert.ok(back.text === '어서 와' && back.name === '가나' && !back.spec);
  });

  await check('관전자가 소켓을 닫거나 나가면 목록에서 빠진다', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    const a = sock(), b = sock();
    game.handle(a, { t: 'join', code: codeOf(h), name: '하나' });
    game.handle(b, { t: 'join', code: codeOf(h), name: '둘' });
    assert.deepStrictEqual(last(h, 'state').specs, ['하나', '둘']);
    a.readyState = 3; game.disconnect(a);
    assert.deepStrictEqual(last(h, 'state').specs, ['둘']);
    game.handle(b, { t: 'leave' });
    assert.ok(last(b, 'left'));
    assert.deepStrictEqual(last(h, 'state').specs, []);
    assert.strictEqual(roomOf(h).specs.length, 0);
  });

  await check('방 목록에 spec · watching 이 보이고 state 규칙은 그대로', async () => {
    const w = sock();
    game.handle(w, { t: 'rooms' });
    const a = makeRoom('열림', 1);
    const b = makeRoom('막힘', 1, { spec: false });
    game.handle(b, { t: 'start' });
    const c = makeRoom('판중', 1);
    game.handle(c, { t: 'start' });
    const v1 = sock(), v2 = sock();
    game.handle(v1, { t: 'join', code: codeOf(c), name: '구경1' });
    game.handle(v2, { t: 'join', code: codeOf(c), name: '구경2' });
    await sleep(FLUSH);
    const list = last(w, 'rooms').list;
    const ea = list.find(x => x.code === codeOf(a));
    const eb = list.find(x => x.code === codeOf(b));
    const ec = list.find(x => x.code === codeOf(c));
    assert.deepStrictEqual([ea.state, ea.spec, ea.watching], ['wait', true, 0]);
    assert.deepStrictEqual([eb.state, eb.spec, eb.watching], ['playing', false, 0]);
    assert.deepStrictEqual([ec.state, ec.spec, ec.watching], ['playing', true, 2]);
    const full = makeRoom('만석', game.MAX_PLAYERS - 1);
    await sleep(FLUSH);
    assert.strictEqual(last(w, 'rooms').list.find(x => x.code === codeOf(full)).state, 'full');
  });

  await check('비공개 방도 목록엔 priv:true 로 뜨되 코드는 없고, 코드로는 관전자로 들어간다', async () => {
    const w = sock();
    game.handle(w, { t: 'rooms' });
    const h = makeRoom('숨김', 1, { priv: true });
    game.handle(h, { t: 'start' });
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    assert.strictEqual(welcome(v).role, 'spec');
    await sleep(FLUSH);
    const e = last(w, 'rooms').list.find(x => x.priv && x.host === '숨김');
    assert.deepStrictEqual(e, { priv: true, host: '숨김', n: 2, max: game.MAX_PLAYERS, state: 'playing', spec: true, watching: 1 });
    assert.ok(!JSON.stringify(last(w, 'rooms')).includes(codeOf(h)), '비공개 방 코드가 샘');
  });

  await check('판이 끝나 대기실로 돌아오면 관전자가 빈 자리에 앉고 welcome 을 받는다 · 숨은 정보는 안 샌다', async () => {
    const h = makeRoom('가나', 1, {}, { auto: true });
    const v = sock();
    game.handle(h, { t: 'start' });
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    const tokens = roomOf(h).players.map(p => p.token);
    await until(() => last(h, 'state').phase === 'over', 20000);
    // 끝난 방(over)에서는 아직 관전자
    assert.strictEqual(roomOf(h).specs.length, 1);
    assert.strictEqual(roomOf(h).players.length, 2);
    const seen = v.inbox.slice();
    assert.deepStrictEqual(leaks(seen.filter(m => m.t === 'state' || m.t === 'ev'), tokens), []);
    assert.ok(seen.filter(m => m.t === 'state' && m.phase === 'playing').length > 3, '관전자가 판을 못 봄');

    game.handle(h, { t: 'again' });
    const w = v.inbox.filter(m => m.t === 'welcome');
    assert.strictEqual(w.length, 2, '앉았다는 응답이 안 옴');
    assert.strictEqual(w[1].role, 'player');
    assert.strictEqual(w[1].seated, true);
    assert.ok(w[1].token && w[1].token.length > 10);
    assert.ok(w[1].you != null);
    const st = last(v, 'state');
    assert.strictEqual(st.role, 'player');
    assert.strictEqual(st.you, w[1].you);
    assert.strictEqual(st.phase, 'lobby');
    assert.strictEqual(st.players.length, 3);
    assert.deepStrictEqual(st.specs, []);
    assert.strictEqual(roomOf(h).specs.length, 0);
    // 앉은 뒤에는 정식 참가자 — 토큰으로 이어 붙는다
    const again = sock();
    game.handle(again, { t: 'resume', code: codeOf(h), token: w[1].token });
    assert.strictEqual(last(again, 'state').you, w[1].you);
  });

  await check('자리가 없으면 계속 관전자, 자리가 나면(대기실) 들어온 순서대로 앉는다', async () => {
    const h = makeRoom('가나', game.MAX_PLAYERS - 1);
    const a = sock(), b = sock();
    game.handle(a, { t: 'join', code: codeOf(h), name: '하나' });
    game.handle(b, { t: 'join', code: codeOf(h), name: '둘' });
    assert.ok(welcome(a).role === 'spec' && welcome(b).role === 'spec');
    const bots = roomOf(h).players.filter(p => p.bot);
    game.handle(h, { t: 'kick', id: bots[0].id });
    assert.strictEqual(last(a, 'state').role, 'player', '먼저 온 관전자가 안 앉음');
    assert.strictEqual(last(b, 'state').role, 'spec');
    assert.deepStrictEqual(last(b, 'state').specs, ['둘']);
    game.handle(h, { t: 'kick', id: bots[1].id });
    assert.strictEqual(last(b, 'state').role, 'player');
    assert.strictEqual(roomOf(h).players.length, game.MAX_PLAYERS - 1 + 1);
    assert.strictEqual(roomOf(h).specs.length, 0);
    assert.strictEqual(roomOf(h).hostId, roomOf(h).players[0].id, '방장이 바뀜');
  });

  await check('만석 방은 다음 판에도 자리가 없으면 관전자로 남는다', async () => {
    const h = makeRoom('가나', game.MAX_PLAYERS - 1, {}, { auto: true });
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    game.handle(h, { t: 'start' });
    await until(() => last(h, 'state').phase === 'over', 60000);
    game.handle(h, { t: 'again' });
    assert.strictEqual(last(v, 'state').role, 'spec');
    assert.strictEqual(last(v, 'state').phase, 'lobby');
    assert.strictEqual(v.inbox.filter(m => m.t === 'welcome').length, 1);
    assert.strictEqual(roomOf(h).specs.length, 1);
  });

  await check('사람이 다 떠나 방이 정리되면 관전자 소켓도 닫힌다 (관전자만으론 방이 안 산다)', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    const v = sock();
    game.handle(v, { t: 'join', code: codeOf(h), name: '구경' });
    const code = codeOf(h);
    h.readyState = 3; game.disconnect(h);
    game.sweepRooms(Date.now() + 5000);
    assert.ok(game.rooms.has(code), '너무 일찍 치움');
    game.sweepRooms(Date.now() + 100_000);
    assert.ok(!game.rooms.has(code), '관전자만 남은 방이 안 치워짐');
    assert.strictEqual(v.readyState, 3, '관전자 소켓이 안 닫힘');
    assert.strictEqual(last(v, 'err').fatal, true);
    // 사람이 모두 끊긴 방은 목록에도 안 뜬다
    const w = sock();
    const h2 = makeRoom('둘째', 1);
    game.handle(h2, { t: 'start' });
    const v2 = sock();
    game.handle(v2, { t: 'join', code: codeOf(h2), name: '구경' });
    h2.readyState = 3; game.disconnect(h2);
    game.handle(w, { t: 'rooms' });
    assert.ok(!last(w, 'rooms').list.some(x => x.code === codeOf(h2)), '관전자만 있는 방이 목록에 뜸');
  });

  await check('누출 검사기가 플레이어 시야는 잡아낸다 (검사기 자체 확인)', async () => {
    const h = makeRoom('가나', 1);
    game.handle(h, { t: 'start' });
    const bad = leaks(h.inbox.filter(m => m.t === 'state'), roomOf(h).players.map(p => p.token));
    assert.ok(bad.length > 0, '플레이어 시야를 통과시킴 — 검사가 헐겁다');
  });

  console.log(`  ${pass}개 통과`);
  process.exit(0);
})();
