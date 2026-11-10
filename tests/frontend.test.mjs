import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const newsSource = fs.readFileSync(new URL('../site/news.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const START = Date.parse('2026-10-31T10:00:00+09:00');
const SECOND = 1000;
const HOUR = 3600000;

function browser({ role = 'a', time = START } = {}) {
  let currentTime = time;
  let nextTimer = 0;
  let fetchImpl = () => { throw new Error('Unexpected network request'); };
  const timers = new Map();
  const elements = new Map();
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const el = {
      id, hidden: true, textContent: '', innerHTML: '', clientHeight: 1000, offsetHeight: 0, offsetWidth: 0,
      style: { setProperty() {} },
      classList: {
        contains(name) { return classes.has(name); },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, value = !classes.has(name)) { if (value) classes.add(name); else classes.delete(name); return value; }
      },
      querySelectorAll() { return []; }, addEventListener() {}, appendChild() {},
      getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; }
    };
    el.parentNode = el;
    elements.set(id, el);
    return el;
  }
  const video = {
    paused: true, muted: false, currentTime: 0,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; }
  };
  element('promo').querySelector = (selector) => selector === 'video' ? video : element('soundHint');
  const document = { getElementById: element, body: element('body'), hidden: false, createElement: () => ({ className: '', innerHTML: '' }) };
  const schedule = (fn, delay, interval = 0) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: currentTime + delay, interval });
    return id;
  };
  const context = vm.createContext({
    console, Date: TestDate, URL, Promise, AbortController,
    document, location: { search: '?screen=' + role, href: 'https://example.invalid/screens/?screen=' + role, host: 'example.invalid', pathname: '/screens/' },
    window: {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 }, navigator: {},
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0' }),
    setTimeout: (fn, delay = 0) => schedule(fn, delay), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: (id) => timers.delete(id),
    fetch: (...args) => fetchImpl(...args)
  });
  function runDueTimers() {
    for (let i = 0; i < 1000; i++) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= currentTime);
      if (!due.length) return;
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        if (timer.interval) timer.at = currentTime + timer.interval;
        else timers.delete(id);
        timer.fn();
      }
    }
    throw new Error('Timer loop did not settle');
  }
  return {
    context, document, video, element,
    advance(ms) { currentTime += ms; runDueTimers(); },
    setTime(ms) { currentTime = ms; },
    now: () => currentTime,
    setFetch(fn) { fetchImpl = fn; }
  };
}

function screen(options) {
  const env = browser(options);
  const bootstrap = appSource.lastIndexOf('  if (role) startScreen();');
  assert.notEqual(bootstrap, -1, 'screen bootstrap must be found before VM instrumentation');
  vm.runInContext(appSource.slice(0, bootstrap) + '\n  globalThis.review = { state, applyContent, tick, act, locate, newsExpiry, newsDigestHTML, fetchWithin, contBeat, startExperience, mealRankHTML, slideQR, cardHTML, castVote, browse, projectHTML, newsReadHTML, busActive, busView, busHeadline, busPaint, maybeLoadBus };\n})();', env.context);
  return { ...env, ...env.context.review };
}

function content(extra = {}) {
  return { version: 1, mode: 'normal', slideSeconds: 12, items: [{ id: 'base', a: { title: 'Permanent card' } }], projects: [], ...extra };
}
function article(id, extra = {}) {
  return { id, title: id, date: '2026-10-31', cat: 'tech', source: 'Test source', link: 'https://example.invalid/' + id, ...extra };
}
function onPromoTime(time = START) { return Math.floor(time / 27000) * 27000 + 15000; }

// No polling or fetch occurs in the expiry tests: the local clock must be sufficient.
test('offline deadlines remove the visible notice, card and playing promo, leaving a safe empty state', () => {
  const env = screen({ time: onPromoTime() });
  const until = new Date(env.now() + SECOND).toISOString();
  env.applyContent(content({ notice: 'Temporary notice', noticeUntil: until,
    items: [{ id: 'temporary', until, a: { title: 'Temporary card' } }],
    promos: [{ id: 'promo', src: 'promo.mp4', every: 1, seconds: 15, until }] }), false);
  env.tick();
  assert.equal(env.element('notice').hidden, false);
  assert.equal(env.video.paused, false);
  env.advance(SECOND);
  env.tick();
  assert.equal(env.element('notice').hidden, true);
  assert.equal(env.state.sched.length, 0);
  assert.equal(env.video.paused, true);
  assert.equal(env.element('promo').hidden, true);
  assert.match(env.element('card').innerHTML, /지금 표시할 소식이 없습니다/);
  assert.doesNotMatch(env.element('card').innerHTML, /Temporary card/);
  assert.equal(env.element('dots').innerHTML, '');
});

