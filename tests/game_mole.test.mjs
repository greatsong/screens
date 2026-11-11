// 화면 안 게임(site/games/mole/)과 휴대폰 닉네임 페이지(site/games/name.html)의 동작 시험.
// 브라우저 없이 스크립트만 가짜 문서에 올려 돌린다. 터치가 실제로 전달되는지는 브라우저 입력 경로의 일이라 여기서는 볼 수 없고,
// 여기서는 '어떤 이벤트에 반응하는가'와 '무엇을 그리는가'를 지킨다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lastScript = (html) => html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');
const moleSource = lastScript(read('../site/games/mole/index.html'));
const nameSource = lastScript(read('../site/games/name.html'));
const styleSource = read('../site/style.css');
const API = 'https://api.invalid/exec';

function page(source, { board = [], search = '', scoreReply = null, hiddenAtStart = [], noFrames = false } = {}) {
  let now = Date.parse('2026-11-11T10:00:00+09:00');
  let nextTimer = 0;
  const timers = new Map();
  const elements = new Map();
  const posts = [];
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function element(id) {
    const classes = new Set();
    const listeners = {};
    const found = {};
    const el = {
      id, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', className: '', style: {}, offsetWidth: 0, children: [],
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
        toggle: (n, on) => { const want = on === undefined ? !classes.has(n) : !!on; if (want) classes.add(n); else classes.delete(n); return want; },
      },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      fire: (type, ev = {}) => (listeners[type] || []).forEach((fn) => fn(Object.assign({ button: 0, preventDefault() {} }, ev))),
      appendChild: (child) => { el.children.push(child); return child; },
      insertAdjacentHTML() {}, remove() {}, click() { el.fire('click'); },
      querySelector: (sel) => (found[sel] = found[sel] || element('')),
    };
    return el;
  }
  const $ = (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  hiddenAtStart.forEach((id) => { $(id).hidden = true; });
  const timer = (fn, ms, every) => { const id = ++nextTimer; timers.set(id, { id, fn, at: now + Math.max(0, ms || 0), every }); return id; };
  const reply = (data) => Promise.resolve({ json: () => Promise.resolve(data) });
  const context = {
    console, URL, URLSearchParams, Uint8Array, JSON, Promise, Date: TestDate,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),   // 늘 보통 두더지가 한 마리씩 올라온다(폭탄·황금 없음)
    document: { getElementById: $, createElement: () => element('') },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { href: 'https://greatsong.github.io/screens/games/mole/', search },
    setTimeout: (fn, ms) => timer(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    // noFrames: 그리기가 멈춘 화면(가려진 탭). 다음 그림을 기다리는 콜백이 불리지 않는다
    requestAnimationFrame: (fn) => (noFrames ? 0 : timer(fn, 16)), cancelAnimationFrame: (id) => timers.delete(id),
    fetch: (url, opts) => {
      if (/content\.json/.test(url)) return reply({ vote: { api: API } });
      if (opts && opts.method === 'POST') { const body = JSON.parse(opts.body); posts.push(body); return reply(typeof scoreReply === 'function' ? scoreReply(body) : scoreReply); }
      return reply({ ok: true, top: board, plays: 7 });
    },
  };
  vm.runInNewContext(source, context);
  return {
    $, posts, timers,
    holes: () => $('grid').children,
    async settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        if (!next) break;
        now = Math.max(now, next.at);
        if (next.every) next.at += next.every; else timers.delete(next.id);
        next.fn();
      }
      now = end;
    },
  };
}
const mole = (opts) => page(moleSource, Object.assign({ hiddenAtStart: ['countdown', 'result', 'claim', 'nick'] }, opts));
const rows = (html) => (html.match(/<li/g) || []).length;
// 한 판을 끝까지 한다: 시작을 누르고, 결과가 표시될 때까지 올라온 두더지를 모두 누른다
async function playRound(env) {
  env.$('start').fire('pointerdown');
  env.advance(3 * 800);
  for (let t = 0; t < 40000 && env.$('result').hidden; t += 50) {
    env.holes().filter((h) => h.classList.contains('up') && !h.classList.contains('hit')).forEach((h) => h.fire('pointerdown'));
    env.advance(50);
  }
  await env.settle();
}
// 화면 키보드: 지금 표시된 키 가운데 그 글자가 적힌 키를 누른다
const keyOf = (env, label) => ['kb1', 'kb2', 'kb3'].flatMap((id) => env.$(id).children).find((k) => !k.hidden && k.textContent === label);
const type = (env, text) => Array.from(text).forEach((ch) => { const k = keyOf(env, ch); assert.ok(k, '키가 없음: ' + ch); k.fire('pointerdown'); });
const press = (env, id, times = 1) => { for (let i = 0; i < times; i++) env.$(id).fire('pointerdown'); };
const typed = (env) => env.$('nText').textContent;

