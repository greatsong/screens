// Apps Script 날씨 대리 호출(weather_)을 구글 서비스 없이 확인한다: 발표 회차 고르기, 정리한 모양, 20분 공유, 인증키 비노출
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function script(start, props = { KMA_AUTH_KEY: 'kma-secret' }) {
  let nowMs = start;
  const cache = new Map();
  const calls = [];
  let reply = () => [];
  class TestDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return nowMs; }
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const formatDate = (d, tz, f) => {
    const k = new Date(d.getTime() + 9 * 3600000);
    const map = { yyyyMMdd: k.getUTCFullYear() + p2(k.getUTCMonth() + 1) + p2(k.getUTCDate()), H: String(k.getUTCHours()), HH: p2(k.getUTCHours()) };
    if (!(f in map)) throw new Error('format ' + f);
    return map[f];
  };
  const body = (items) => ({ getContentText: () => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: items } } } }) });
  const ctx = vm.createContext({
    console, Date: TestDate, JSON, Math, Number, String, Object, Array, Error, RegExp, isNaN, parseFloat, encodeURIComponent,
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, String(v)), remove: (k) => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty() {} }) },
    Utilities: { formatDate, sleep() {} },
    UrlFetchApp: { fetchAll: (reqs) => reqs.map((r) => { calls.push(r.url); return body(reply(r.url)); }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  });
  vm.runInContext(source + '\nglobalThis.api = { weather_, doGet };', ctx);
  return { api: ctx.api, calls, cache, advance(ms) { nowMs += ms; }, setReply(fn) { reply = fn; } };
}
const fc = (date, time, values) => Object.entries(values).map(([category, fcstValue]) => ({ category, fcstDate: date, fcstTime: time, fcstValue: String(fcstValue) }));
const dayHours = (date, from, to, values) => Array.from({ length: to - from + 1 }, (_, i) => fc(date, String(from + i).padStart(2, '0') + '00', { TMP: 5 + i, POP: 10, SKY: 1, PTY: 0, WSD: 2, SNO: '적설없음', ...values(from + i) })).flat();

test('the weather proxy picks the latest issue, adds today\'s 02:00 run, and returns the screen shape', () => {
  const env = script(Date.parse('2026-11-10T16:05:00+09:00'));
  env.setReply((url) => {
    if (/getUltraSrtNcst/.test(url)) return [{ category: 'T1H', obsrValue: '11.4' }, { category: 'PTY', obsrValue: '0' }, { category: 'WSD', obsrValue: '3.1' }];
    if (/base_time=0200/.test(url)) return [...dayHours('20261110', 3, 14, () => ({})), ...fc('20261110', '0600', { TMN: 1 }), ...fc('20261110', '1500', { TMX: 12 })];
    return [...dayHours('20261110', 15, 23, (h) => (h === 17 ? { PTY: 1, POP: 80 } : {})),
      ...dayHours('20261111', 0, 23, (h) => (h === 9 ? { PTY: 3, SNO: '2.0cm', POP: 70 } : { SKY: 4 })), ...fc('20261111', '0600', { TMN: -3 }), ...fc('20261111', '1500', { TMX: 4 })];
  });
  const out = env.api.weather_();
  assert.equal(out.ok, true);
  assert.equal(env.calls.length, 3);
  assert.match(env.calls[0], /getVilageFcst\?.*base_date=20261110&base_time=1400&nx=59&ny=125/);   // 16:05 → 14시 발표분
  assert.match(env.calls[1], /getUltraSrtNcst\?.*base_time=1500/);
  assert.deepEqual({ ...out.cur }, { temp: 11.4, wind: 3.1, code: 0 });
  assert.equal(out.hourly.length, 21 + 24);                                  // 오늘 03~23시(02시 발표분 + 최신), 내일 24시간
  const at17 = out.hourly.filter((x) => x.d === '20261110' && x.h === 17)[0];
  assert.deepEqual({ ...at17 }, { d: '20261110', h: 17, temp: 7, pop: 80, code: 61, wind: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(out.daily)), [{ d: '20261110', code: 61, max: 12, min: 1, pop: 80 }, { d: '20261111', code: 75, max: 4, min: -3, pop: 70 }]);
  assert.doesNotMatch(JSON.stringify(out), /kma-secret/);
  env.advance(10 * 60000);
  env.api.weather_();
  assert.equal(env.calls.length, 3);                                         // 20분 안에는 다시 부르지 않는다
  assert.equal(JSON.parse(env.api.doGet({ parameter: { api: 'weather' } }).text).ok, true);
});

test('before the first issue of the day it uses last night\'s 23:00 run, and without a key it says so', () => {
  const env = script(Date.parse('2026-11-10T01:30:00+09:00'));
  env.setReply((url) => (/getVilageFcst/.test(url) ? dayHours('20261110', 0, 23, () => ({})) : []));
  const out = env.api.weather_();
  assert.match(env.calls[0], /base_date=20261109&base_time=2300/);
  assert.equal(env.calls.length, 2);
  assert.equal(out.cur, null);                                               // 실황을 못 받으면 비워 둔다
  const none = script(Date.parse('2026-11-10T16:05:00+09:00'), {});
  assert.deepEqual({ ...none.api.weather_() }, { ok: false, error: '인증키 없음' });
  assert.equal(none.calls.length, 0);
});