test('offline expiry keeps other cards and activates future promos at their start boundary', () => {
  const env = screen();
  const from = new Date(env.now() + SECOND).toISOString();
  const until = new Date(env.now() + 2 * SECOND).toISOString();
  env.applyContent(content({ items: [{ id: 'temporary', until, a: { title: 'Temporary' } }, { id: 'base', a: { title: 'Permanent' } }],
    promos: [{ id: 'future', src: 'promo.mp4', from, until, every: 1, seconds: 15 }] }), false);
  env.tick();
  assert.equal(env.state.sched.some((entry) => entry.promo), false);
  env.advance(SECOND); env.tick();
  assert.equal(env.state.sched.some((entry) => entry.promo), true);
  env.advance(SECOND); env.tick();
  assert.equal(env.state.sched.length, 1);
  assert.equal(env.state.sched[0].item.id, 'base');
  assert.match(env.element('card').innerHTML, /Permanent/);
  assert.equal(env.video.paused, true);
});

test('emergency stop pauses audible video and resumes at the current synchronized position', () => {
  const env = screen({ time: onPromoTime() });
  const normal = content({ promoSound: true, promos: [{ id: 'promo', src: 'promo.mp4', every: 1, seconds: 15 }] });
  env.applyContent(normal, false); env.tick();
  assert.equal(env.video.paused, false);
  assert.equal(env.video.muted, false);
  env.applyContent({ ...normal, mode: 'stop' }, false);
  assert.equal(env.document.body.classList.contains('is-stopped'), true);
  assert.equal(env.element('promo').hidden, true);
  assert.equal(env.video.paused, true);
  env.advance(2600); env.tick();
  assert.equal(env.video.paused, true);
  env.applyContent(normal, false); env.tick();
  const at = env.locate(env.now(), env.state.sched, 12000);
  assert.equal(env.state.sched[at.idx].promo.id, 'promo');
  assert.equal(env.video.paused, false);
  assert.equal(env.element('promo').hidden, false);
  assert.ok(Math.abs(env.video.currentTime - at.elapsed / SECOND) < 0.001);
});

test('a pending autoplay rejection cannot restart video after emergency stop', async () => {
  const env = screen({ time: onPromoTime() });
  let rejectPlayback;
  env.video.play = function () { this.paused = false; return new Promise((resolve, reject) => { rejectPlayback = reject; }); };
  const normal = content({ promoSound: true, promos: [{ id: 'promo', src: 'promo.mp4', every: 1, seconds: 15 }] });
  env.applyContent(normal, false); env.tick();
  env.applyContent({ ...normal, mode: 'stop' }, false);
  rejectPlayback(new Error('play interrupted by pause'));
  await Promise.resolve();
  assert.equal(env.video.paused, true);
  assert.equal(env.element('promo').hidden, true);
});

test('a locally dismissed remote demo stays closed for the same request and reopens for a new request', () => {
  const env = screen({ role: 'b' });
  const data = content({ controlRequestId: 'request-1', showcase: { on: 'b', now: { url: 'https://example.invalid/demo', title: 'Demo' } } });
  env.applyContent(data, false);
  assert.equal(env.state.show.remote, true);
  env.act('back'); env.advance(0);
  env.applyContent({ ...data, version: 2 }, false);
  assert.equal(env.state.show.app, null);
  env.applyContent({ ...data, version: 3, controlRequestId: 'request-2' }, false);
  assert.equal(env.state.show.remote, true);
  assert.equal(env.state.show.app.url, data.showcase.now.url);
});

test('legacy remote requests require an observed clear before reopening a dismissed URL', () => {
  const env = screen({ role: 'b' });
  const data = content({ showcase: { on: 'b', now: { url: 'https://example.invalid/demo' } } });
  env.applyContent(data, false); env.act('back'); env.advance(0);
  env.applyContent({ ...data, version: 2 }, false);
  assert.equal(env.state.show.app, null);
  env.applyContent({ ...data, version: 3, showcase: { on: 'b', now: null } }, false);
  env.applyContent({ ...data, version: 4 }, false);
  assert.equal(env.state.show.remote, true);
});