test('the start button reacts to the finger touching it, because a second finger on the screen or a sliding tap never becomes a click', () => {
  const env = mole();
  env.$('start').fire('pointerdown');                 // click 은 오지 않는다(다른 손가락이 화면에 닿아 있는 경우)
  assert.equal(env.$('ready').hidden, true);
  assert.equal(env.$('countdown').hidden, false);
  const pending = env.timers.size;
  env.$('start').fire('click');                       // 손가락 하나로 눌렀을 때 뒤따라오는 click 으로 두 번 시작하지 않는다
  assert.equal(env.timers.size, pending);
  env.advance(3 * 800);                               // 3·2·1
  assert.equal(env.$('countdown').hidden, true);
  const up = env.holes().filter((h) => h.classList.contains('up'));
  assert.equal(up.length, 1);
  up[0].fire('pointerdown');
  assert.equal(env.$('score').textContent, 1);
});

test('a bare click still works for a remote control or keyboard, and the click after a touch does not toggle twice', () => {
  const env = mole();
  assert.equal(env.$('music').textContent, '🎵 음악 켜짐');
  env.$('music').fire('pointerdown'); env.$('music').fire('pointerup'); env.$('music').fire('click');
  assert.equal(env.$('music').textContent, '🔇 음악 꺼짐');
  env.advance(1000);
  env.$('music').fire('click');                       // 누름 없이 온 click(리모컨 확인 버튼)
  assert.equal(env.$('music').textContent, '🎵 음악 켜짐');
  env.$('start').fire('click');
  assert.equal(env.$('countdown').hidden, false);
  env.$('start').fire('pointerdown');                 // 세는 중에 다시 눌러도 처음부터 다시 세지 않는다
  env.advance(3 * 800);
  assert.equal(env.holes().filter((h) => h.classList.contains('up')).length, 1);
});

// 스탠바이미처럼 큰 화면에서는 손이 구멍에 닿기까지와 누름이 게임에 도착하기까지 시간이 더 걸린다. 머무는 시간이 끝나 내려가기 시작한
// 두더지도 아직 화면에 보이므로, 잠깐 동안은 누르면 잡혀야 한다(전에는 판이 빨라지는 후반에 보이는 두더지를 눌러도 반응이 없었다)
const untilLeaving = (env, hole) => { for (let t = 0; t < 3000 && hole.classList.contains('up'); t += 10) env.advance(10); };
const firstUp = (env) => { for (let t = 0; t < 3000; t += 10) { const h = env.holes().find((x) => x.classList.contains('up') && !x.classList.contains('hit')); if (h) return h; env.advance(10); } return null; };

test('a mole that has started going down is still caught for a moment, and after that moment a press does nothing', () => {
  const env = mole();
  env.$('start').fire('pointerdown');
  env.advance(3 * 800);
  const first = firstUp(env);
  untilLeaving(env, first);
  assert.equal(first.classList.contains('gone'), true);        // 내려가는 중
  env.advance(350);                                            // 다 내려갔어도 조금 더 받아 준다(화면과 터치가 늦는 기기)
  first.fire('pointerdown');
  assert.equal(env.$('score').textContent, 1);
  assert.equal(first.classList.contains('hit'), true);
  assert.equal(first.classList.contains('gone'), false);       // 잡힌 모습으로 돌아온다
  first.fire('pointerdown');                                   // 같은 두더지를 두 번 세지 않는다
  assert.equal(env.$('score').textContent, 1);

  const second = firstUp(env);
  untilLeaving(env, second);
  env.advance(410);
  second.fire('pointerdown');                                  // 너무 늦은 누름은 받지 않는다
  assert.equal(env.$('score').textContent, 1);
});

test('letting a mole go breaks the streak only after the moment in which it could still be caught', () => {
  const env = mole();
  env.$('start').fire('pointerdown');
  env.advance(3 * 800);
  for (let caught = 0; caught < 3;) { const h = firstUp(env); h.fire('pointerdown'); caught++; env.advance(10); }
  assert.equal(env.$('combo').classList.contains('on'), true);
  assert.match(env.$('combo').textContent, /연속 3/);
  const late = firstUp(env);
  untilLeaving(env, late);
  env.advance(300);
  late.fire('pointerdown');                                    // 내려가는 중에 잡아도 연속이 이어진다
  assert.match(env.$('combo').textContent, /연속 4/);
  const missed = firstUp(env);
  untilLeaving(env, missed);
  assert.equal(env.$('combo').classList.contains('on'), true); // 아직 잡을 수 있는 동안에는 끊기지 않는다
  env.advance(410);
  assert.equal(env.$('combo').classList.contains('on'), false);
});

