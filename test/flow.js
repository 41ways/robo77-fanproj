'use strict';
/**
 * 서버를 실제로 띄우고 판을 끝까지 돌려 본다 — node test/flow.js
 * 봇들끼리 게임이 끝날 때까지 두고, 매 상태마다 규칙이 깨지지 않는지 확인한다.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const R = require('../rules');

// PORT 를 주면 이미 떠 있는 서버(ROBO_FAST=1 로 띄운 것)에 붙는다 — wrangler dev 시험용
const USE_EXISTING = !!process.env.PORT;
const PORT = process.env.PORT || 8791;   // 서비스 포트(8790) 바로 옆, 다른 프로젝트와 겹치지 않게
const URL = `ws://127.0.0.1:${PORT}/ws`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 매 state 마다 확인하는 것들 */
function checkInvariants(s, log) {
  for (const p of s.players) {
    assert.ok(p.hearts >= 0 && p.hearts <= R.START_HEARTS, `하트가 ${p.hearts}`);
    if (p.out) assert.strictEqual(p.hearts, 0, `${p.name} 탈락했는데 하트가 남음`);
  }

  if (s.phase === 'playing') {
    const cur = s.players.find(p => p.id === s.turn);
    if (cur) assert.ok(!cur.out, `탈락한 ${cur.name} 차례가 돌아옴`);
    assert.ok(s.due >= 1 && s.due <= 2, `내야 할 장수가 ${s.due}`);
    assert.ok([1, -1].includes(s.dir), `방향이 ${s.dir}`);

    // 합이 죽는 값인 채로 판이 계속되면 안 된다 (라운드 결과를 띄우는 중은 예외)
    if (!s.reveal && s.sum != null) {
      assert.ok(!R.isBust(s.sum), `합 ${s.sum} 인데 판이 계속됨`);
      assert.ok(!R.isEleven(s.sum), `합 ${s.sum} (11의 배수) 인데 판이 계속됨`);
    }
    // 라운드 첫 장 앞에서는 합이 0이어야 한다
    if (s.firstOfRound && s.sum != null) assert.strictEqual(s.sum, 0, '라운드 첫 장인데 합이 0이 아님');
  }

  const living = s.players.filter(p => !p.out).length;
  if (s.phase === 'over') {
    assert.ok(living <= 1, `게임이 끝났는데 ${living}명 생존`);
  }
  log.maxRound = Math.max(log.maxRound, s.round || 0);
}

/** 관전자가 받은 메시지에 숨은 정보가 없는지 — 카드 모양 객체는 top · ev.card 에만, 손패는 비어 있고, 남의 토큰은 없다 */
function checkSpecView(msgs, tokens) {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    if (!v || typeof v !== 'object') return;
    assert.ok(!('tag' in v) || /(^|\.)(top|card)$/.test(path), `관전자에게 카드가 샘 (${path})`);
    for (const k of Object.keys(v)) walk(v[k], path ? path + '.' + k : k);
  };
  for (const m of msgs) {
    walk(m, '');
    if (m.t === 'state') {
      assert.strictEqual(m.role, 'spec');
      assert.deepStrictEqual(m.hand, [], '관전자에게 손패가 감');
      checkInvariants(m, { maxRound: 0 });      // 관전자가 보는 판도 같은 규칙을 지켜야 한다
    }
    const text = JSON.stringify(m);
    for (const t of tokens) assert.ok(!text.includes(t), '관전자에게 남의 토큰이 샘');
  }
}