test('hiding an active project closes its local experience and gallery immediately', () => {
  const env = screen({ role: 'b' });
  const project = { id: 'student-project', title: 'Student project', maker: 'Student', run: 'https://example.invalid/student', embed: true };
  const data = content({ projects: [project], showcase: { on: 'b' } });
  env.applyContent(data, false);
  env.act('gallery');
  env.context.review.startExperience(project.id);
  assert.equal(env.state.show.app.project.id, project.id);
  env.act('gallery'); // The gallery may be reopened while the experience is active.
  assert.equal(env.element('gallery').hidden, false);
  env.applyContent({ ...data, version: 2, projects: [] }, true);
  assert.equal(env.state.show.app, null);
  assert.equal(env.element('player').hidden, true);
  assert.equal(env.element('frame').src, 'about:blank');
  assert.equal(env.element('gallery').hidden, true);
});

test('an unchanged published project keeps the local session, but a changed run URL closes it', () => {
  const env = screen({ role: 'b' });
  const project = { id: 'student-project', title: 'Student project', maker: 'Student', run: 'https://example.invalid/student', embed: true };
  const data = content({ projects: [project], showcase: { on: 'b' } });
  env.applyContent(data, false);
  env.context.review.startExperience(project.id);
  const active = env.state.show;
  env.applyContent({ ...data, version: 2, projects: [{ ...project }] }, true);
  assert.equal(env.state.show, active);
  assert.equal(env.element('player').hidden, false);
  env.applyContent({ ...data, version: 3, projects: [{ ...project, run: 'https://example.invalid/replacement' }] }, true);
  assert.equal(env.state.show.app, null);
});

test('a new content version removes an open phone QR for an unpublished project', () => {
  const env = screen({ role: 'b' });
  const project = { id: 'phone-project', title: 'Phone project', run: 'https://example.invalid/phone', embed: false, short: 'example.invalid/p/1', shortUrl: 'https://example.invalid/p/1' };
  const data = content({ projects: [project], showcase: { on: 'b' } });
  env.applyContent(data, false);
  env.context.review.startExperience(project.id);
  assert.equal(env.element('gallery').hidden, false);
  assert.match(env.element('gallery').innerHTML, /example.invalid\/p\/1/);
  env.applyContent({ ...data, version: 2, projects: [] }, true);
  assert.equal(env.element('gallery').hidden, true);
  assert.equal(env.element('gallery').innerHTML, '');
});

test('both screens run a student project in place with a try button, and the screen that does not host remote demos keeps it open', () => {
  for (const role of ['a', 'b']) {
    const env = screen({ role });
    const project = { id: 'wide-project', title: 'Wide project', maker: 'Student', run: 'https://example.invalid/wide', embed: true, target: 'wide',
      short: 'example.invalid/p/2', shortUrl: 'https://example.invalid/p/2', summary: '', images: {} };
    const data = content({ projects: [project], showcase: { on: 'b' } });
    env.applyContent(data, false);
    const entry = env.state.sched.find((e) => e.project && e.project.id === project.id);
    assert.match(env.cardHTML ? env.context.review.projectHTML(entry.project) : '', /data-try="wide-project"/);
    env.context.review.startExperience(project.id);
    assert.equal(env.state.show.app.project.id, project.id);
    env.applyContent({ ...data, version: 2 }, true);                 // 콘텐츠를 다시 받아도(시연 화면이 아닌 A 포함) 닫히지 않는다
    assert.equal(env.state.show.app && env.state.show.app.project.id, project.id);
    env.act('back');
    assert.equal(env.state.show.app, null);
    assert.equal(env.element('player').hidden, true);
  }
});

test('an unpublished only-preview project can keep its local review experience', () => {
  const env = screen({ role: 'b' });
  const project = { id: 'review-project', title: 'Review project', run: 'https://example.invalid/review', embed: true };
  env.state.only = project;
  const data = content({ showcase: { on: 'b' } });
  env.applyContent(data, false);
  env.context.review.startExperience(project.id);
  const active = env.state.show;
  env.applyContent({ ...data, version: 2 }, true);
  assert.equal(env.state.show, active);
  assert.equal(env.element('player').hidden, false);
});

