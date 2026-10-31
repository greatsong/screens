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
      querySelectorAll() { return []; }, addEventListener() {},
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
  const document = { getElementById: element, body: element('body'), hidden: false };
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
  vm.runInContext(appSource.slice(0, bootstrap) + '\n  globalThis.review = { state, applyContent, tick, act, locate, newsExpiry, newsDigestHTML, fetchWithin, contBeat, startExperience };\n})();', env.context);
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
