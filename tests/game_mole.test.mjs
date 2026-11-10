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

function page(source, { board = [], search = '', scoreReply = null, hiddenAtStart = [] } = {}) {
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
    requestAnimationFrame: (fn) => timer(fn, 16), cancelAnimationFrame: (id) => timers.delete(id),
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
const mole = (opts) => page(moleSource, Object.assign({ hiddenAtStart: ['countdown', 'result', 'claim'] }, opts));
const rows = (html) => (html.match(/<li/g) || []).length;

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
  env.$('start').fire('pointerdown');
  env.advance(3 * 800);
  for (let t = 0; t < 40000 && env.$('result').hidden; t += 50) {   // 결과가 뜰 때까지 올라온 두더지를 모두 누른다
    env.holes().filter((h) => h.classList.contains('up') && !h.classList.contains('hit')).forEach((h) => h.fire('pointerdown'));
    env.advance(50);
  }
  await env.settle();
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