test('news cards and digest share the same active set and expire without a new version', () => {
  const env = screen({ time: Date.parse('2026-10-31T23:59:59+09:00') });
  const nextDay = '2026-11-01T00:00:00+09:00';
  env.applyContent(content({ news: [
    article('legacy-expiring', { date: '2026-10-29' }),
    article('exact-expiring', { until: nextDay }),
    article('still-live', { until: '2026-11-01T01:00:00+09:00' }),
    article('old', { date: '2026-10-28' }), article('invalid', { date: '2026-02-30' })
  ] }), false);
  assert.equal(env.state.news.length, 3);
  assert.match(env.newsDigestHTML({}), /legacy-expiring/);
  assert.doesNotMatch(env.newsDigestHTML({}), />old</);
  assert.equal(env.state.sched.some((entry) => entry.item && entry.item.id === 'news-digest'), true);
  env.advance(SECOND); env.tick();
  assert.equal(env.state.news.length, 1);
  assert.equal(env.state.news[0].id, 'still-live');
  assert.equal(env.state.sched.some((entry) => entry.item && entry.item.id === 'news-digest'), false);
  assert.equal(env.state.sched.some((entry) => entry.item && /legacy-expiring|exact-expiring/.test(entry.item.id)), false);
});

test('phone news uses the screen expiry policy and removes news from an already open page', async () => {
  const env = browser({ time: Date.parse('2026-10-31T23:59:59+09:00') });
  const data = content({ publishedAt: '2026-10-31T23:00:00+09:00', news: [article('expiring', { date: '2026-10-29' }), article('old', { date: '2026-10-28' })] });
  env.setFetch(() => Promise.resolve({ json: () => Promise.resolve(data) }));
  vm.runInContext(newsSource + '\nglobalThis.reviewNewsExpiry = newsExpiry;', env.context);
  await new Promise(setImmediate);
  assert.match(env.element('list').innerHTML, /expiring/);
  assert.doesNotMatch(env.element('list').innerHTML, />old</);
  const app = screen();
  for (const n of [article('legacy', { date: '2026-10-29' }), article('explicit', { until: '2026-11-01T02:00:00+09:00' }), article('invalid', { date: '' })]) {
    assert.equal(env.context.reviewNewsExpiry(n), app.newsExpiry(n));
  }
  env.advance(SECOND);
  assert.doesNotMatch(env.element('list').innerHTML, /<article>/);
  assert.match(env.element('when').textContent, /0건/);
});

test('a stalled response body times out after 15 seconds', async () => {
  const env = screen();
  env.setFetch(() => Promise.resolve({ headers: { get() { return null; } }, json: () => new Promise(() => {}) }));
  const pending = env.fetchWithin('content.json', {}, (response) => response.json());
  const rejected = assert.rejects(pending, /응답 시간 초과 15초/);
  await Promise.resolve();
  env.advance(15000);
  await rejected;
});

test('four hours asleep cannot count as four hours of continuous display', () => {
  const asleep = screen();
  asleep.advance(4 * HOUR); asleep.contBeat();
  assert.equal(asleep.state.cont.longest, 0);
  assert.equal(asleep.state.cont.breaks, 1);
  const awake = screen();
  for (let elapsed = 0; elapsed < 4 * HOUR; elapsed += 15000) { awake.advance(15000); awake.contBeat(); }
  assert.equal(awake.state.cont.longest, 4 * HOUR);
  awake.document.hidden = true;
  awake.advance(15000); awake.contBeat();
  assert.equal(awake.state.cont.start, awake.now());
});

