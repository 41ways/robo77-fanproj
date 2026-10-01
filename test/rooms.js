'use strict';
/**
 * 열린 방 목록 — node test/rooms.js
 * 서버를 띄우지 않고 game.js 에 가짜 소켓(send · close · readyState)을 붙여 본다.
 * Node 서버와 Cloudflare(worker.js)가 똑같이 이 모양으로 붙으므로 둘 다 확인하는 셈이다.
 *  - 방을 만들면 목록을 보는 다른 소켓에 뜬다 · 비공개 방은 코드 없이 priv:true 로만 뜬다
 *  - 방에 들어간 소켓은 더는 목록을 받지 않는다 · 시작한 방은 들어갈 수 없게 바뀐다
 *  - 한꺼번에 여러 번 바뀌어도 한 번만 밀어 준다
 */
const assert = require('assert');
const game = require('../game');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sock() {
  return {
    readyState: 1, inbox: [],
    send(t) { this.inbox.push(JSON.parse(t)); },
    close() { this.readyState = 3; },
  };
}
const lists = ws => ws.inbox.filter(m => m.t === 'rooms');
const lastList = ws => { const l = lists(ws); return l.length ? l[l.length - 1].list : null; };
const codeOf = ws => ws.inbox.find(m => m.t === 'welcome').code;
const FLUSH = 380;   // 목록 밀어주기를 묶는 300ms + 여유

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); process.exit(1); }
}

(async () => {
  console.log('열린 방 목록');
  const w = sock();
  let a, codeA, b, codeB;

  await check('목록을 달라면 곧바로 답한다 (처음엔 비어 있음)', async () => {
    game.handle(w, { t: 'rooms' });
    assert.deepStrictEqual(lastList(w), []);
  });

  await check('방을 만들면 목록을 보는 소켓에 뜬다', async () => {
    a = sock();
    game.handle(a, { t: 'create', name: '가나' });
    codeA = codeOf(a);
    await sleep(FLUSH);
    const r = lastList(w).find(x => x.code === codeA);
    assert.ok(r, '만든 방이 목록에 없음');
    assert.deepStrictEqual(r, { code: codeA, host: '가나', n: 1, max: game.MAX_PLAYERS, state: 'wait', spec: true, watching: 0 });
    assert.ok(!lists(a).length, '방에 앉은 소켓에 목록이 감');
  });

  await check('비공개 방은 목록에 뜨되 코드가 없고, 코드로는 들어간다', async () => {
    b = sock();
    game.handle(b, { t: 'create', name: '다라', priv: true });
    codeB = codeOf(b);
    await sleep(FLUSH);
    const pr = lastList(w).filter(x => x.priv);
    assert.strictEqual(pr.length, 1, '비공개 방이 목록에 없음');
    assert.ok(!('code' in pr[0]), '비공개 방 항목에 코드가 실림');
    assert.ok(!JSON.stringify(lists(w)).includes(codeB), '비공개 방 코드가 목록 어딘가로 샘');
    assert.deepStrictEqual(pr[0], { priv: true, host: '다라', n: 1, max: game.MAX_PLAYERS, state: 'wait', spec: true, watching: 0 });
    // 공개 wait 방이 비공개보다 앞에 온다
    const li = lastList(w);
    assert.ok(li.findIndex(x => !x.priv) < li.findIndex(x => x.priv), '공개 방이 비공개보다 뒤에 있음');
    const c = sock();
    game.handle(c, { t: 'join', code: codeB, name: '마바' });
    assert.ok(c.inbox.some(m => m.t === 'welcome'), '코드로 못 들어감');
  });

  await check('방장이 비공개를 풀면 코드가 실리고, 다시 걸면 코드가 빠진다', async () => {
    game.handle(b, { t: 'cfg', priv: false });
    await sleep(FLUSH);
    assert.ok(lastList(w).some(x => x.code === codeB && !x.priv));
    game.handle(b, { t: 'cfg', priv: true });
    await sleep(FLUSH);
    assert.ok(!lastList(w).some(x => x.code === codeB));
    assert.ok(lastList(w).some(x => x.priv && x.host === '다라'));
  });

  await check('여러 번 바뀌어도 한 번에 묶어 보낸다', async () => {
    const before = lists(w).length;
    game.handle(a, { t: 'addBot' });
    game.handle(a, { t: 'addBot' });
    game.handle(a, { t: 'name', name: '가나다' });
    await sleep(FLUSH);
    assert.strictEqual(lists(w).length - before, 1, '묶이지 않음');
    const r = lastList(w).find(x => x.code === codeA);
    assert.strictEqual(r.n, 3);
    assert.strictEqual(r.host, '가나다');
  });

  await check('목록을 보던 소켓이 방에 들어가면 그만 받는다', async () => {
    const v = sock();
    game.handle(v, { t: 'rooms' });
    game.handle(v, { t: 'join', code: codeA, name: '사아' });
    const n = lists(v).length;
    await sleep(FLUSH);
    assert.strictEqual(lastList(w).find(x => x.code === codeA).n, 4);
    assert.strictEqual(lists(v).length, n, '방에 들어간 뒤에도 목록이 옴');
  });

  await check('시작한 방은 게임 중으로 바뀌고 들어갈 수 없다', async () => {
    game.handle(a, { t: 'start' });
    await sleep(FLUSH);
    const r = lastList(w).find(x => x.code === codeA);
    assert.ok(!r || r.state === 'playing', '시작한 방이 들어갈 수 있는 방으로 남음');
    assert.strictEqual(r.spec, true);
    // 관전을 막은 방은 시작하면 들어갈 수 없다 (관전 허용 방은 test/spectate.js)
    const closed = sock(), cc = sock();
    game.handle(closed, { t: 'create', name: '막음', spec: false });
    game.handle(closed, { t: 'addBot' });
    game.handle(closed, { t: 'start' });
    game.handle(cc, { t: 'join', code: codeOf(closed), name: '늦음' });
    assert.ok(cc.inbox.some(m => m.t === 'err'), '관전 불가 방의 시작한 판에 들어가짐');
  });

  await check('사람이 모두 끊긴 방은 목록에서 빠진다', async () => {
    const d = sock();
    game.handle(d, { t: 'create', name: '혼자' });
    const codeD = codeOf(d);
    await sleep(FLUSH);
    assert.ok(lastList(w).some(x => x.code === codeD));
    d.readyState = 3;
    game.disconnect(d);
    await sleep(FLUSH);
    assert.ok(!lastList(w).some(x => x.code === codeD), '빈 방이 목록에 남음');
  });

  await check('그만 보기(unwatch) · 소켓이 닫히면 더는 안 보낸다', async () => {
    game.handle(w, { t: 'unwatch' });
    const n = lists(w).length;
    game.handle(sock(), { t: 'create', name: '또' });
    await sleep(FLUSH);
    assert.strictEqual(lists(w).length, n);

    const x = sock();
    game.handle(x, { t: 'rooms' });
    x.readyState = 3;
    game.disconnect(x);
    const m = lists(x).length;
    game.handle(sock(), { t: 'create', name: '또또' });
    await sleep(FLUSH);
    assert.strictEqual(lists(x).length, m);
  });

  console.log(`  ${pass}개 통과`);
  process.exit(0);
})();