test('the time a mole stays is counted from when it is drawn, and it still leaves when the page is not being drawn', () => {
  const env = mole();
  env.$('start').fire('pointerdown');
  env.advance(3 * 800);
  const first = firstUp(env);
  env.advance(1150 + 20);                                      // 올라온 순간부터 세면 이미 내려갔을 시간(첫 두더지는 1.15초 머문다)
  assert.equal(first.classList.contains('up'), true);
  env.advance(20);                                             // 화면에 그려진 뒤(두 프레임, 32ms)부터 1.15초
  assert.equal(first.classList.contains('up'), false);

  const covered = mole({ noFrames: true });
  covered.$('start').fire('pointerdown');
  covered.advance(3 * 800);
  const hole = firstUp(covered);
  covered.advance(250 + 1150 + 10);                            // 그림을 기다리다 0.25초가 지나면 그때부터 센다
  assert.equal(hole.classList.contains('up'), false);
});

test('the hall of fame leaves out records without a nickname', async () => {
  const env = mole({ board: [{ n: '', s: 75 }, { n: '연유', s: 63 }, { n: '', s: 61 }, { n: '석리송', s: 47 }] });
  await env.settle();
  const html = env.$('fame').innerHTML;
  assert.equal(rows(html), 2);
  assert.match(html, /🥇<\/span><span class="nm">연유<\/span><span class="sc">63점/);
  assert.match(html, /🥈<\/span><span class="nm">석리송/);
  assert.doesNotMatch(html, /닉네임 적는 중|class="nm"><\/span>/);
  assert.doesNotMatch(html, / me"/);                  // 처음 그릴 때는 강조하지 않는다

  const empty = mole({ board: [{ n: '', s: 75 }] });
  await empty.settle();
  assert.match(empty.$('fame').innerHTML, /아직 기록이 없습니다/);
});

test('after a round the rank counts named records only, the new nickname is highlighted when it arrives, and "again" waits a moment', async () => {
  const before = [{ n: '', s: 400 }, { n: '연유', s: 399 }, { n: '석리송', s: 2 }];
  const env = mole({ board: before, scoreReply: (b) => ({ ok: true, top: true, code: '0123456789abcdef', rank: 3, plays: 8,
    board: [{ n: '', s: 400 }, { n: '연유', s: 399 }, { n: '', s: b.score }, { n: '석리송', s: 2 }] }) });
  await env.settle();
  await playRound(env);
  assert.equal(env.$('result').hidden, false);
  assert.equal(env.posts.length, 1);
  assert.ok(env.posts[0].score > 10 && env.posts[0].score < 399);
  assert.equal(env.$('rRank').textContent, '🏆 명예의 전당 2위! 🎉');   // 닉네임 없는 400점은 세지 않는다
  assert.equal(env.$('claim').hidden, false);
  assert.equal(rows(env.$('fame').innerHTML), 2);                        // 내 기록도 닉네임을 적기 전에는 나오지 않는다

  // 결과가 뜬 직후의 「다시 하기」는 받지 않는다(계속 두드리던 손가락에 QR이 사라지지 않게)
  env.$('again').fire('pointerdown');
  assert.equal(env.$('result').hidden, false);
  env.advance(1000);
  assert.equal(env.$('again').classList.contains('wait'), false);

  // 휴대폰으로 닉네임을 적으면 결과 화면에서도 20초 안에 올라오고, 새 기록이 강조된다
  before.splice(0, before.length, { n: '', s: 400 }, { n: '연유', s: 399 }, { n: '두더지왕', s: env.posts[0].score }, { n: '석리송', s: 2 });
  env.advance(20000);
  await env.settle();
  assert.match(env.$('fame').innerHTML, /<li class="r2 me">.*두더지왕/);
  assert.equal(rows(env.$('fame').innerHTML), 3);

  env.$('again').fire('pointerdown');
  assert.equal(env.$('result').hidden, true);
  assert.equal(env.$('countdown').hidden, false);
});

// 닉네임을 화면에서 바로 적는 판: 순위 안에 든 결과 화면까지 간다
async function claimRound() {
  let mine = 0;
  const env = mole({
    board: [{ n: '연유', s: 399 }, { n: '석리송', s: 2 }],
    scoreReply: (b) => {
      if (b.api === 'game') { mine = b.score; return { ok: true, top: true, code: '0123456789abcdef', rank: 2, plays: 8, board: [{ n: '연유', s: 399 }, { n: '', s: mine }, { n: '석리송', s: 2 }] }; }
      if (/시발/.test(b.name)) return { ok: false, error: '쓸 수 없는 말이 들어 있습니다. 다른 닉네임을 적어 주세요' };
      return { ok: true, name: b.name, score: mine, rank: 2, board: [{ n: '연유', s: 399 }, { n: b.name, s: mine }, { n: '석리송', s: 2 }] };
    },
  });
  await env.settle();
  await playRound(env);
  assert.equal(env.$('claim').hidden, false);
  return env;
}

test('the screen keyboard puts Korean letters together the way a two-set keyboard does', async () => {
  const env = await claimRound();
  press(env, 'typeHere');                                   // 안내가 표시된 직후의 누름은 받지 않는다
  assert.equal(env.$('nick').hidden, true);
  env.advance(1000);
  press(env, 'typeHere');
  assert.equal(env.$('nick').hidden, false);
  assert.equal(typed(env), '');

  type(env, 'ㄷㅜㄷㅓㅈㅣ');
  assert.equal(typed(env), '두더지');
  press(env, 'kDel');                                       // 지우기는 낱자 하나. 남은 ㅈ은 모음이 오기 전까지 앞 글자의 받침이다
  assert.equal(typed(env), '두덪');
  press(env, 'kDel', 5);
  assert.equal(typed(env), '');

  type(env, 'ㄷㅏㄹㄱ');                                     // 겹받침
  assert.equal(typed(env), '닭');
  type(env, 'ㅣ');                                          // 뒤에 모음이 오면 뒤 낱자가 다음 글자의 첫소리로 넘어간다
  assert.equal(typed(env), '달기');
  press(env, 'kDel', 5);
  type(env, 'ㅇㅗㅏㅇㅡㅣ');                                 // 겹모음
  assert.equal(typed(env), '와의');
  press(env, 'kDel', 6);
  type(env, 'ㅎㅎ');                                        // 낱자만 적어도 된다
  assert.equal(typed(env), 'ㅎㅎ');
  press(env, 'kDel', 2);

  press(env, 'kShift');                                     // 쌍자음은 한 글자만
  type(env, 'ㄲㅜㅁ');
  assert.equal(typed(env), '꿈');
  assert.equal(keyOf(env, 'ㄲ'), undefined);
  press(env, 'kMode');                                      // 숫자
  assert.equal(env.$('kMode').textContent, '가나다');
  type(env, '7');
  press(env, 'kLang');                                      // 영어
  type(env, 'a');
  press(env, 'kShift');
  type(env, 'B');
  press(env, 'kSpace', 2);                                  // 띄어쓰기는 한 칸만
  type(env, 'c');
  assert.equal(typed(env), '꿈7aB c');
  press(env, 'kDel', 9);
  assert.equal(typed(env), '');

  press(env, 'kLang');
  type(env, 'ㄱㅏㄱㅏㄱㅏㄱㅏㄱㅏㄱㅏㄱㅏㄱㅏ');             // 8글자까지
  type(env, 'ㄴ');                                          // 여덟째 글자의 받침은 된다
  assert.equal(typed(env), '가가가가가가가간');
  type(env, 'ㅏ');                                          // 아홉째 글자가 되는 낱자는 받지 않는다
  assert.equal(typed(env), '가가가가가가가간');
  assert.equal(env.$('nMsg').textContent, '닉네임은 8글자까지입니다');
  assert.equal(env.posts.length, 1);                        // 적는 동안에는 서버로 보내지 않는다
});

test('a nickname typed on the screen is sent with the same one-time code as the QR, and the result shows the new rank', async () => {
  const env = await claimRound();
  env.advance(1000);
  press(env, 'typeHere');
  press(env, 'nSend');                                      // 빈 닉네임은 보내지 않는다
  assert.equal(env.$('nMsg').textContent, '닉네임을 적어 주세요');
  assert.equal(env.posts.length, 1);

  type(env, 'ㅅㅣㅂㅏㄹ');
  press(env, 'nSend');
  await env.settle();
  assert.deepEqual(env.posts[1], { api: 'gamename', code: '0123456789abcdef', name: '시발' });
  assert.equal(env.$('nick').hidden, false);                // 서버가 받지 않으면 이유를 보여 주고 그대로 둔다
  assert.match(env.$('nMsg').textContent, /쓸 수 없는 말/);

  press(env, 'kDel', 5);
  type(env, 'ㄷㅜㄷㅓㅈㅣㅇㅗㅏㅇ');
  press(env, 'nSend');
  press(env, 'nSend');                                      // 올리는 중에 다시 눌러도 한 번만 보낸다
  await env.settle();
  assert.equal(env.posts.length, 3);
  assert.equal(env.posts[2].name, '두더지왕');
  assert.equal(env.$('nick').hidden, true);
  assert.equal(env.$('claim').hidden, true);                // 적은 뒤에는 QR도 내린다(한 기록에 한 번)
  assert.equal(env.$('rRank').textContent, '🏆 두더지왕 · 명예의 전당 2위! 🎉');
  assert.match(env.$('fame').innerHTML, /<li class="r2 me">.*두더지왕/);
  press(env, 'typeHere');
  assert.equal(env.$('nick').hidden, true);
});

test('the click that follows a press does not land on whatever appears under the finger', async () => {
  // 누르는 순간 겹창이 열리거나 닫히면 브라우저는 뒤따라오는 click 을 손가락 아래에 새로 놓인 버튼으로 보낸다
  const env = await claimRound();
  env.advance(1000);
  press(env, 'typeHere');
  keyOf(env, 'ㅍ').fire('click');                           // 「화면에서 바로 적기」 아래에 놓인 키
  assert.equal(typed(env), '');
  type(env, 'ㄷㅜ');
  press(env, 'nClose');
  env.$('again').fire('click');                             // 「닫기」 아래에 놓인 「다시 하기」
  assert.equal(env.$('result').hidden, false);
  assert.equal(env.$('countdown').hidden, true);
  env.advance(1000);
  env.$('again').fire('click');                             // 누름 없이 온 click(리모컨 확인 버튼)은 받는다
  assert.equal(env.$('countdown').hidden, false);
});

test('the screen keyboard closes by itself when nobody types, and when the next round starts', async () => {
  const env = await claimRound();
  env.advance(1000);
  press(env, 'typeHere');
  type(env, 'ㄷㅜ');
  env.advance(59000);
  assert.equal(env.$('nick').hidden, false);
  type(env, 'ㄷ');                                          // 누를 때마다 다시 1분
  env.advance(59000);
  assert.equal(env.$('nick').hidden, false);
  env.advance(2000);
  assert.equal(env.$('nick').hidden, true);
  assert.equal(env.$('result').hidden, false);              // 결과 화면과 QR은 그대로
  assert.equal(env.$('claim').hidden, false);

  press(env, 'typeHere');
  assert.equal(typed(env), '');                             // 다시 열면 처음부터
  press(env, 'nClose');
  assert.equal(env.$('nick').hidden, true);
  press(env, 'again');
  assert.equal(env.$('countdown').hidden, false);
});

test('the phone nickname page lists named records only', async () => {
  const env = page(nameSource, { search: '?g=mole&c=0123456789abcdef', board: [{ n: '', s: 75 }, { n: '연유', s: 63 }, { n: '', s: 61 }] });
  await env.settle();
  assert.equal(env.$('board').hidden, false);
  assert.equal(rows(env.$('list').innerHTML), 1);
  assert.match(env.$('list').innerHTML, /🥇<\/span><span class="nm">연유/);
  assert.doesNotMatch(env.$('list').innerHTML, /닉네임 적는 중/);
});

test('the bar above a running project turns off browser gestures, so a hand resting there cannot swallow the touches inside the project', () => {
  // 막대(touch-action 기본값)에 닿은 손가락이 미끄러지면 브라우저가 터치 전체를 넘기기·확대 몸짓으로 가져가고,
  // 손가락을 모두 뗄 때까지 작품 안의 pointerdown 이 오지 않는다. iframe 을 감싼 .player 에 걸면 작품 안 스크롤이 막힌다
  assert.match(styleSource, /\.player-bar, \.player-msg \{ touch-action: none; \}/);
  assert.doesNotMatch(styleSource, /\.player(-body)? \{[^}]*touch-action/);
});

test('the nickname QR box really hides when the round did not reach the hall of fame', () => {
  // .claim 의 display: flex 가 hidden 속성을 덮으면 순위 밖 판에도 빈 QR 칸과 「휴대폰으로 닉네임 적기」가 표시된다
  assert.match(read('../site/games/mole/index.html'), /\.claim\[hidden\] \{ display: none; \}/);
});