test('meal appears every third card and the school calendar every fifth, meal first when they meet', () => {
  const env = screen();
  const base = Array.from({ length: 12 }, (_, i) => ({ id: 'b' + i, a: { title: 'Card ' + i } }));
  env.applyContent(content({ items: [
    { id: 'meal', every: 3, a: { auto: 'meal' }, b: { auto: 'mealweek' } },
    { id: 'schedule', every: 5, a: { auto: 'schedule' }, b: { auto: 'calendar' } },
    ...base
  ] }), false);
  const ids = Array.from(env.state.sched, (e) => e.item && e.item.id);   // VM 쪽 배열을 이 쪽 배열로 옮겨 비교한다
  const at = (id) => ids.map((x, i) => (x === id ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(at('meal').slice(0, 4), [2, 5, 8, 11]);
  assert.deepEqual(at('schedule').slice(0, 2), [4, 9]);
  assert.equal(ids.filter((x) => /^b\d+$/.test(x)).length, 12);  // every regular card still appears once per cycle
});

test('all-time meal TOP 3 shows only dishes from the real menu, so a made-up name sent to the vote API never reaches the TV', () => {
  const env = screen();
  env.state.meal = { days: { 20261102: { dishes: ['조각케이크', '바지락미역국', '배추김치'] } } };
  env.state.best = { total: 106, list: [{ k: '선생님 바보', n: 99 }, { k: '조각케이크', n: 4 }, { k: '<img src=x onerror=alert(1)>', n: 3 }, { k: '바지락미역국', n: 2 }] };
  const html = env.mealRankHTML({ tag: '역대 인기 급식' });
  assert.match(html, /조각케이크/);
  assert.match(html, /바지락미역국/);
  assert.doesNotMatch(html, /선생님 바보|src=x|alert\(1\)/);   // 그림 대체용 onerror 속성은 앱이 넣는 것이라 여기서 보지 않는다
  assert.match(html, /하트 6개/);                                       // 실제 메뉴의 하트만 더한다
  assert.ok(html.indexOf('p1') > -1 && html.indexOf('아직 없음') > -1);  // 3위 자리는 비워 둔다
  env.state.best = null;
  assert.match(env.mealRankHTML({}), /아직 하트가 모이는 중입니다/);
});



test('every tap on a meal counts at once and is sent in one batched request a second later, never lowering the shown count', async () => {
  const env = screen({ role: 'b' });
  env.state.content = { vote: { api: 'https://vote.invalid/exec' } };
  const sent = [];
  let reply;
  env.setFetch((url, opts) => { sent.push(JSON.parse(opts.body)); return new Promise((resolve) => { reply = resolve; }); });
  const tile = { classList: { add() {}, remove() {} }, offsetWidth: 0, appendChild() {} };
  const count = () => env.state.votes['20261104']['조각케이크'];
  for (let i = 0; i < 7; i++) env.castVote('20261104', '조각케이크', tile);
  assert.equal(count(), 7);                     // 누른 만큼 바로 보인다
  assert.equal(sent.length, 0);
  env.advance(SECOND);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].n, 7);                   // 1초 동안 누른 것을 한 번에 보낸다
  assert.equal(sent[0].src, 'screen');
  for (let i = 0; i < 3; i++) env.castVote('20261104', '조각케이크', tile);
  assert.equal(count(), 10);
  reply({ json: () => ({ ok: true, counts: { 조각케이크: 12 } }) });   // 다른 화면 표까지 더해진 서버 집계
  await new Promise((r) => setImmediate(r));
  assert.equal(count(), 15);                    // 서버 12 + 아직 안 보낸 3
  env.advance(SECOND);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].n, 3);
  reply({ json: () => ({ ok: false, retry: true }) });                // 1분 한도에 걸리면 다시 모아 둔다
  await new Promise((r) => setImmediate(r));
  assert.equal(count(), 15);
  env.advance(5 * SECOND);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].n, 3);
});

test('a swiped screen pages on its own, holds while touched, then rejoins the clock order so both screens match again', () => {
  const env = screen({ role: 'a' });
  const items = ['n1', 'n2', 'n3', 'n4'].map((id) => ({ id, a: { title: id } }));
  env.applyContent(content({ items, slideSeconds: 12 }), false);
  env.tick(); env.advance(SECOND);
  const clockIdx = () => env.locate(env.now(), env.state.sched, 12 * SECOND).idx;
  assert.equal(env.state.idx, clockIdx());
  env.browse(1);
  const mine = (clockIdx() + 1) % 4;
  assert.equal(env.state.idx, mine);              // 민 화면만 다음 카드로
  env.browse(-1); env.browse(-1);
  assert.equal(env.state.idx, (mine + 2) % 4);    // 뒤로도 넘어간다(한 바퀴 돌아서)
  for (let i = 0; i < 19; i++) { env.advance(SECOND); env.tick(); }
  assert.equal(env.state.idx, (mine + 2) % 4);    // 20초가 지나기 전에는 그대로
  for (let i = 0; i < 30 && (env.state.peek || env.state.idx !== clockIdx()); i++) { env.advance(SECOND); env.tick(); }
  assert.equal(env.state.peek, null);
  assert.equal(env.state.idx, clockIdx());        // 다시 시계 순서(옆 화면과 같은 카드)
});

