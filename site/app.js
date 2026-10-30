/*
 * 당곡고 스탠바이미 화면 시험 페이지
 * 주소: ?screen=a (소식) · ?screen=b (깊이 보기) · ?preview (두 화면 미리보기) · 인자 없음 (역할 선택)
 * 목적: 전체 화면, 전원 복귀, 자동 꺼짐, 터치, 학생 작품 시연 같은 기기 동작과
 *       반영 지연, 두 화면 동기를 현장에서 확인한다.
 * webOS 브라우저(구형 Chromium)에서도 돌도록 ?. 와 ?? 는 사용하지 않는다.
 */
(function () {
  'use strict';

  const APP_VERSION = '0.4.0';
  const ROLE_LABEL = { a: 'A · 소식', b: 'B · 깊이 보기' };
  // 작품 카드 배지(선생님·1·2·3학년). 아이콘은 Codex CLI가 그린 site/icons/*.svg를 그대로 넣었다.
  const MAKER_BADGE = {
    teacher: { label: '선생님 작품', icon: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15 6 21M15 15l3 6M12 15v5"/><rect x="4" y="3" width="16" height="12" rx="1.5" fill="currentColor" fill-opacity="0.18"/><path d="M8 7h8M8 10.5h5M3 15h18"/></svg>' },
    g1: { label: '1학년', icon: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-5"/><path d="M12 16c-4 0-6.5-2.3-6.5-5.5C9.3 10.5 12 12.8 12 16ZM12 16c4 0 6.5-2.3 6.5-5.5C14.7 10.5 12 12.8 12 16Z" fill="currentColor" fill-opacity="0.18"/><path d="M5 21h14"/></svg>' },
    g2: { label: '2학년', icon: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-9"/><path d="M12 12c-3.5 0-5.5-2.2-5.5-5.5C9.8 6.5 12 8.8 12 12ZM12 12c3.5 0 5.5-2.2 5.5-5.5C14.2 6.5 12 8.8 12 12ZM12 17c-4 0-6.5-1.7-6.5-5C9.3 12 12 13.8 12 17ZM12 17c4 0 6.5-1.7 6.5-5C14.7 12 12 13.8 12 17Z" fill="currentColor" fill-opacity="0.18"/><path d="M5 21h14"/></svg>' },
    g3: { label: '3학년', icon: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-5"/><path d="M8 15.5c-2.5 0-4-1.7-4-4 0-2 1.4-3.6 3.2-4C7.4 4.9 9.3 3 12 3s4.6 1.9 4.8 4.5c1.8.4 3.2 2 3.2 4 0 2.3-1.5 4-4 4-2 1-6 1-8 0Z" fill="currentColor" fill-opacity="0.18"/><path d="M5 21h14"/></svg>' },
  };
  function badgeHTML(type) {
    const b = MAKER_BADGE[type];
    return b ? `<span class="mbadge mb-${type}"><span class="mb-icon">${b.icon}</span>${b.label}</span>` : '';
  }
  const WD = ['일', '월', '화', '수', '목', '금', '토'];

  const app = document.getElementById('app');
  const $ = (id) => document.getElementById(id);

  // ---------- 저장소: 사용할 수 없는 환경에서도 화면은 그대로 동작해야 한다 ----------
  const KEY = 'dgs.';
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* 기록만 생략 */ }
    },
    del(k) {
      try { localStorage.removeItem(KEY + k); } catch (e) { /* 무시 */ }
    }
  };

  // ---------- 주소 해석 ----------
  function readParams() {
    const out = {};
    location.search.replace(/^\?/, '').split('&').forEach((kv) => {
      if (!kv) return;
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      out[k] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    });
    return out;
  }
  const params = readParams();
  const embed = 'embed' in params; // 미리보기 안의 화면은 기록을 남기지 않는다
  const role = (params.screen === 'a' || params.screen === 'b') ? params.screen
    : ('a' in params) ? 'a' : ('b' in params) ? 'b' : null;

  // ---------- 시간 표시 (기기 시간대와 상관없이 한국 시간) ----------
  function kst(ms) {
    const d = new Date(ms + 9 * 3600000);
    return { mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: WD[d.getUTCDay()] };
  }
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const hm = (ms) => { const k = kst(ms); return p2(k.h) + ':' + p2(k.mi); };
  const hms = (ms) => { const k = kst(ms); return p2(k.h) + ':' + p2(k.mi) + ':' + p2(k.s); };
  const mdhm = (ms) => { const k = kst(ms); return k.mo + '/' + k.d + ' ' + p2(k.h) + ':' + p2(k.mi); };
  function dur(ms) {
    ms = Math.max(0, ms);
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    if (h) return h + '시간 ' + (m % 60) + '분';
    if (m) return m + '분 ' + (Math.floor(ms / 1000) % 60) + '초';
    return Math.round(ms / 1000) + '초';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 시계 보정 ----------
  // Date 헤더는 초 단위라서 서버 시각은 [D, D+1초) 어딘가에 있다. 응답을 여러 번 받아 구간을 겹치면 오차가 줄어든다.
  // CDN은 Date를 전달 시각으로 다시 쓰므로 Age 헤더는 더하지 않는다.
  const clock = { offset: 0, err: null, samples: [] };
  function addClockSample(res, t0, t1) {
    const D = Date.parse(res.headers.get('Date') || '');
    if (isNaN(D)) return;
    clock.samples.push({ lo: D - t1, hi: D + 1000 - t0 });
    if (clock.samples.length > 24) clock.samples.shift();
    let lo = -Infinity;
    let hi = Infinity;
    for (let i = clock.samples.length - 1; i >= 0; i--) {
      const s = clock.samples[i];
      const nlo = Math.max(lo, s.lo);
      const nhi = Math.min(hi, s.hi);
      if (nlo > nhi) { clock.samples = clock.samples.slice(i + 1); break; } // 기기 시계가 바뀌었으면 오래된 표본을 버린다
      lo = nlo;
      hi = nhi;
    }
    clock.offset = Math.round((lo + hi) / 2);
    clock.err = Math.round((hi - lo) / 2);
  }
  const now = () => Date.now() + clock.offset;

  const state = {
    content: null, netOk: false, lastOk: 0, lastErr: 0, errors: 0, errMsg: '',
    slot: -1, idx: -1, minKey: -1, fadeTimer: null, pollAt: Date.now(), loopId: 0,
    sched: [], only: null, loadTimer: null,
    touch: false, startedAt: Date.now(), lastInteract: Date.now(),
    cont: { start: Date.now(), last: Date.now(), breaks: 0, longest: 0 },
    delay: store.get('delay', null), events: store.get('events', []),
    prevSession: null, session: null,
    font: '확인 중', qr: '불러오는 중', wake: '확인 전',
    diagTimer: null,
    show: { app: null, remote: false, until: 0 }, dismissedRemote: ''
  };

  // ---------- 기록 ----------
  function logEvent(msg) {
    state.events.push({ t: Date.now(), msg: msg });
    if (state.events.length > 40) state.events.shift();
    if (!embed) store.set('events', state.events);
  }
  function initSession() {
    if (embed) return;
    const list = store.get('sessions', []);
    state.prevSession = list.length ? list[list.length - 1] : null;
    state.session = { id: Date.now(), start: Date.now(), last: Date.now(), role: role };
    list.push(state.session);
    store.set('sessions', list.slice(-30));
    setInterval(beat, 30000);
  }
  function beat() {
    const list = store.get('sessions', []);
    state.session.last = Date.now();
    let found = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id === state.session.id) { list[i].last = state.session.last; found = true; break; }
    }
    if (!found) list.push(state.session);
    store.set('sessions', list.slice(-30));
  }
  // 연속 표시: 15초 박동이 90초 넘게 끊기거나(대기 모드로 스크립트가 멈춤) 화면이 가려지면 처음부터 다시 잰다.
  // 브라우저가 돌아가는 동안 패널만 꺼진 경우는 스크립트로 알 수 없으므로 사람이 확인한다.
  function contBeat() {
    const t = Date.now();
    const gap = t - state.cont.last;
    if (gap > 90000) {
      state.cont.breaks++;
      state.cont.start = t;
      logEvent('화면 멈춤 감지: ' + dur(gap) + ' 동안 이 페이지가 동작하지 않음');
    } else if (document.hidden) {
      state.cont.start = t;
    }
    state.cont.last = t;
    state.cont.longest = Math.max(state.cont.longest, t - state.cont.start);
  }
  function contBreak() {
    state.cont.breaks++;
    state.cont.start = Date.now();
  }

  function clearLogs() {
    ['sessions', 'events', 'delay'].forEach((k) => store.del(k));
    state.events = [];
    state.delay = null;
    state.prevSession = null;
    state.startedAt = Date.now();
    state.cont = { start: Date.now(), last: Date.now(), breaks: 0, longest: 0 };
    if (state.session) {
      state.session = { id: Date.now(), start: Date.now(), last: Date.now(), role: role };
      store.set('sessions', [state.session]);
    }
    logEvent('기록 지움');
  }

  // ---------- QR ----------
  function qrLink(link) {
    try { return encodeURI(decodeURI(link)); } catch (e) { return link; }
  }
  function drawQR(box, text, level) {
    if (!box) return;
    if (typeof window.qrcode !== 'function') {
      box.innerHTML = '<div class="qr-fallback">' + (window.__qrFailed ? 'QR을 만들 수 없습니다' : 'QR 준비 중') + '</div>';
      return;
    }
    try {
      const q = window.qrcode(0, level || 'M');
      q.addData(text);
      q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
      box.innerHTML = '<div class="qr-fallback">QR 생성 실패</div>';
    }
  }
  window.__qrReady = function () {
    state.qr = '불러옴';
    if (role && state.idx >= 0) drawSlideQR(state.sched[state.idx]);
  };

  // ======================================================================
  // 화면 (A·B)
  // ======================================================================
  function startScreen() {
    if (!embed) store.set('role', role);
    document.title = '당곡고 화면 ' + role.toUpperCase();
    document.body.classList.add('role-' + role);
    buildShell();
    if (typeof window.qrcode === 'function') state.qr = '불러옴';
    else if (window.__qrFailed) state.qr = '실패';

    const cached = store.get('content', null);
    if (cached && !params.only) { try { applyContent(cached, false); } catch (e) { /* 캐시가 깨졌으면 네트워크를 기다린다 */ } }
    if (params.only) loadOnly(params.only);

    initSession();
    logEvent('화면 시작 (' + ROLE_LABEL[role] + ')');
    bindInput();
    requestWake();
    checkFont();
    probeClock(7);
    pollLoop();
    watchPoll();
    setInterval(contBeat, 15000);
    setInterval(tick, 200);
    setInterval(renderStatus, 15000);
    setTimeout(() => { if (window.__qrFailed && state.qr !== '불러옴') state.qr = '실패'; }, 10000);
    tick();
  }

  function buildShell() {
    app.innerHTML = `
      <div class="screen" id="screen">
        <header class="top">
          <div class="brand">
            <span class="school" id="school">당곡고등학교</span>
            <span class="role">${ROLE_LABEL[role]}</span>
            <span class="badge" id="badge" hidden></span>
          </div>
          <div class="when"><span class="date" id="date"></span><span class="clock" id="clock"></span></div>
        </header>
        <main class="stage"><article class="card" id="card"></article></main>
        <div class="stop" id="stop">
          <div class="stop-clock" id="stopClock"></div>
          <div class="stop-date" id="stopDate"></div>
          <p class="stop-msg" id="stopMsg"></p>
        </div>
        <div class="notice" id="notice" hidden></div>
        <footer class="bottom">
          <div class="dots" id="dots"></div>
          <button class="show-btn" id="showBtn" data-act="gallery" hidden>▶ 작품 체험하기</button>
          <div class="status" id="status">콘텐츠 확인 중</div>
        </footer>
        <div class="progress"><div class="bar" id="bar"></div></div>
      </div>
      <div class="gallery" id="gallery" hidden></div>
      <div class="player" id="player" hidden>
        <div class="player-bar">
          <button class="pbtn go" data-act="back">끝내기</button>
          <span class="player-title" id="playerTitle"></span>
          <span class="player-left" id="playerLeft"></span>
          <button class="pbtn" data-act="more">시간 연장 +3분</button>
          <button class="pbtn phone" data-act="phone">휴대폰으로 이어서</button>
        </div>
        <div class="player-body">
          <iframe id="frame" title="작품" allow="fullscreen; autoplay; camera; microphone; accelerometer; gyroscope"></iframe>
          <div class="player-msg" id="playerMsg" hidden></div>
        </div>
      </div>
      <div class="diag" id="diag" hidden>
        <div class="diag-bar">
          <strong>진단 정보 · ${ROLE_LABEL[role]}</strong>
          <span class="diag-actions">
            <button class="btn" data-act="fullscreen">전체 화면</button>
            <button class="btn" data-act="swap">역할 바꾸기</button>
            <button class="btn" data-act="reload">새로 고침</button>
            <button class="btn" data-act="clear">기록 지우기</button>
            <button class="btn primary" data-act="close">닫기</button>
          </span>
        </div>
        <div class="diag-body" id="diagBody"></div>
      </div>`;
  }

  // ---------- 콘텐츠 ----------
  // 응답이 오지 않는 요청 하나 때문에 갱신 전체가 멈추지 않도록 본문까지 받는 시간을 제한한다
  const FETCH_TIMEOUT = 15000;
  function fetchWithin(url, opts, read) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const o = Object.assign({ cache: 'no-store' }, opts, ctrl ? { signal: ctrl.signal } : {});
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        reject(new Error('응답 시간 초과 ' + FETCH_TIMEOUT / 1000 + '초'));
      }, FETCH_TIMEOUT);
    });
    const t0 = Date.now();
    const work = fetch(url, o).then((res) => {
      addClockSample(res, t0, Date.now());
      return read ? read(res) : res;
    });
    return Promise.race([work, timeout]).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; });
  }

  function probeClock(times) {
    let n = 0;
    (function one() {
      fetchWithin('content.json?probe=' + Date.now(), { method: 'HEAD' })
        .catch(() => {})
        .then(() => { if (++n < times) setTimeout(one, 330); });
    })();
  }

  function pollContent() {
    state.pollAt = Date.now();
    return fetchWithin('content.json?t=' + Date.now(), {}, (res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
      .then((data) => {
        applyContent(data, true);
        state.lastOk = Date.now();
        state.netOk = true;
      })
      .catch((err) => {
        state.errors++;
        state.lastErr = Date.now();
        state.errMsg = String((err && err.message) || err);
        logEvent('콘텐츠 확인 실패: ' + state.errMsg);
        if (!state.content) $('card').innerHTML = '<p class="body">콘텐츠를 불러오지 못했습니다. 네트워크 연결을 확인합니다.</p>';
      })
      .then(renderStatus);
  }

  function pollMs() {
    const sec = state.content && state.content.pollSeconds;
    return Math.max(20, sec || 60) * 1000;
  }
  function pollLoop() {
    const id = ++state.loopId; // 감시가 새 고리를 시작하면 예전 고리는 스스로 멈춘다
    const next = () => { if (id === state.loopId) setTimeout(pollLoop, pollMs()); };
    try { pollContent().then(next, next); } catch (e) { next(); }
  }
  function watchPoll() {
    setInterval(() => {
      if (Date.now() - state.pollAt > Math.max(120000, pollMs() * 3)) {
        logEvent('콘텐츠 확인이 멈춰 다시 시작');
        pollLoop();
      }
    }, 30000);
  }

  function applyContent(data, fromNet) {
    if (!data || !Array.isArray(data.items) || !data.items.length) throw new Error('콘텐츠 형식 오류');
    const prev = state.content;
    state.content = data;
    state.sched = buildSchedule(data);
    if (fromNet && !embed) store.set('content', data);
    // 이 화면이 이미 한 번 받아 둔 뒤에 버전이 바뀐 경우에만 반영 지연을 잰다
    if (fromNet && state.netOk && prev && prev.version !== data.version) {
      // 화면 제어 요청(긴급 정지·공지·원격 시연)이면 요청한 시각부터, 그 밖의 변경이면 편성한 시각부터 잰다
      const fromReq = !!(data.controlRequestId && data.controlRequestId !== prev.controlRequestId && data.requestedAt);
      const pub = Date.parse(fromReq ? data.requestedAt : (data.publishedAt || ''));
      if (!isNaN(pub)) {
        state.delay = { version: data.version, ms: now() - pub, at: now(), from: fromReq ? '요청' : '편성' };
        if (!embed) store.set('delay', state.delay);
      }
      logEvent('콘텐츠 v' + prev.version + ' → v' + data.version);
    }
    if (!prev || prev.version !== data.version) state.slot = -1;
    $('school').textContent = data.school || '당곡고등학교';
    const badge = $('badge');
    badge.hidden = !data.badge;
    badge.textContent = data.badge || '';
    $('stopMsg').textContent = data.stopMessage || '화면 점검 중입니다';
    const stopped = data.mode === 'stop';
    if (stopped !== isStopped()) {
      document.body.classList.toggle('is-stopped', stopped);
      $('screen').classList.toggle('is-stopped', stopped);
      logEvent(stopped ? '긴급 정지 화면으로 전환' : '평소 화면으로 전환');
    }
    renderNotice();
    // 긴급 정지는 작품 시연보다 항상 우선한다
    if (stopped) {
      closePlayer('긴급 정지');
      $('gallery').hidden = true;
      $('showBtn').hidden = true;
    } else {
      syncShowcase();
    }
    if (fromNet && data.appVersion && data.appVersion !== APP_VERSION) reloadForApp(data.appVersion);
  }

  function reloadForApp(target) {
    if (embed) return;
    const last = store.get('reloadFor', null);
    // 캐시 때문에 새 코드가 아직 도착하지 않았으면 새로 고침을 반복하지 않는다
    if (last && last.v === target && Date.now() - last.t < 15 * 60000) return;
    store.set('reloadFor', { v: target, t: Date.now() });
    logEvent('앱 ' + target + ' 버전으로 새로 고침');
    setTimeout(() => location.reload(), 500);
  }

  // ---------- 그리기 ----------
  function tick() {
    const t = now();
    const k = kst(t);
    const key = k.h * 60 + k.mi;
    if (key !== state.minKey) {
      state.minKey = key;
      const time = p2(k.h) + ':' + p2(k.mi);
      const date = k.mo + '월 ' + k.d + '일 (' + k.wd + ')';
      $('clock').textContent = time;
      $('date').textContent = date;
      $('stopClock').textContent = time;
      $('stopDate').textContent = date;
    }
    renderPlayer();
    if (!$('gallery').hidden && Date.now() - state.lastInteract > 60000) $('gallery').hidden = true;

    const c = state.content;
    if (!c || c.mode === 'stop' || !state.sched.length) return;
    const slideMs = Math.max(5, c.slideSeconds || 12) * 1000;
    // 두 화면이 같은 시각을 기준으로 계산하므로 서버 없이도 같은 순간에 같은 카드를 보여 준다
    const slot = Math.floor(t / slideMs);
    if (slot !== state.slot) {
      const first = state.slot === -1;
      state.slot = slot;
      showSlide(slot % state.sched.length, first);
      startBar(t % slideMs, slideMs);
    }
  }

  // 소식 카드 사이에 작품 카드를 끼워 넣는다. 두 화면이 같은 순서를 계산해야 같은 작품을 함께 보여 준다.
  function buildSchedule(c) {
    if (state.only) return [{ project: state.only }];
    const t = now();
    const items = (c.items || []).filter((x) => !x.until || Date.parse(x.until) > t); // 오래된 소식은 내린다
    const projs = c.projects || [];
    const every = Math.max(1, c.projectEvery || 2);
    const out = [];
    let p = 0;
    items.forEach((it, i) => {
      out.push({ item: it });
      if (projs.length && (i + 1) % every === 0) out.push({ project: projs[p++ % projs.length] });
    });
    while (p < projs.length) out.push({ project: projs[p++] }); // 모든 작품이 한 바퀴에 한 번은 나오게
    return out;
  }

  function loadOnly(id) {
    // 검토 화면의 미리보기: 게시 전 작품도 실제 화면과 같은 모양으로 보여 준다
    fetchWithin('projects/index.json?t=' + Date.now(), {}, (r) => r.json()).then((d) => {
      state.only = d.projects.filter((p) => p.id === id)[0] || null;
      if (state.content) { state.sched = buildSchedule(state.content); state.slot = -1; }
    }, () => {});
  }

  function entrySide(entry) { return entry && entry.item ? (entry.item[role] || entry.item.a || {}) : null; }

  // 휴대폰으로 이어서 체험할 작품(모바일용, 이 화면에서 실행할 수 없는 작품)에만 QR을 붙인다
  function needsQR(p) { return p.target !== 'wide' || !p.embed; }

  function slideQR(entry) {
    if (!entry) return '';
    if (entry.project) return needsQR(entry.project) ? entry.project.shortUrl : '';
    const s = entrySide(entry);
    return s && s.link ? qrLink(s.link) : '';
  }
  function drawSlideQR(entry) {
    const text = slideQR(entry);
    if (text) drawQR($('qr'), text, 'M');
  }

  function projectHTML(p) {
    const qr = needsQR(p);
    const how = p.embed
      ? (role === 'a' ? 'B 화면에서 「체험 시작」을 누르면 바로 해 볼 수 있습니다.' : '「체험 시작」을 누르면 이 화면에서 바로 해 볼 수 있습니다.')
      : '휴대폰으로 QR을 찍어 체험합니다.';
    const img = (p.target === 'mobile' && p.images.mobile) ? p.images.mobile : p.images.wide;
    const shot = img ? `<div class="shot${p.target === 'mobile' ? ' phone' : ''}"><img src="${esc(img)}" alt=""></div>` : '';
    const text = `
      <div class="tag">${role === 'a' ? '작품 소개' : '직접 체험'}${p.pinned ? ' · 추천' : ''}</div>
      <h1 class="title">${esc(p.title)}</h1>
      <div class="maker">${badgeHTML(p.makerType)}<span>만든 사람 · ${esc(p.maker)}</span></div>
      <p class="body">${esc(p.summary)}</p>`;
    const howHTML = `<div class="howto"><b>체험 방법</b>${esc(how)}${p.howTo ? ' ' + esc(p.howTo) : ''}</div>`;
    if (role === 'a') {
      return `<div class="proj proj-a">${shot}<div class="proj-text">${text}
        <div class="howto-row">${qr ? '<div class="qr-box mini" id="qr"></div>' : ''}<div>${howHTML}${qr ? `<div class="short">${esc(p.short)}</div>` : ''}</div></div>
      </div></div>`;
    }
    const tryBtn = p.embed ? `<button class="try-btn" data-try="${esc(p.id)}">▶ 체험 시작</button>` : '';
    const side = qr
      ? `<div class="qr big"><div class="qr-box" id="qr"></div><div class="qr-caption">휴대폰으로 체험<br><b>${esc(p.short)}</b></div></div>`
      : shot;
    return `<div class="proj proj-b"><div class="proj-text">${text}${howHTML}${tryBtn}</div>${side}</div>`;
  }

  function showSlide(idx, immediate) {
    state.idx = idx;
    const entry = state.sched[idx];
    renderDots(idx, state.sched.length);
    const card = $('card');
    const paint = () => {
      card.innerHTML = entry.project ? projectHTML(entry.project) : cardHTML(entrySide(entry));
      drawSlideQR(entry);
      card.classList.remove('out');
    };
    clearTimeout(state.fadeTimer);
    if (immediate) { paint(); return; }
    card.classList.add('out');
    state.fadeTimer = setTimeout(paint, 450);
  }

  function cardHTML(s) {
    const text =
      (s.tag ? `<div class="tag">${esc(s.tag)}</div>` : '') +
      (s.title ? `<h1 class="title">${esc(s.title)}</h1>` : '') +
      (s.body ? `<p class="body">${esc(s.body)}</p>` : '') +
      (s.lines ? `<ul class="lines">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '') +
      (s.question ? `<div class="question"><div class="q-label">생각해 볼 질문</div><p>${esc(s.question)}</p></div>` : '') +
      (s.source ? `<div class="source">${esc(s.source)}</div>` : '');
    const qr = s.link
      ? `<div class="qr"><div class="qr-box" id="qr"></div><div class="qr-caption">${esc(s.linkLabel || '휴대폰으로 자료 보기')}</div></div>`
      : '';
    return `<div class="card-inner"><div class="card-text">${text}</div>${qr}</div>`;
  }

  function renderDots(idx, n) {
    let html = '';
    for (let i = 0; i < n; i++) html += '<i class="' + (i === idx ? 'on' : '') + '"></i>';
    $('dots').innerHTML = html + '<span class="count">' + (idx + 1) + ' / ' + n + '</span>';
  }

  function startBar(elapsed, total) {
    const bar = $('bar');
    bar.style.transition = 'none';
    bar.style.width = (elapsed / total * 100) + '%';
    void bar.offsetWidth; // 위치를 먼저 확정해야 남은 시간만큼 이어서 움직인다
    bar.style.transition = 'width ' + (total - elapsed) + 'ms linear';
    bar.style.width = '100%';
  }

  function renderNotice() {
    const c = state.content;
    const el = $('notice');
    if (!c || !el) return;
    const sc = c.showcase || {};
    const parts = [];
    const remote = remoteInfo();
    // 기한이 지난 공지는 내린다
    if (c.notice && !(c.noticeUntil && Date.parse(c.noticeUntil) <= now())) parts.push('<b>공지</b>' + esc(c.notice));
    if (remote && sc.on && sc.on !== role) {
      parts.push('<b>시연</b>' + esc(sc.where || '옆 화면') + '에서 작품을 시연하고 있습니다 · ' +
        esc(remote.title) + (remote.by ? ' (' + esc(remote.by) + ')' : ''));
    }
    el.hidden = !parts.length;
    el.innerHTML = parts.map((p) => '<div>' + p + '</div>').join('');
  }

  function renderStatus() {
    const el = $('status');
    if (!el) return;
    const c = state.content;
    const hint = Date.now() - state.startedAt < 180000 ? '화면을 누르면 진단 정보가 표시됩니다 · ' : '';
    let text;
    if (!state.lastOk && !state.lastErr) text = '콘텐츠 확인 중';
    else if (state.lastErr > state.lastOk) text = '<span class="warn">연결 끊김 · 이전 내용 표시 중</span>';
    else if (Date.now() - state.lastOk > 5 * 60000) text = '<span class="warn">갱신 지연 · ' + hm(state.lastOk + clock.offset) + ' 마지막 확인</span>';
    else text = 'v' + (c ? esc(c.version) : '?') + ' · ' + hm(state.lastOk + clock.offset) + ' 확인';
    el.innerHTML = esc(hint) + text;
  }

  // ---------- 학생 작품 시연 ----------
  function findProject(key) {
    const list = (state.content && state.content.projects) || [];
    const hit = list.filter((p) => p.id === key || String(p.no) === String(key))[0];
    return hit || (state.only && state.only.id === key ? state.only : null);
  }

  // 원격 시연: showcase.now 에 작품 id(또는 번호)나 주소가 들어 있다
  function remoteInfo() {
    const n = state.content && state.content.showcase && state.content.showcase.now;
    if (!n) return null;
    const p = n.project ? findProject(n.project) : null;
    if (p) return { title: p.title, by: p.maker, url: p.run, project: p };
    return n.url ? { title: n.title || n.url, by: n.by || '', url: n.url } : null;
  }

  function syncShowcase() {
    if (!state.content || isStopped()) return;
    const sc = state.content.showcase || {};
    const here = sc.on === role;
    const count = (state.content.projects || []).length || (sc.apps || []).length;
    $('showBtn').hidden = !(here && count);
    if (!here) { if (state.show.app) closePlayer('역할 변경'); return; }
    const remote = remoteInfo();
    if (!remote) state.dismissedRemote = '';
    // 학생이 체험하는 중에는 원격 시연도 끼어들지 않는다. 체험이 끝나면 이어서 연다.
    if (state.show.app && !state.show.remote) return;
    if (remote && remote.url !== state.dismissedRemote && (!state.show.app || state.show.app.url !== remote.url)) openPlayer(remote, true);
    else if (!remote && state.show.remote) closePlayer('원격 시연 끝');
  }

  function isStopped() { return document.body.classList.contains('is-stopped'); }
  function holdMinutes() {
    const e = (state.content && state.content.experience) || {};
    return Math.min(5, Math.max(3, e.holdMinutes || 4));
  }
  function maxMinutes() {
    const e = (state.content && state.content.experience) || {};
    return Math.max(holdMinutes(), e.maxMinutes || 15);
  }

  function openGallery() {
    if (isStopped()) return;
    const c = state.content;
    const projs = c.projects || [];
    const apps = projs.length ? [] : ((c.showcase || {}).apps || []); // 등록 작품이 없을 때만 예전 목록을 사용한다
    const cards = projs.map((p) => `
        <button class="app-card" data-try="${esc(p.id)}">
          ${p.images && p.images.wide ? `<img class="app-shot" src="${esc(p.images.wide)}" alt="">` : ''}
          ${badgeHTML(p.makerType)}
          <span class="app-title">${esc(p.title)}</span>
          <span class="app-by">${esc(p.maker)}</span>
          <span class="app-host">${p.embed ? '이 화면에서 체험' : '휴대폰으로 체험 (QR)'}</span>
        </button>`).concat(apps.map((a, i) => `
        <button class="app-card" data-app="${i}">
          <span class="app-title">${esc(a.title)}</span>
          <span class="app-by">${esc(a.by || '')}</span>
          <span class="app-host">${esc(hostOf(a.url))}</span>
        </button>`));
    $('gallery').innerHTML = `
      <div class="gallery-head"><h2>작품 체험</h2><button class="btn primary" data-act="gclose">닫기</button></div>
      <p class="gallery-note">작품을 누르면 이 화면에서 ${holdMinutes()}분 동안 실행합니다. 체험하는 동안에는 다른 작품으로 넘어가지 않습니다.</p>
      <div class="gallery-grid">${cards.join('')}</div>`;
    $('gallery').hidden = false;
  }

  function startExperience(key) {
    const p = findProject(key);
    if (!p || isStopped()) return;
    if (!p.embed) { showQRPanel(p); return; }
    openPlayer({ title: p.title, by: p.maker, url: p.run, project: p }, false);
  }

  // 이 화면 안에서 실행할 수 없는 작품은 휴대폰 체험으로 안내한다
  function showQRPanel(p) {
    $('gallery').innerHTML = `
      <div class="gallery-head"><h2>${esc(p.title)}</h2><button class="btn primary" data-act="gclose">닫기</button></div>
      <div class="qr-panel">
        <div class="qr big"><div class="qr-box" id="panelQR"></div></div>
        <div class="qr-panel-text">
          <p class="body">휴대폰 카메라로 QR을 찍거나 아래 주소에 접속해 체험합니다.</p>
          <p class="short-big">${esc(p.short)}</p>
          <p class="gallery-note">이 작품은 다른 사이트 안에서 실행할 수 없어 휴대폰으로 안내합니다.</p>
        </div>
      </div>`;
    $('gallery').hidden = false;
    state.lastInteract = Date.now();
    drawQR($('panelQR'), p.shortUrl, 'M');
  }

  function hostOf(url) {
    try {
      const u = new URL(url, location.href);
      return u.host === location.host ? '이 사이트 안의 작품' : u.host;
    } catch (e) { return url; }
  }

  function openPlayer(info, remote) {
    if (isStopped()) return;
    const t = now();
    const mine = { app: info, remote: !!remote, started: t, until: remote ? 0 : t + holdMinutes() * 60000, loaded: false };
    state.show = mine;
    $('playerTitle').textContent = (info.title || info.url) + (info.by ? ' · ' + info.by : '');
    $('player').classList.toggle('remote', !!remote);
    $('player').classList.toggle('has-phone', !!(info.project && info.project.shortUrl));
    $('playerMsg').hidden = true;
    const frame = $('frame');
    frame.onload = () => { if (state.show === mine) mine.loaded = true; };
    frame.src = info.url;
    $('gallery').hidden = true;
    $('player').hidden = false;
    // 작품이 열리지 않아도 게시판 전체가 멈추지 않도록, 20초 안에 열리지 않으면 휴대폰 안내를 띄운다
    clearTimeout(state.loadTimer);
    state.loadTimer = setTimeout(() => { if (state.show === mine && !mine.loaded) playerMessage('작품을 불러오지 못했습니다.'); }, 20000);
    logEvent('체험 시작' + (remote ? ' (원격)' : '') + ': ' + (info.title || info.url));
    renderPlayer();
  }

  // 작품 위에 안내를 겹쳐 보인다. 작품 안의 터치는 이 페이지가 알 수 없으므로 시간 연장·끝내기는 버튼으로만 받는다.
  function playerMessage(text) {
    const p = state.show.app && state.show.app.project;
    const el = $('playerMsg');
    el.innerHTML = `<div class="pm-box"><p class="pm-text">${esc(text)}</p>` +
      (p && p.shortUrl ? `<div class="qr-box" id="pmQR"></div><p class="pm-short">휴대폰으로 체험 · <b>${esc(p.short)}</b></p>` : '') +
      '<div><button class="btn primary" data-act="back">끝내기</button><button class="btn" data-act="pmclose">계속 보기</button></div></div>';
    el.hidden = false;
    if (p && p.shortUrl) drawQR($('pmQR'), p.shortUrl, 'M');
  }

  function closePlayer(why) {
    if (!state.show.app) return;
    logEvent('체험 끝 (' + why + '): ' + (state.show.app.title || state.show.app.url));
    state.show = { app: null, remote: false, until: 0 };
    clearTimeout(state.loadTimer);
    $('player').hidden = true;
    $('playerMsg').hidden = true;
    $('frame').src = 'about:blank';
    setTimeout(syncShowcase, 0); // 체험 중에 들어온 원격 시연이 있으면 이어서 연다
  }

  function renderPlayer() {
    if (!state.show.app) return;
    const el = $('playerLeft');
    if (state.show.remote) { el.textContent = '원격 시연 중'; return; }
    const ms = state.show.until - now();
    if (ms <= 0) { closePlayer('시간 종료'); return; }
    const s = Math.ceil(ms / 1000);
    const text = Math.floor(s / 60) + ':' + p2(s % 60) + ' 남음';
    if (el.textContent !== text) el.textContent = text;
  }

  // ---------- 입력 ----------
  function bindInput() {
    const touched = () => {
      state.lastInteract = Date.now();
      if (!state.touch) { state.touch = true; logEvent('터치 입력 확인'); }
    };
    document.addEventListener('pointerdown', (e) => {
      state.lastInteract = Date.now();
      if (e.pointerType === 'touch') touched();
    }, true);
    document.addEventListener('touchstart', touched, { capture: true, passive: true });
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) contBreak();
      else state.cont.start = state.cont.last = Date.now();
      logEvent(document.hidden ? '화면이 가려짐 (다른 앱이나 입력으로 전환)' : '화면이 다시 보임');
      if (!document.hidden) requestWake();
    });
    window.addEventListener('online', () => logEvent('네트워크 연결됨'));
    window.addEventListener('offline', () => logEvent('네트워크 끊김'));
    window.addEventListener('resize', () => { state.slot = -1; });
  }

  function onClick(e) {
    const actEl = e.target.closest('[data-act]');
    if (actEl) { act(actEl.getAttribute('data-act')); return; }
    const tryEl = e.target.closest('[data-try]');
    if (tryEl) { startExperience(tryEl.getAttribute('data-try')); return; }
    const appEl = e.target.closest('[data-app]');
    if (appEl) { openPlayer(state.content.showcase.apps[+appEl.getAttribute('data-app')], false); return; }
    if (e.target.closest('#player, #gallery, #diag')) return;
    toggleDiag();
  }

  function onKey(e) {
    state.lastInteract = Date.now();
    const k = e.keyCode;
    if (k === 461 || k === 27 || k === 8) { // webOS 뒤로 · Esc · Backspace
      if (!$('diag').hidden) closeDiag();
      else if (!$('gallery').hidden) $('gallery').hidden = true;
      else if (state.show.app) act('back');
      else return;
      e.preventDefault();
      return;
    }
    if (k === 13 && $('diag').hidden && !state.show.app && document.activeElement === document.body) toggleDiag();
  }

  function act(name) {
    switch (name) {
      case 'close': closeDiag(); break;
      case 'fullscreen': goFullscreen(); break;
      case 'swap': location.href = '?screen=' + (role === 'a' ? 'b' : 'a'); break;
      case 'reload': location.reload(); break;
      case 'clear': clearLogs(); renderDiag(); break;
      case 'gallery': openGallery(); break;
      case 'gclose': $('gallery').hidden = true; break;
      case 'back':
        if (state.show.remote) state.dismissedRemote = state.show.app.url;
        closePlayer('돌아가기 버튼');
        break;
      case 'more': {
        if (!state.show.app || state.show.remote) break;
        const max = state.show.started + maxMinutes() * 60000;
        state.show.until = Math.min(max, Math.max(state.show.until, now()) + 3 * 60000);
        if (state.show.until >= max) logEvent('체험 최대 시간(' + maxMinutes() + '분)에 도달');
        renderPlayer();
        break;
      }
      case 'phone': if (state.show.app) playerMessage('휴대폰으로 이어서 체험합니다.'); break;
      case 'pmclose': $('playerMsg').hidden = true; break;
    }
  }

  function goFullscreen() {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) { logEvent('이 브라우저에는 전체 화면 기능이 없음'); return; }
    try {
      const r = fn.call(el);
      if (r && r.then) r.then(() => logEvent('전체 화면 전환 성공'), (err) => logEvent('전체 화면 전환 실패: ' + err.name));
    } catch (err) { logEvent('전체 화면 전환 실패: ' + err.name); }
  }

  function requestWake() {
    if (embed) return;
    if (!('wakeLock' in navigator)) { state.wake = '이 브라우저는 지원하지 않음'; return; }
    navigator.wakeLock.request('screen').then((lock) => {
      state.wake = '사용 중';
      lock.addEventListener('release', () => { state.wake = '해제됨'; });
    }, (err) => { state.wake = '요청 거부 (' + err.name + ')'; });
  }

  function checkFont() {
    if (!document.fonts || !document.fonts.load) { state.font = '확인할 수 없음'; return; }
    setTimeout(() => {
      document.fonts.load('700 20px Pretendard', '가').then(
        (list) => { state.font = list.length ? '불러옴' : '기본 글꼴로 표시 중'; },
        () => { state.font = '기본 글꼴로 표시 중'; });
    }, 8000);
  }

  // ---------- 진단 정보 ----------
  function toggleDiag() { if ($('diag').hidden) openDiag(); else closeDiag(); }
  function openDiag() {
    $('diag').hidden = false;
    state.lastInteract = Date.now();
    renderDiag();
    clearInterval(state.diagTimer);
    state.diagTimer = setInterval(() => {
      if (Date.now() - state.lastInteract > 120000) closeDiag();
      else renderDiag();
    }, 2000);
  }
  function closeDiag() {
    $('diag').hidden = true;
    clearInterval(state.diagTimer);
  }

  function row(mark, label, value) {
    const sym = { ok: '✓', bad: '✗', wait: '…', info: '·' }[mark];
    return `<div class="row"><span class="mark ${mark}">${sym}</span><span class="label">${label}</span><span class="value">${value}</span></div>`;
  }

  function diagHTML() {
    const c = state.content || {};
    const sc = c.showcase || {};
    const up = Date.now() - state.startedAt;
    const prev = state.prevSession;
    const checks = [];

    checks.push(state.touch ? row('ok', '터치 입력', '터치가 인식됩니다') : row('wait', '터치 입력', '손가락으로 화면을 눌러 확인합니다'));

    if (!state.lastOk && !state.lastErr) checks.push(row('wait', '콘텐츠 확인', '확인 중'));
    else if (state.lastErr > state.lastOk) checks.push(row('bad', '콘텐츠 확인', '실패 ' + state.errors + '회 · ' + esc(state.errMsg) + (state.lastOk ? ' · 마지막 성공 ' + hm(state.lastOk) : '')));
    else checks.push(row('ok', '콘텐츠 확인', hm(state.lastOk) + ' 성공 · 실패 ' + state.errors + '회 · ' + (c.pollSeconds || 60) + '초마다 확인'));

    if (clock.err === null) checks.push(row('wait', '시계 보정', '측정 중'));
    else {
      const off = clock.offset;
      checks.push(row(clock.err <= 300 ? 'ok' : 'wait', '시계 보정',
        '기기 시계가 ' + (Math.abs(off) / 1000).toFixed(1) + '초 ' + (off > 0 ? '느림' : '빠름') + ' · 오차 ±' + (clock.err / 1000).toFixed(2) + '초 · 보정해서 표시'));
    }

    const d = state.delay;
    checks.push(d
      ? row(d.ms < 15 * 60000 ? 'ok' : 'bad', '반영 지연', 'v' + esc(d.version) + ' ' + (d.from || '편성') + ' 후 ' + dur(d.ms) + ' 만에 표시 (' + mdhm(d.at) + ' 측정)')
      : row('wait', '반영 지연', 'GitHub Actions에서 「화면 배포」를 실행하면 측정합니다'));

    const cont = document.hidden ? 0 : Date.now() - state.cont.start;
    const H4 = 4 * 3600000;
    checks.push(row(state.cont.longest >= H4 ? 'ok' : 'wait', '연속 표시',
      '지금 ' + dur(cont) + ' · 가장 길게 ' + dur(state.cont.longest) + ' · 끊김 ' + state.cont.breaks + '회 (켠 지 ' + dur(up) + ')' +
      (state.cont.longest >= H4 ? ' · 브라우저 기준 4시간 통과. 화면이 실제로 켜져 있었는지는 사람이 확인합니다' : ' · 끊김 없이 4시간을 넘기면 통과')));

    if (embed) checks.push(row('info', '이전 실행', '미리보기에서는 기록하지 않습니다'));
    else if (!prev) checks.push(row('wait', '이전 실행', '기록 없음 (처음 연 화면)'));
    else {
      const len = prev.last - prev.start;
      const suspect = len > 3.75 * 3600000 && len < 4.4 * 3600000;
      checks.push(row(suspect ? 'bad' : 'ok', '이전 실행',
        mdhm(prev.start) + '부터 ' + dur(len) + ' 실행 → ' + dur(state.startedAt - prev.last) + ' 뒤 다시 열림' + (suspect ? ' · 4시간 자동 꺼짐 의심' : '')));
    }

    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const full = !!fsEl || (Math.abs(innerWidth - screen.width) <= 2 && Math.abs(innerHeight - screen.height) <= 2);
    checks.push(row(full ? 'ok' : 'wait', '전체 화면',
      (full ? '전체 화면입니다' : '브라우저 테두리가 보입니다') + ' · 창 ' + innerWidth + '×' + innerHeight + ' / 화면 ' + screen.width + '×' + screen.height));

    checks.push(row(state.font === '불러옴' ? 'ok' : 'wait', '웹 글꼴', state.font));
    checks.push(row(state.qr === '불러옴' ? 'ok' : (state.qr === '실패' ? 'bad' : 'wait'), 'QR 라이브러리', state.qr));
    checks.push(row(state.wake === '사용 중' ? 'ok' : 'info', '화면 꺼짐 방지', state.wake));
    checks.push(row('info', '작품 체험', sc.on === role
      ? '이 화면에서 사용 · 작품 ' + ((c.projects || []).length || (sc.apps || []).length) + '개' + (state.show.app ? ' · 지금 체험 중' : '')
      : (sc.on ? sc.on.toUpperCase() + ' 화면에서 사용' : '사용 안 함')));

    const ua = navigator.userAgent;
    const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1];
    const webos = /Web0S|webOS/i.test(ua);
    const tz = -new Date().getTimezoneOffset() / 60;
    const info = [
      ['브라우저', (webos ? 'webOS · ' : '') + (chrome ? 'Chromium ' + chrome : '알 수 없음')],
      ['화면', screen.width + '×' + screen.height + ' · 배율 ' + (window.devicePixelRatio || 1) + ' · ' + (innerHeight > innerWidth ? '세로' : '가로')],
      ['동시 터치', (navigator.maxTouchPoints || 0) + '개까지 지원'],
      ['시간대', 'UTC' + (tz >= 0 ? '+' : '') + tz + (tz === 9 ? '' : ' · 한국 시간이 아닙니다')],
      ['네트워크', navigator.onLine ? '연결됨' : '끊김'],
      ['보정 시각', hms(now())],
      ['버전', '앱 ' + APP_VERSION + ' · 콘텐츠 v' + esc(c.version || '?') + (c.publishedAt ? ' (' + mdhm(Date.parse(c.publishedAt)) + ' 게시)' : '')],
      ['카드', state.idx >= 0 ? (state.idx + 1) + ' / ' + state.sched.length : '-']
    ].map((kv) => `<div class="row"><span class="label">${kv[0]}</span><span class="value">${kv[1]}</span></div>`).join('');

    const sessions = embed ? [] : store.get('sessions', []).slice(-8).reverse();
    const sessHTML = sessions.map((s) => {
      const mine = state.session && s.id === state.session.id;
      const last = mine ? Date.now() : s.last;
      return `<li>${mdhm(s.start)} ~ ${hm(last)} · ${dur(last - s.start)} · ${esc((s.role || '?').toUpperCase())}${mine ? ' <em>(지금)</em>' : ''}</li>`;
    }).join('') || '<li>기록 없음</li>';
    const evHTML = state.events.slice(-10).reverse().map((e) => `<li>${mdhm(e.t)} ${esc(e.msg)}</li>`).join('') || '<li>기록 없음</li>';

    return `
      <div class="diag-grid">
        <section class="diag-sec"><h3>자동 점검</h3>${checks.join('')}</section>
        <section class="diag-sec">
          <h3>기기 정보</h3>${info}
          <h3 class="gap">진단 요약</h3>
          <div class="sum-wrap">
            <div class="qr-box small" id="sumQR"></div>
            <p>휴대폰 카메라로 찍으면 아래 글자가 그대로 표시됩니다. 복사해서 Claude에게 전달하면 됩니다.</p>
          </div>
          <code>${esc(diagSummary())}</code>
          <h3 class="gap">휴대폰으로 시험 실행</h3>
          <div class="sum-wrap">
            <div class="qr-box small" id="actQR"></div>
            <p>${actionsUrl()
              ? '휴대폰으로 찍으면 GitHub Actions 「화면 배포」 실행 페이지가 열립니다. 공지·긴급 정지·원격 시연을 여기서 시험합니다.'
              : 'GitHub Pages에 올린 뒤 표시됩니다.'}</p>
          </div>
        </section>
        <section class="diag-sec"><h3>실행 기록</h3><ul>${sessHTML}</ul></section>
        <section class="diag-sec"><h3>최근 기록</h3><ul>${evHTML}</ul></section>
      </div>
      <p class="ua">${esc(ua)}</p>`;
  }

  function diagSummary() {
    const c = state.content || {};
    const ua = navigator.userAgent;
    const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1] || '?';
    const prev = state.prevSession;
    const sess = embed ? [] : store.get('sessions', []).slice(-5).map((s) => Math.round((s.last - s.start) / 60000));
    return [
      'DGS', 'app=' + APP_VERSION, 'role=' + role, 'c=v' + (c.version || '?'),
      'ua=' + (/Web0S|webOS/i.test(ua) ? 'webOS/' : '') + 'C' + chrome,
      'scr=' + screen.width + 'x' + screen.height + '@' + (window.devicePixelRatio || 1),
      'win=' + innerWidth + 'x' + innerHeight,
      'tz=' + (-new Date().getTimezoneOffset() / 60),
      'tp=' + (navigator.maxTouchPoints || 0), 'touch=' + (state.touch ? 1 : 0),
      'off=' + (clock.err === null ? '?' : clock.offset + '+-' + clock.err),
      'up=' + Math.round((Date.now() - state.startedAt) / 60000) + 'm',
      'cont=' + Math.round(state.cont.longest / 60000) + 'm/br' + state.cont.breaks,
      'prev=' + (prev ? Math.round((prev.last - prev.start) / 60000) + 'm/gap' + Math.round((state.startedAt - prev.last) / 60000) + 'm' : '-'),
      'sess=' + (sess.join(',') || '-'),
      'delay=' + (state.delay ? Math.round(state.delay.ms / 1000) + 's' : '-'),
      'net=' + (state.lastOk ? 'ok' : '-') + '/err' + state.errors,
      'font=' + (state.font === '불러옴' ? 1 : 0), 'qr=' + (state.qr === '불러옴' ? 1 : 0),
      'wl=' + (state.wake === '사용 중' ? 1 : 0)
    ].join(' ');
  }

  // {계정}.github.io/{저장소}/ 에서 열렸을 때만 Actions 실행 페이지 주소를 만들 수 있다
  function actionsUrl() {
    const m = location.host.match(/^([^.]+)\.github\.io$/i);
    const repo = location.pathname.split('/')[1];
    return m && repo ? 'https://github.com/' + m[1] + '/' + repo + '/actions/workflows/pages.yml' : '';
  }

  function renderDiag() {
    const body = $('diagBody');
    const top = body.scrollTop;
    body.innerHTML = diagHTML();
    body.scrollTop = top;
    drawQR($('sumQR'), diagSummary(), 'L');
    if (actionsUrl()) drawQR($('actQR'), actionsUrl(), 'M');
    else $('actQR').hidden = true;
  }

  // ======================================================================
  // 역할 선택 · 미리보기
  // ======================================================================
  function startChooser() {
    const saved = store.get('role', null);
    let timer = null;
    app.innerHTML = `
      <div class="chooser">
        <h1>당곡고 화면 시험</h1>
        <p>이 스탠바이미가 맡을 화면을 선택하세요.</p>
        <div class="choices">
          <button class="choice a" data-role="a"><b>A 화면</b><span>소식</span></button>
          <button class="choice b" data-role="b"><b>B 화면</b><span>깊이 보기 · 학생 작품 시연</span></button>
        </div>
        <a class="preview-link" href="?preview">두 화면 미리보기</a>
        <p class="auto" id="auto"></p>
      </div>`;
    const go = (r) => { store.set('role', r); location.href = '?screen=' + r; };
    app.addEventListener('click', (e) => {
      const b = e.target.closest('[data-role]');
      if (b) go(b.getAttribute('data-role'));
      if (e.target.closest('[data-act="cancel"]')) { clearInterval(timer); $('auto').textContent = ''; }
    });
    if (saved === 'a' || saved === 'b') {
      let left = 5;
      const show = () => {
        $('auto').innerHTML = '지난번에 선택한 ' + saved.toUpperCase() + ' 화면으로 ' + left + '초 뒤 이동합니다. <button class="btn" data-act="cancel">취소</button>';
      };
      show();
      timer = setInterval(() => {
        left--;
        if (left <= 0) { clearInterval(timer); go(saved); } else show();
      }, 1000);
    }
  }

  function startPreview() {
    document.title = '당곡고 화면 미리보기';
    app.innerHTML = `
      <div class="preview">
        <div class="preview-head">
          <h1>두 화면 미리보기</h1>
          <button class="btn" id="rotB">B 화면 세로로</button>
          <a class="btn" href="./">역할 선택으로</a>
        </div>
        <div class="frames" id="frames">
          <figure class="frame land"><iframe src="?screen=a&amp;embed=1" title="A 화면"></iframe><figcaption>A · 소식</figcaption></figure>
          <figure class="frame land" id="fb"><iframe src="?screen=b&amp;embed=1" title="B 화면"></iframe><figcaption>B · 깊이 보기 · 학생 작품 시연</figcaption></figure>
        </div>
        <p class="preview-note">각 화면을 누르면 진단 정보가 표시됩니다. 미리보기에서는 실행 기록을 남기지 않습니다.</p>
      </div>`;
    $('rotB').addEventListener('click', () => {
      const fb = $('fb');
      const port = fb.classList.toggle('port');
      fb.classList.toggle('land', !port);
      $('frames').classList.toggle('mixed', port);
      $('rotB').textContent = port ? 'B 화면 가로로' : 'B 화면 세로로';
    });
  }

  // ---------- 작품 검토: 등록된 작품 전체의 검사 결과와 A·B 화면 미리보기 ----------
  const STATUS = { ok: ['ok', '검사 정상'], warn: ['wait', '검사 주의'], fail: ['bad', '검사 실패'], unchecked: ['wait', '검사 전'] };
  const TEACHER = { approved: ['ok', '교사 승인'], pending: ['wait', '교사 승인 전'], hidden: ['bad', '숨김'] };

  function chip(kind, text) { return `<span class="chip ${kind}">${esc(text)}</span>`; }

  function reviewHTML(p) {
    const st = STATUS[p.status] || STATUS.unchecked;
    const te = TEACHER[p.teacher] || TEACHER.pending;
    return `
      <article class="rv">
        <header class="rv-head">
          <div><h2>${p.no}. ${esc(p.title)}</h2><p class="rv-maker">${badgeHTML(p.makerType)}${esc(p.maker)} · ${esc(p.summary)}</p></div>
          <div class="rv-chips">
            ${chip(p.published ? 'ok' : 'wait', p.published ? '게시 중' : '게시 안 함')}
            ${chip(st[0], st[1])}
            ${chip(p.makerConfirmed ? 'ok' : 'wait', p.makerConfirmed ? '제작자 확인' : '제작자 확인 전')}
            ${chip(te[0], te[1])}
            ${chip('info', p.embed ? 'B 화면에서 실행' : 'QR로 안내')}
            ${p.changedAfterApproval ? chip('bad', '승인 뒤 작품이 바뀜') : ''}
          </div>
        </header>
        ${p.problems.length ? `<ul class="rv-problems">${p.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <p class="rv-meta">실행 주소 <a href="${esc(p.run)}" target="_blank" rel="noopener">${esc(p.run)}</a>
          · 짧은 주소 ${esc(p.short)}${p.checkedAt ? ' · ' + esc(p.checkedAt.slice(0, 16).replace('T', ' ')) + ' 검사' : ''}</p>
        <button class="btn" data-open="${esc(p.id)}">A·B 화면으로 미리 보기</button>
        <div class="rv-frames" id="pv-${esc(p.id)}"></div>
      </article>`;
  }

  function startReview() {
    document.title = '당곡고 화면 작품 검토';
    app.innerHTML = `
      <div class="review">
        <div class="preview-head"><h1>작품 검토</h1><a class="btn" href="?preview">두 화면 미리보기</a></div>
        <p class="preview-note left">게시·숨김은 지금은 projects/registry.json 의 teacher 값으로 정합니다. 다음 단계에서 이 화면의 버튼으로 바꿉니다.</p>
        <div id="rlist">불러오는 중</div>
      </div>`;
    fetch('projects/index.json?t=' + Date.now(), { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { $('rlist').innerHTML = d.projects.map(reviewHTML).join('') || '등록된 작품이 없습니다.'; })
      .catch((e) => { $('rlist').textContent = '불러오지 못했습니다: ' + e.message; });
    app.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (!b) return;
      const id = b.getAttribute('data-open');
      $('pv-' + id).innerHTML = `
        <figure class="frame land"><iframe src="?screen=a&amp;embed=1&amp;only=${encodeURIComponent(id)}" title="A 화면"></iframe><figcaption>A · 작품 소개</figcaption></figure>
        <figure class="frame land"><iframe src="?screen=b&amp;embed=1&amp;only=${encodeURIComponent(id)}" title="B 화면"></iframe><figcaption>B · 직접 체험 (「체험 시작」을 눌러 확인)</figcaption></figure>`;
      b.remove();
    });
  }

  if (role) startScreen();
  else if ('preview' in params) startPreview();
  else if ('review' in params) startReview();
  else startChooser();
})();
