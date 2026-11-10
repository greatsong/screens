// Apps Script 버스 대리 호출(busArrivals_)을 구글 서비스 없이 확인한다: 시간 창, 30초 공유, 도착 기록, 인증키 비노출
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function script(start, opts = {}) {
  let nowMs = start;
  const cache = new Map();
  const props = { SEOUL_BUS_API_KEY: 'test+key/==' };
  const calls = [];
  let upstream = () => ({ msgHeader: { headerCd: '0' }, msgBody: { itemList: [] } });
  class TestDate extends Date {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return nowMs; }
  }
  const kst = (d) => new Date(d.getTime() + 9 * 3600000);
  const p2 = (n) => String(n).padStart(2, '0');
  const formatDate = (d, tz, f) => {
    const k = kst(d);
    const map = { yyyyMMdd: k.getUTCFullYear() + p2(k.getUTCMonth() + 1) + p2(k.getUTCDate()), H: String(k.getUTCHours()), m: String(k.getUTCMinutes()),
      u: String(k.getUTCDay() || 7), 'HH:mm': p2(k.getUTCHours()) + ':' + p2(k.getUTCMinutes()) };
    if (!(f in map)) throw new Error('format ' + f);
    return map[f];
  };
  const ctx = vm.createContext({
    console, Date: TestDate, JSON, Math, Number, String, Object, Array, Error, RegExp,
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, String(v)), remove: (k) => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate, sleep() {} },
    UrlFetchApp: { fetch: (url) => { calls.push(url); return { getContentText: () => JSON.stringify(upstream(url)) }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  });
  vm.runInContext(source + '\nglobalThis.api = { busArrivals_, doGet };', ctx);
  // advance: 30초 넘게 흐르면 30초 공유 기간이 지난 것으로 본다(모의 캐시에는 만료가 없다)
  return { api: ctx.api, calls, props, cache, advance(ms) { nowMs += ms; if (ms >= (opts.ttl || 40) * 1000) [...cache.keys()].filter((k) => /^bus[q]?:/.test(k)).forEach((k) => cache.delete(k)); }, setUpstream(fn) { upstream = fn; } };
}
const item = (sec, extra = {}) => ({ rtNm: '관악11', adirection: '봉천역', arrmsg1: sec ? Math.round(sec / 60) + '분후[2번째 전]' : '출발대기', traTime1: String(sec || 0), arrmsg2: '', traTime2: '0', term: '16', lastTm: '2330  ', ...extra });

test('the bus proxy answers only on weekdays between 07:30 and 19:00 and only for listed stops', () => {
  const noon = script(Date.parse('2026-11-10T06:00:00+09:00'));
  assert.deepEqual({ ...noon.api.busArrivals_('21348') }, { ok: false, closed: true });
  const sat = script(Date.parse('2026-11-14T15:30:00+09:00'));
  assert.equal(sat.api.busArrivals_('21348').closed, true);
  const env = script(Date.parse('2026-11-10T15:30:00+09:00'));
  assert.equal(env.api.busArrivals_('99999,abc').ok, false);
  assert.equal(noon.calls.length + sat.calls.length + env.calls.length, 0);
});

test('two screens within 30 seconds share one upstream call, and the key never reaches the reply', () => {
  const env = script(Date.parse('2026-11-10T15:30:00+09:00'));
  env.setUpstream(() => ({ msgHeader: { headerCd: '0' }, msgBody: { itemList: [item(250)] } }));
  const first = env.api.busArrivals_('21348,20507');
  const again = env.api.busArrivals_('21348,20507');
  assert.equal(env.calls.filter((u) => /stationinfo/.test(u)).length, 2);   // 정류장 두 곳, 한 번씩
  assert.equal(env.calls.filter((u) => /buspos\/getBusPosByRtid\?.*busRouteId=(114900004|119900011)/.test(u)).length, 2);   // 노선 두 개의 차량 위치도 한 번씩
  assert.equal(first.stops['21348'].buses[0].sec1, 250);
  assert.equal(first.stops['21348'].buses[0].last, '23:30');
  assert.equal(again.stops['21348'].at, first.stops['21348'].at);
  assert.match(env.calls[0], /serviceKey=test%2Bkey%2F%3D%3D&arsId=21348/);
  assert.deepEqual(JSON.parse(JSON.stringify(first.stops['21348'].pos)), []);   // 위치 응답에 좌표가 없으면 빈 목록
  assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(again), /test\+key|test%2Bkey/);
  const viaGet = JSON.parse(env.api.doGet({ parameter: { api: 'bus', stops: '21348' } }).text);
  assert.equal(viaGet.ok, true);
});