function run(label, { players, turnLimit, showSum }) {
  return new Promise((resolve, reject) => {
    const log = { maxRound: 0, losses: 0, sawX2: false, sawRev: false, sawS76: false };
    const ws = new WebSocket(URL);
    let done = false;

    const bail = e => { if (!done) { done = true; try { ws.close(); } catch (_) {} reject(e); } };
    const finish = v => { if (!done) { done = true; try { ws.close(); } catch (_) {} resolve(v); } };

    let sentKey = null;
    let code = null, token = null, spec = null;     // 판이 시작되면 관전자 하나가 들어와 끝까지 지켜본다
    const specMsgs = [];
    const joinSpec = () => {
      spec = new WebSocket(URL);
      spec.on('open', () => spec.send(JSON.stringify({ t: 'join', code, name: '구경꾼' })));
      spec.on('message', raw => {
        const m = JSON.parse(raw);
        specMsgs.push(m);
        // 관전자가 아무 카드나 내려 해도 무시되어야 한다 — 판은 방장 쪽 검사가 그대로 지켜 준다
        if (m.t === 'state' && m.phase === 'playing') spec.send(JSON.stringify({ t: 'play', id: 1 }));
      });
      spec.on('error', bail);
    };

    const timeout = setTimeout(() => bail(new Error(`${label}: 60초 안에 안 끝남`)), 60_000);

    ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: '심판' })));

    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (_) { return; }

      if (m.t === 'welcome') { code = m.code; token = m.token; }
      if (m.t === 'err') return bail(new Error(`${label}: 서버 오류 — ${m.msg}`));

      if (m.t === 'ev') {
        if (m.kind === 'lose') log.losses++;
        if (m.kind === 'play' && m.card) {
          if (m.card.t === 'x2') log.sawX2 = true;
          if (m.card.t === 'rev') log.sawRev = true;
          if (m.card.tag === 's76') log.sawS76 = true;
        }
        return;
      }

      if (m.t !== 'state') return;

      try { checkInvariants(m, log); } catch (e) { return bail(new Error(`${label}: ${e.message}`)); }

      if (m.phase === 'lobby') {
        // 자리를 다 채우고 설정을 맞춘 뒤 시작한다
        if (m.players.length < players) return ws.send(JSON.stringify({ t: 'addBot' }));
        ws.send(JSON.stringify({ t: 'cfg', turnLimit, showSum }));
        if (m.cfg.turnLimit === turnLimit && m.cfg.showSum === showSum) {
          ws.send(JSON.stringify({ t: 'start' }));
        }
        return;
      }

      if (m.phase === 'playing') {
        if (!spec) joinSpec();
        // 합 공개를 끄면 서버가 합을 보내지 않아야 한다
        if (!showSum && !m.reveal) {
          if (m.sum !== null) return bail(new Error(`${label}: 합을 숨겨야 하는데 ${m.sum} 이 넘어옴`));
        }
        // 내 차례면 규칙에 맞는 카드를 아무거나 낸다
        if (m.turn === m.you && !m.reveal) {
          const legal = m.hand.filter(c => c.ok);
          // 서버가 준 ok 플래그가 규칙과 같은지 대조한다
          for (const c of m.hand) {
            const want = R.playable(c, { sum: m.sum == null ? 0 : m.sum, firstOfRound: m.firstOfRound });
            if (m.sum != null && c.ok !== want) {
              return bail(new Error(`${label}: ok 플래그가 규칙과 다름 (${c.tag} ${c.v}, 합 ${m.sum})`));
            }
          }
          // 관전자가 들어오면 같은 상태가 한 번 더 온다 — 같은 차례에 두 번 내지 않게
          const key = m.round + ':' + m.hand.map(c => c.id).join(',');
          if (legal.length && key !== sentKey) {
            sentKey = key;
            const pickOne = legal[Math.floor(Math.random() * legal.length)];
            setTimeout(() => ws.send(JSON.stringify({ t: 'play', id: pickOne.id })), 10);
          }
        }
        return;
      }

      if (m.phase === 'over') {
        clearTimeout(timeout);
        const living = m.players.filter(p => !p.out);
        assert.ok(living.length <= 1, '승자가 둘 이상');
        if (living.length === 1) assert.strictEqual(m.winner, living[0].id, '승자 표시가 어긋남');
        setTimeout(() => {
          try {
            assert.ok(specMsgs.some(x => x.t === 'welcome' && x.role === 'spec'), '관전자로 못 들어옴');
            assert.ok(specMsgs.some(x => x.t === 'state' && x.phase === 'over'), '관전자가 끝까지 못 봄');
            assert.ok(specMsgs.every(x => x.t !== 'err'), '관전자가 오류를 받음');
            checkSpecView(specMsgs.filter(x => x.t === 'state' || x.t === 'ev'), [token]);
            if (spec) spec.close();
          } catch (e) { return bail(new Error(`${label}: ${e.message}`)); }
          finish({ log, winner: living[0] ? living[0].name : null, rounds: m.round, watched: specMsgs.length });
        }, 150);
      }
    });

    ws.on('error', bail);
  });
}

(async () => {
  let srv = { kill() {} };
  let stderr = '';
  if (!USE_EXISTING) {
    srv = spawn(process.execPath, [require.resolve('../server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), ROBO_FAST: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stderr.on('data', d => { stderr += d; process.stderr.write(d); });
    await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('로보77 서버')) r(); }));
  }

  try {
    const cases = [
      ['6인 · 5초 · 합 공개',   { players: 6, turnLimit: 5000, showSum: true }],
      ['2인 · 무제한 · 합 숨김', { players: 2, turnLimit: 0,    showSum: false }],
      ['4인 · 무제한 · 합 공개', { players: 4, turnLimit: 0,    showSum: true }],
    ];

    for (const [label, cfg] of cases) {
      const r = await run(label, cfg);
      console.log(`  ✓ ${label} — ${r.rounds}라운드, 승자 ${r.winner}, 실점 ${r.log.losses}회, 관전자 수신 ${r.watched}건` +
        ` (×2 ${r.log.sawX2 ? '○' : '×'} · 방향전환 ${r.log.sawRev ? '○' : '×'} · 76 ${r.log.sawS76 ? '○' : '×'})`);
    }

    assert.strictEqual(stderr.trim(), '', '서버가 오류를 뱉음');
    console.log('\n판이 끝까지 돌고 규칙도 안 깨졌음\n');
    srv.kill();
    process.exit(0);
  } catch (e) {
    console.error('\n실패:', e.message, '\n');
    srv.kill();
    process.exit(1);
  }
})();