test('the B news card differs from A: category picture, article QR and two other stories, all escaped', () => {
  const env = screen({ role: 'b' });
  env.state.news = [article('n1', { title: '첫 기사 <b>', cat: 'society' }), article('n2', { cat: 'tech' }), article('n3', { cat: 'science' })];
  const html = env.newsReadHTML({ newsId: 'n1', tag: 'AI와 사회', cat: 'society', title: '첫 기사 <b>', source: 'Test source', link: 'https://www.example.invalid/n1' });
  assert.match(html, /nread cat-society/);
  assert.match(html, /오늘의 AI 뉴스 1 \/ 3/);
  assert.match(html, /첫 기사 &lt;b&gt;/);
  assert.match(html, /기사 전체 읽기/);
  assert.match(html, /example\.invalid</);                       // 기사 주소는 도메인만
  assert.ok(html.indexOf('>n2<') > -1 && html.indexOf('>n3<') > -1);   // 다른 소식 두 건
  assert.doesNotMatch(html, /<p class="body">/);                       // 요약은 A 화면에만
});

test('public events join both screens, use the signup QR and expire without polling', () => {
  for (const role of ['a', 'b']) {
    const env = screen({ role });
    const until = new Date(env.now() + SECOND).toISOString();
    const event = { id: 'source:event', title: '새 행사 <script>', summary: '참여 안내', grades: '2학년',
      start: '2026-11-01', end: '2026-11-03', until, signupUrl: 'https://docs.google.com/forms/d/e/example/viewform' };
    env.applyContent(content({ events: [event] }), false);
    const entry = env.state.sched.find((e) => e.item?.id === 'event-source:event');
    assert.ok(entry);
    assert.equal(env.slideQR(entry), event.signupUrl);
    const html = env.cardHTML(entry.item[role]);
    assert.match(html, /휴대폰으로 신청/);
    assert.match(html, /새 행사 &lt;script&gt;/);
    assert.match(html, /2026-11-01 ~ 2026-11-03/);
    env.advance(SECOND); env.tick();
    assert.equal(env.state.sched.some((e) => e.item?.id === 'event-source:event'), false);
    env.applyContent(content({ events: [{ ...event, until: new Date(env.now() + SECOND).toISOString(), signupUrl: '' }] }), false);
    const pending = env.state.sched.find((e) => e.item?.id === 'event-source:event');
    assert.equal(env.slideQR(pending), '');
    assert.doesNotMatch(env.cardHTML(pending.item[role]), /qr-box/);
    env.applyContent(content({ events: [] }), false);
    assert.equal(env.state.sched.some((e) => e.item?.id === 'event-source:event'), false);
  }
});