test('an arrival is logged once when a nearly arrived bus disappears from the reply, and comes back as history', () => {
  const env = script(Date.parse('2026-11-10T15:30:00+09:00'));
  let sec = 90;
  env.setUpstream(() => ({ msgHeader: { headerCd: '0' }, msgBody: { itemList: [item(sec)] } }));
  env.api.busArrivals_('21348');
  env.advance(41000); sec = 59;
  env.api.busArrivals_('21348');
  assert.equal(env.props.BUS_LOG, undefined);
  env.advance(41000); sec = 900;                        // 다음 차로 바뀜 → 앞차가 도착한 것
  env.api.busArrivals_('21348');
  env.advance(41000); sec = 870;
  const out = env.api.busArrivals_('21348');
  assert.deepEqual(JSON.parse(env.props.BUS_LOG), { 20261110: { '21348|관악11|봉천역': ['15:31'] } });
  assert.deepEqual(JSON.parse(JSON.stringify(out.log)), { 21348: { '관악11|봉천역': [{ d: '20261110', t: ['15:31'] }] } });
});

test('an upstream failure returns the last good reply instead of an error page', () => {
  const env = script(Date.parse('2026-11-10T15:30:00+09:00'));
  env.setUpstream(() => ({ msgHeader: { headerCd: '0' }, msgBody: { itemList: [item(300)] } }));
  const good = env.api.busArrivals_('21348');
  env.advance(41000);
  env.setUpstream(() => ({ msgHeader: { headerCd: '7', headerMsg: 'Key 인증 실패' } }));
  const bad = env.api.busArrivals_('21348');
  assert.equal(bad.ok, true);
  assert.equal(bad.stops['21348'].at, good.stops['21348'].at);
});

test('outside the after-school peak one upstream reply is shared for three minutes', () => {
  const env = script(Date.parse('2026-11-10T10:00:00+09:00'), { ttl: 180 });
  let puts = [];
  env.setUpstream(() => ({ msgHeader: { headerCd: '0' }, msgBody: { itemList: [item(400)] } }));
  env.api.busArrivals_('21348');
  env.advance(60000); env.api.busArrivals_('21348');
  env.advance(60000); env.api.busArrivals_('21348');
  assert.equal(env.calls.filter((u) => /stationinfo/.test(u)).length, 1);
  env.advance(181000); env.api.busArrivals_('21348');
  assert.equal(env.calls.filter((u) => /stationinfo/.test(u)).length, 2);
});

test('vehicle positions come back with each stop, without the plate number', () => {
  const env = script(Date.parse('2026-11-10T15:30:00+09:00'));
  env.setUpstream((url) => (/buspos/.test(url)
    ? { msgHeader: { headerCd: '0' }, msgBody: { itemList: [{ gpsY: '37.493812', gpsX: '126.936261', sectOrd: '1', stopFlag: '0', plainNo: '서울75사8744' }, { gpsY: '0', gpsX: '0', sectOrd: '3' }] } }
    : { msgHeader: { headerCd: '0' }, msgBody: { itemList: [item(300, { rtNm: '동작11', adirection: '노량진역' })] } }));
  const out = env.api.busArrivals_('20507');
  assert.deepEqual(JSON.parse(JSON.stringify(out.stops['20507'].pos)), [{ lat: 37.493812, lon: 126.936261, ord: 1, stop: 0 }]);
  assert.doesNotMatch(JSON.stringify(out), /8744/);
  assert.equal(out.stops['20507'].buses.length, 1);
});