test('a guide day alternates the welcome card with meal, calendar, news and projects, and only inside its dates', () => {
  const day = Date.parse('2026-11-11T10:12:00+09:00');
  const guide = { id: 'open', otherSeconds: 7, from: '2026-11-11T00:00:00+09:00', until: '2026-11-12T00:00:00+09:00', title: '환영합니다!', place: 'SW1실',
    says: ['<b>hi</b>'], steps: [{ start: '10:10', end: '10:20', name: '방명록 등록', place: 'AI 랩실', mong: 'arong' }, { start: '10:20', end: '11:10', name: '수업', place: 'SW1실', mong: '../x' }] };
  const data = content({ guides: [guide], promos: [{ id: 'promo', src: 'promo.mp4', every: 1, seconds: 15 }],
    items: [{ id: 'meal', every: 3, a: { title: 'Meal' } }, { id: 'schedule', every: 5, a: { title: 'Calendar' } }, { id: 'n1', a: { title: 'N1' } }, { id: 'n2', a: { title: 'N2' } }],
    projects: [{ id: 'p1', title: 'P1', images: {} }] });
  const kind = (e) => e.project ? e.project.id : e.item.id;
  for (const role of ['a', 'b']) {
    const env = screen({ role, time: day });
    env.applyContent(data, false);
    assert.equal(env.state.sched.map(kind).join(' '), ['guide-open', 'meal', 'guide-open', 'schedule', 'guide-open', 'n1', 'guide-open', 'p1',
      'guide-open', 'meal', 'guide-open', 'schedule', 'guide-open', 'n2', 'guide-open', 'p1'].join(' '));
    assert.equal(env.state.sched.map((e) => e.ms || 12000).join(' '), Array(8).fill('12000 7000').join(' '));   // 안내 12초, 나머지 7초
    env.setTime(Math.floor(day / (8 * 19000)) * 8 * 19000);   // 한 바퀴의 첫 칸 = 안내
    env.tick();
    const html = env.element('card').innerHTML;
    assert.match(html, role === 'a' ? /wc-right is-solo/ : /wc-left is-crowd/);
    assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
    assert.doesNotMatch(html, /\.\.\/x/);
    // 끝나는 시각이 되면 새 편성을 받지 않아도 평소 순서로 돌아간다
    env.setTime(Date.parse(guide.until));
    env.tick();
    assert.equal(env.state.sched.some((e) => e.item && e.item.id === 'guide-open'), false);
    assert.equal(env.state.sched.some((e) => e.promo), true);
  }
  const before = screen({ time: Date.parse('2026-11-09T15:00:00+09:00') });
  before.applyContent(data, false);
  assert.equal(before.state.sched.some((e) => e.item && e.item.id === 'guide-open'), false);
});

const BUS = { api: 'https://example.invalid/exec', from: '15:00', until: '17:00', every: 3,
  stops: [{ id: '21348', name: '당곡중고교', routes: ['관악11'], toward: '봉천역 방향', walkMin: 3 },
    { id: '20507', name: '사자암', routes: ['동작11'], toward: '7호선 방향', walkMin: 6 }] };

test('the bus card joins the rotation only on weekdays between 15:00 and 17:00, and never on a school holiday', () => {
  const data = content({ bus: BUS, items: Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, a: { title: 'Card ' + i } })) });
  const has = (env) => env.state.sched.some((e) => e.item && e.item.id === 'bus');
  const tue = screen({ time: Date.parse('2026-11-10T14:59:59+09:00') });
  tue.setFetch(() => new Promise(() => {}));
  tue.applyContent(data, false);
  assert.equal(has(tue), false);
  tue.advance(SECOND); tue.tick();                     // 15:00 정각에 새 편성 없이도 들어온다
  assert.equal(has(tue), true);
  assert.equal(Array.from(tue.state.sched, (e) => e.item && e.item.id).indexOf('bus'), 2);
  tue.setTime(Date.parse('2026-11-10T17:00:00+09:00')); tue.tick();
  assert.equal(has(tue), false);
  const sat = screen({ time: Date.parse('2026-11-14T15:30:00+09:00') });
  sat.applyContent(data, false);
  assert.equal(has(sat), false);
  const off = screen({ time: Date.parse('2026-11-10T15:30:00+09:00') });
  off.applyContent({ ...data, schedule: [{ name: '재량휴업일', start: '2026-11-10', end: '2026-11-10', holiday: true }] }, false);
  assert.equal(has(off), false);
});

test('each screen shows its own stop, counts the remaining time down, and treats a terminus by its inbound bus', async () => {
  const at = Date.parse('2026-11-10T15:20:00+09:00');
  const reply = (now) => ({ ok: true, now, stops: {
    21348: { at: now - 10000, buses: [{ route: '관악11', dir: '봉천역', msg1: '4분후', sec1: 250, sec2: 1200, term: 16 }, { route: '다른노선', dir: '어딘가', msg1: '1분후', sec1: 60 }] },
    20507: { at: now, buses: [{ route: '동작11', dir: '노량진역', msg1: '출발대기', sec1: null, sec2: null, term: 14 }, { route: '동작11', dir: '사자암', msg1: '7분후', sec1: 420 }] } },
    log: { 21348: { '관악11|봉천역': [{ d: '20261110', t: ['15:01'] }, { d: '20261109', t: ['13:00', '15:18', '15:35'] }] } } });
  for (const role of ['a', 'b']) {
    const env = screen({ role, time: at });
    const calls = [];
    env.setFetch((url) => { calls.push(String(url)); return Promise.resolve({ json: () => Promise.resolve(reply(env.now())) }); });
    env.applyContent(content({ bus: BUS }), false);
    env.state.idx = Array.from(env.state.sched, (e) => e.item && e.item.id).indexOf('bus');
    env.maybeLoadBus(env.now());
    env.maybeLoadBus(env.now());                       // 30초 안에는 다시 부르지 않는다
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(calls, ['https://example.invalid/exec?api=bus&stops=21348,20507']);
    const stop = BUS.stops[role === 'a' ? 0 : 1];
    const view = env.busView(stop);
    if (role === 'a') {
      assert.equal(Math.round(view.left1), 240);       // 서버가 10초 전에 받은 값이므로 250 - 10
      assert.equal(env.busHeadline(view).big, '4분 00초');
      env.advance(20 * SECOND);
      assert.equal(env.busHeadline(env.busView(stop)).big, '3분 40초');
      env.advance(170 * SECOND);                       // 받은 지 150초가 넘으면 오래된 값으로 보고 쓰지 않는다
      assert.equal(env.busView(stop).ready, false);
    } else {
      assert.equal(view.terminus, true);
      assert.equal(env.busHeadline(view).big, '7분 00초');
      assert.match(env.busHeadline(view).sub, /종점/);
    }
  }
});

test('a closed or failed bus reply leaves the card in its waiting state and outside the window nothing is requested', async () => {
  const env = screen({ time: Date.parse('2026-11-10T15:20:00+09:00') });
  let calls = 0;
  env.setFetch(() => { calls++; return Promise.resolve({ json: () => Promise.resolve({ ok: false, closed: true }) }); });
  env.applyContent(content({ bus: { ...BUS, rain: null } }), false);
  env.maybeLoadBus(env.now());
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(env.busHeadline(env.busView(BUS.stops[0])).big, '확인 중');
  const late = screen({ time: Date.parse('2026-11-10T18:00:00+09:00') });
  late.setFetch(() => { calls++; return Promise.resolve({ json: () => Promise.resolve({}) }); });
  late.applyContent(content({ bus: BUS }), false);
  late.maybeLoadBus(late.now());
  assert.equal(calls, 1);
});

test('the position counter counts only news, notices and projects, so a guide day does not inflate it', () => {
  const guide = { id: 'open', from: '2026-11-11T00:00:00+09:00', until: '2026-11-12T00:00:00+09:00', title: 'Hi', steps: [] };
  const env = screen({ time: Date.parse('2026-11-11T10:12:00+09:00') });
  env.applyContent(content({ guides: [guide],
    items: [{ id: 'meal', every: 3, a: { title: 'Meal' } }, { id: 'n1', a: { title: 'N1' } }, { id: 'n2', a: { title: 'N2' } }, { id: 'n3', a: { title: 'N3' } }],
    projects: [{ id: 'p1', title: 'P1', images: {} }] }), false);
  assert.equal(env.state.sched.length, 18);            // 안내가 끼어 칸은 18개지만
  env.tick();
  assert.match(env.element('dots').innerHTML, / \/ 4<\/span>/);   // 내용은 소식 3 + 작품 1
  assert.equal((env.element('dots').innerHTML.match(/<i /g) || []).length, 4);
});

test('during the bus window the news shrinks to its digest card and the bus returns every second card', () => {
  const env = screen({ time: Date.parse('2026-11-10T15:10:00+09:00') });
  env.setFetch(() => new Promise(() => {}));
  const data = content({ bus: { ...BUS, every: 2 }, items: [{ id: 'base', a: { title: 'Base' } }], news: [article('n1', { date: '2026-11-10' }), article('n2', { date: '2026-11-10' })] });
  env.applyContent(data, false);
  const ids = () => Array.from(env.state.sched, (e) => e.item && e.item.id);
  assert.deepEqual(ids(), ['news-digest', 'bus', 'base']);
  env.setTime(Date.parse('2026-11-10T17:00:00+09:00')); env.tick();
  assert.deepEqual(ids().filter((x) => /^news-/.test(x)).length, 3);   // 목록 + 기사 2건
  assert.equal(ids().includes('bus'), false);
});
