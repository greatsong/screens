/**
 * 당곡고 스탠바이미 작품 등록·관리 (Google Apps Script)
 *
 * 구글 설문으로 작품을 받는다. 학생 이메일 같은 개인정보는 이 프로젝트의 시트에만 두고,
 * GitHub(greatsong/screens)에는 공개해도 되는 항목만 올린다.
 *
 *   설문 제출 ─→ 시트 '작품'·'요청' (접수, 접수 메일)
 *   정기 동기화(평일 07:30·12:00·15:30) ─→ projects/registry.json 커밋 → GitHub가 검사·편성·배포
 *   10분마다 결과 확인 ←─ GitHub Pages의 projects/index.json, content.json → 상태 갱신, 제작자·교사 메일
 *   관리 화면의 긴급 정지·공지·B 시연 ─→ projects/control.json 바로 커밋
 *   관리 화면의 숨김 ─→ 등록부의 해당 작품만 바로 커밋 (다음 정기 동기화를 기다리지 않는다)
 *   급식 메뉴 투표(화면 터치·휴대폰 vote.html) ─→ doPost 로 받아 스크립트 속성 MEAL_VOTES·시트 '급식투표'에 쌓고, ?api=votes 로 집계를 돌려준다
 *
 * 스크립트 속성: GITHUB_TOKEN(필수), ADMIN_EMAILS(관리자 추가), REQUIRE_SCHOOL_LOGIN(true면 학교 계정 로그인 설문)
 * 주소: clasp 배포가 Deploy.gs에 적는다(STATUS_URL 학생용, ADMIN_URL 관리용). 스크립트 속성 WEBAPP_URL·ADMIN_URL이 있으면 그 값을 먼저 쓴다.
 * 학생은 메일의 링크(?t=토큰)로, 교사는 ?page=admin 으로 연다.
 * 설치 방법은 apps-script/SETUP.md 에 있다.
 */

const CONFIG = {
  REPO: 'greatsong/screens',
  SITE: 'https://greatsong.github.io/screens',
  TZ: 'Asia/Seoul',
  TITLE: '당곡고 스탠바이미',
  SYNC_TIMES: [[7, 30], [12, 0], [15, 30]], // 평일 정기 동기화. 구글 트리거는 ±15분 안에서 실행된다
  POLL_HOURS: [7, 19],                       // 결과 확인은 이 시간대에만 한다
};

// 설문 문항 제목. 설문을 만들 때와 응답을 읽을 때 같은 값을 사용한다.
const Q = {
  title: '작품명',
  url: '실행 주소',
  summary: '한 줄 소개',
  maker: '제작자 표시명',
  role: '제작자 구분',
  target: '어느 화면에 맞나요?',
  howTo: '체험 방법',
  tryUrl: '체험 전용 주소',
  demo: '자동 시연할 동작',
  email: '결과를 받을 이메일',
  consent: '공개 동의',
};
const TARGETS = { '큰 화면용': 'wide', '휴대폰용': 'mobile', '둘 다': 'both' };
// 작품 카드의 배지 (선생님 / 1·2·3학년)
const ROLES = { '선생님': 'teacher', '1학년': 'g1', '2학년': 'g2', '3학년': 'g3' };

const P_COLS = ['id', '상태', '작품명', '실행 주소', '한 줄 소개', '제작자 표시명', '제작자 구분', '화면', '체험 방법', '체험 전용 주소',
  '자동 시연 동작', '제작자 이메일', '제작자 확인', '교사', '보류', '기간 고정', '승인 시각', '번호', '짧은 주소', '검사',
  '문제', '동기화 ID', '알림 기록', '토큰', '수정 링크', '응답 ID', '접수 시각', '갱신 시각'];
const R_COLS = ['요청 ID', '시각', '종류', '작품 id', '내용', '상태', '처리 시각', '반영 확인 값', '비고'];

// 작품 상태 (시트 '작품'의 상태 열)
const S = {
  RECEIVED: '접수', WAIT_CHECK: '검사 대기', NEED_FIX: '보완 필요', WAIT_MAKER: '제작자 확인 대기',
  WAIT_TEACHER: '교사 검토 대기', WAIT_PUBLISH: '게시 대기', CHANGE_REQ: '수정 요청', LIVE: '게시 중', HIDDEN: '숨김',
};
// 요청 상태 (시트 '요청'의 상태 열)
const RS = { NEW: '접수', DOING: '처리 중', DONE: '반영 완료', HOLD: '보류' };
// 정기 동기화로 반영하는 요청 종류. 화면 제어와 숨김은 바로 반영한다.
const REGISTRY_TYPES = ['등록', '수정', '제작자 확인', '게시 승인', '기간 고정', '보류 해제'];

// ======================================================================
// 설치
// ======================================================================
function setup() {
  requireAdmin_();
  if (!prop_('SHEET_ID')) setProp_('SHEET_ID', SpreadsheetApp.create(CONFIG.TITLE + ' 작품 관리').getId());
  initSheets_();
  Logger.log('기존 수식의 문자 전환: ' + neutralizeSheetFormulas_() + '개');
  if (!prop_('FORM_ID')) {
    const form = createForm_();
    form.setDestination(FormApp.DestinationType.SPREADSHEET, prop_('SHEET_ID'));
    setProp_('FORM_ID', form.getId());
  }
  ensureFormItems_();
  installTriggers_();
  const form = FormApp.openById(prop_('FORM_ID'));
  Logger.log('설문(학생용) 주소: ' + form.getPublishedUrl());
  Logger.log('설문 편집: ' + form.getEditUrl());
  Logger.log('관리 시트: ' + ss_().getUrl());
  Logger.log('다음 순서: SETUP.md의 5단계(웹 앱 배포)를 진행하고 웹 앱 주소를 스크립트 속성 WEBAPP_URL에 넣습니다.');
}

function initSheets_() {
  const ss = ss_();
  ensureSheet_(ss, '작품', P_COLS);
  ensureSheet_(ss, '요청', R_COLS);
}

function ensureSheet_(ss, name, cols) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
    return sh;
  }
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  cols.filter((c) => head.indexOf(c) < 0).forEach((c, i) => sh.getRange(1, head.length + i + 1).setValue(c));
  return sh;
}

function createForm_() {
  // 학교 계정 로그인은 학교 구글 워크스페이스 계정에 설치하고 학생 계정이 있을 때만 켠다. 꺼 두면 설문에 이메일 문항이 생긴다.
  const login = prop_('REQUIRE_SCHOOL_LOGIN') === 'true';
  const form = FormApp.create(CONFIG.TITLE + ' 작품 등록');
  form.setDescription(TEXT.formDesc);
  form.setAllowResponseEdits(true);
  form.setConfirmationMessage(TEXT.formDone);
  if (login) {
    // 학교 계정으로 로그인해야 제출할 수 있고, 로그인한 이메일로 결과를 보낸다
    try { form.setRequireLogin(true); } catch (e) { Logger.log('학교 계정 로그인 설정 실패: ' + e); }
    try { form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED); } catch (e) { form.setCollectEmail(true); }
  }
  const len = (n) => FormApp.createTextValidation().requireTextLengthLessThanOrEqualTo(n).build();
  const plen = (n) => FormApp.createParagraphTextValidation().requireTextLengthLessThanOrEqualTo(n).build();
  const url = () => FormApp.createTextValidation().requireTextIsUrl().build();
  form.addTextItem().setTitle(Q.title).setRequired(true).setValidation(len(40));
  form.addTextItem().setTitle(Q.url).setHelpText('https:// 로 시작하는, 이미 배포된 웹앱 주소').setRequired(true).setValidation(url());
  form.addTextItem().setTitle(Q.summary).setHelpText('핵심 기능을 한 문장으로 (80자 이내)').setRequired(true).setValidation(len(80));
  form.addTextItem().setTitle(Q.maker).setHelpText('화면에 표시할 이름 (예: 2학년 데이터팀). 실명을 쓰지 않아도 됩니다.').setRequired(true).setValidation(len(30));
  form.addMultipleChoiceItem().setTitle(Q.target).setChoiceValues(Object.keys(TARGETS)).setRequired(true);
  form.addParagraphTextItem().setTitle(Q.howTo).setHelpText('선택. 체험하는 사람이 처음 누를 곳 (120자 이내)').setValidation(plen(120));
  form.addTextItem().setTitle(Q.tryUrl).setHelpText('선택. 체험용으로 따로 만든 주소가 있으면 적습니다.').setValidation(url());
  form.addParagraphTextItem().setTitle(Q.demo).setHelpText('선택. 소개 영상에서 시연할 동작 2~3개를 한 줄에 하나씩 (예: 예시 불러오기)').setValidation(plen(300));
  if (!login) {
    form.addTextItem().setTitle(Q.email).setHelpText('검사 결과와 게시 안내를 받을 주소').setRequired(true)
      .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  }
  form.addCheckboxItem().setTitle(Q.consent).setChoiceValues([TEXT.consent]).setRequired(true);
  return form;
}

// 설치한 뒤에 늘어난 문항과 시트 열을 채운다. 10분마다 결과를 확인할 때와 관리 화면을 열 때 불리므로
// setup을 다시 실행하지 않아도 된다. 다 채운 뒤에는 FORM_VERSION으로 건너뛴다.
const FORM_VERSION = '2';
function ensureFormItems_() {
  if (!prop_('FORM_ID') || prop_('FORM_VERSION') === FORM_VERSION) return;
  initSheets_();
  const form = FormApp.openById(prop_('FORM_ID'));
  const items = form.getItems();
  if (!items.some((it) => it.getTitle() === Q.role)) {
    form.addMultipleChoiceItem().setTitle(Q.role).setHelpText('작품 카드에 배지로 표시됩니다.')
      .setChoiceValues(Object.keys(ROLES)).setRequired(true);
    const maker = items.filter((it) => it.getTitle() === Q.maker)[0];
    if (maker) form.moveItem(form.getItems().length - 1, maker.getIndex() + 1); // 제작자 표시명 바로 아래로
  }
  setProp_('FORM_VERSION', FORM_VERSION);
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onFormSubmitTrigger_').forForm(prop_('FORM_ID')).onFormSubmit().create();
  CONFIG.SYNC_TIMES.forEach((hm) => {
    ScriptApp.newTrigger('scheduledSync_').timeBased().atHour(hm[0]).nearMinute(hm[1]).everyDays(1).inTimezone(CONFIG.TZ).create();
  });
  ScriptApp.newTrigger('pollResults_').timeBased().everyMinutes(10).create();
}

// ======================================================================
// 설문 접수
// ======================================================================
function onFormSubmitTrigger_(e) {
  withLock_(() => handleSubmission_(e.response));
}

function handleSubmission_(resp) {
  const a = {};
  resp.getItemResponses().forEach((ir) => { a[ir.getItem().getTitle()] = ir.getResponse(); });
  const t = table_('작품', P_COLS);
  let p = t.rows.filter((r) => r['응답 ID'] === resp.getId())[0];
  const isNew = !p;
  if (isNew) {
    p = { id: 'f' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toLowerCase(), '토큰': Utilities.getUuid(),
      '교사': 'pending', '보류': false, '접수 시각': now_(), '응답 ID': resp.getId(), '알림 기록': '' };
  }
  const email = (resp.getRespondentEmail && resp.getRespondentEmail()) || String(a[Q.email] || '');
  Object.assign(p, {
    '작품명': clean_(a[Q.title], 40), '실행 주소': clean_(a[Q.url], 300), '한 줄 소개': clean_(a[Q.summary], 80),
    '제작자 표시명': clean_(a[Q.maker], 30), '제작자 구분': ROLES[a[Q.role]] || '',
    '화면': TARGETS[a[Q.target]] || 'wide', '체험 방법': clean_(a[Q.howTo], 120),
    '체험 전용 주소': clean_(a[Q.tryUrl], 300), '자동 시연 동작': clean_(a[Q.demo], 300, true),
    '제작자 이메일': email.trim(), '제작자 확인': false, '수정 링크': resp.getEditResponseUrl(), '갱신 시각': now_(),
  });
  // 고친 작품은 다시 확인·승인을 받는다. 숨긴 작품은 고쳐 내도 숨김 그대로 둔다.
  if (!isNew && p['교사'] === 'approved') p['교사'] = 'pending';
  const problems = validate_(p);
  p['상태'] = problems.length ? S.NEED_FIX : S.RECEIVED;
  p['문제'] = problems.join('\n');
  if (isNew) t.add(p); else t.save(p);

  closeRequests_(p.id, ['수정 요청'], '제작자가 고쳐 제출');
  addRequest_(isNew ? '등록' : '수정', p.id, p['작품명'], problems.length ? RS.HOLD : RS.NEW, problems.length ? '입력 확인 필요' : '');
  mail_(p, problems.length ? 'invalid' : (isNew ? 'received' : 'edited'), { problems: problems });
  return p;
}

function clean_(v, max, multiline) {
  let s = String(v == null ? '' : v).trim();
  s = multiline ? s.replace(/\r/g, '') : s.replace(/\s+/g, ' ');
  return s.slice(0, max);
}

function validate_(p) {
  const out = [];
  const https = (u) => /^https:\/\/[^\s<>"]+$/i.test(u);
  if (!p['작품명']) out.push('작품명이 비어 있습니다.');
  if (!https(p['실행 주소'])) out.push('실행 주소는 https:// 로 시작해야 합니다. 학교 화면은 보안 연결(https) 주소만 실행할 수 있습니다.');
  if (p['체험 전용 주소'] && !https(p['체험 전용 주소'])) out.push('체험 전용 주소도 https:// 로 시작해야 합니다.');
  if (!p['한 줄 소개']) out.push('한 줄 소개가 비어 있습니다.');
  if (!p['제작자 표시명']) out.push('제작자 표시명이 비어 있습니다.');
  if (!p['제작자 이메일']) out.push('결과를 받을 이메일이 없습니다.');
  return out;
}

// ======================================================================
// GitHub로 보내기
// ======================================================================
function scheduledSync_() {
  const day = Number(fmt_(now_(), 'u')); // 1 월요일 ~ 7 일요일
  if (day >= 6) return;
  withLock_(() => syncRegistry_('정기'));
}

function runUrl_(r) { return r['체험 전용 주소'] || r['실행 주소']; }

function toRegistry_(r) {
  const e = {
    id: r.id, title: r['작품명'], url: r['실행 주소'], summary: r['한 줄 소개'], maker: r['제작자 표시명'],
    makerType: r['제작자 구분'] || '', target: r['화면'] || 'wide', howTo: r['체험 방법'] || '',
    demoSteps: String(r['자동 시연 동작'] || '').split('\n').map((x) => x.trim()).filter(Boolean),
    makerConfirmed: r['제작자 확인'] === true, teacher: r['교사'] || 'pending',
    approvedAt: r['승인 시각'] ? iso_(r['승인 시각']) : '', source: 'form',
  };
  if (r['체험 전용 주소']) e.tryUrl = r['체험 전용 주소'];
  if (r['기간 고정']) e.pinUntil = r['기간 고정'] instanceof Date ? fmt_(r['기간 고정'], 'yyyy-MM-dd') : String(r['기간 고정']).slice(0, 10);
  return e;
}

// 시트의 작품 전체를 등록부에 맞춘다. 사람이 직접 쓴 항목은 그대로 두고, 보류한 작품은 지난번 내용을 유지한다.
function syncRegistry_(why) {
  const t = table_('작품', P_COLS);
  const syncId = rid_('s');
  let targetSyncId = '';
  const valid = t.rows.filter((r) => r.id && !validate_(r).length);
  const held = {};
  valid.forEach((r) => { if (r['보류'] === true) held[r.id] = true; });
  const changed = updateRepoJson_('projects/registry.json', (reg) => {
    const old = reg.projects || [];
    const before = JSON.stringify(old);
    const manual = old.filter((p) => p.source !== 'form');
    const form = valid.map((r) => (held[r.id] ? old.filter((o) => o.id === r.id)[0] : toRegistry_(r))).filter(Boolean);
    reg.projects = manual.concat(form);
    if (JSON.stringify(reg.projects) !== before || !reg.syncId) reg.syncId = syncId;
    targetSyncId = reg.syncId;
  }, '등록부 동기화 (' + why + ')');

  valid.forEach((r) => {
    if (held[r.id]) return;
    if (targetSyncId) r['동기화 ID'] = targetSyncId;
    if (r['상태'] === S.RECEIVED) r['상태'] = S.WAIT_CHECK;
    t.save(r);
  });
  const reqs = table_('요청', R_COLS);
  reqs.rows.forEach((q) => {
    if (q['상태'] !== RS.NEW || REGISTRY_TYPES.indexOf(q['종류']) < 0 || held[q['작품 id']]) return;
    q['상태'] = RS.DOING;
    q['처리 시각'] = now_();
    q['반영 확인 값'] = targetSyncId;
    q['비고'] = changed ? why + ' 동기화로 GitHub에 보냄' : '같은 내용의 기존 배포 확인 대기';
    reqs.save(q);
  });
  return { changed: changed, syncId: targetSyncId };
}

// 등록부에서 작품 하나만 바로 고친다 (긴급 숨김). 다른 작품의 대기 중인 변경은 건드리지 않는다.
function patchRegistry_(id, patch, why) {
  const syncId = rid_('s');
  const changed = updateRepoJson_('projects/registry.json', (reg) => {
    const p = (reg.projects || []).filter((x) => x.id === id)[0];
    if (!p) return;
    Object.keys(patch).forEach((k) => { p[k] = patch[k]; });
    reg.syncId = syncId;
  }, why + ' (' + id + ')');
  return changed ? syncId : '';
}

// 화면 제어는 바로 커밋한다. 요청 id로 실제 화면에 반영됐는지 확인한다.
function setControl_(patch, why) {
  const requestId = rid_('a');
  updateRepoJson_('projects/control.json', (c) => {
    Object.keys(patch).forEach((k) => { c[k] = patch[k]; });
    c.requestId = requestId;
    c.updatedAt = iso_(now_());
    c.updatedBy = 'admin';
  }, '화면 제어: ' + why);
  return requestId;
}

// ======================================================================
// 결과 확인 (10분마다)
// ======================================================================
function pollResults_() {
  try { ensureFormItems_(); } catch (e) { Logger.log('설문 문항 갱신 실패: ' + e); }
  const h = Number(fmt_(now_(), 'H'));
  if (h < CONFIG.POLL_HOURS[0] || h >= CONFIG.POLL_HOURS[1]) return;
  withLock_(() => applyResults_(site_('projects/index.json'), site_('content.json')));
}

function idAtLeast_(live, target) {
  if (!target) return true;
  if (!live) return false;
  if (live === target) return true;
  // 예전 ID는 초, 새 ID는 밀리초까지 비교한다. 같은 초의 예전 ID 순서는 추측하지 않는다.
  const stamp = (id) => {
    const m = /^(\d{8}-\d{6})(\d{3})?-/.exec(String(id));
    return m ? m[1] + (m[2] || '000') : '';
  };
  const a = stamp(live), b = stamp(target);
  return !!(a && b && a > b);
}

function applyResults_(idx, content) {
  if (!idx) return;
  const map = {};
  (idx.projects || []).forEach((e) => { map[e.id] = e; });
  const t = table_('작품', P_COLS);
  const changedRows = [];

  t.rows.forEach((r) => {
    const e = map[r.id];
    if (!e || r['상태'] === S.RECEIVED) return;
    if (!idAtLeast_(idx.registrySyncId, r['동기화 ID'])) return; // 시트의 최신 내용이 아직 배포되지 않았다
    r['번호'] = e.no;
    r['짧은 주소'] = e.short;
    r['검사'] = e.status;
    // 편성 스크립트는 지금 주소로 검사한 결과만 인정하고, 아니면 unchecked로 내보낸다
    const fresh = e.run === runUrl_(r) && e.status !== 'unchecked';
    if (fresh) r['문제'] = (e.problems || []).join('\n');
    let next;
    if (r['교사'] === 'hidden') next = S.HIDDEN;
    else if (!fresh) next = S.WAIT_CHECK;
    else if (e.status === 'fail') next = S.NEED_FIX;
    else if (r['상태'] === S.CHANGE_REQ) next = S.CHANGE_REQ; // 제작자가 고쳐 낼 때까지 그대로
    else if (e.published) next = S.LIVE;
    else if (r['제작자 확인'] !== true) next = S.WAIT_MAKER;
    else if (r['교사'] === 'approved') next = S.WAIT_PUBLISH; // 승인했고 다음 동기화를 기다린다
    else next = S.WAIT_TEACHER;
    r['상태'] = next;

    if (next === S.NEED_FIX) notifyOnce_(r, 'fail:' + e.checkedAt, 'checkFail', { problems: e.problems || [] });
    if (next === S.WAIT_MAKER) notifyOnce_(r, 'confirm:' + e.checkedAt, 'askConfirm', { notes: e.problems || [] });
    if (next === S.LIVE) notifyOnce_(r, 'live:' + (r['승인 시각'] ? iso_(r['승인 시각']) : ''), 'published', { short: e.short });
    if (e.changedAfterApproval) {
      notifyOnce_(r, 'changed:' + e.fingerprint, 'changed', {});
      changedRows.push(r);
    }
    t.save(r);
  });

  // 요청이 실제 화면에 반영됐는지 확인한다 (배포 완료). 기기가 받았는지는 각 화면의 진단 정보로 확인한다.
  const reqs = table_('요청', R_COLS);
  reqs.rows.forEach((q) => {
    if (q['상태'] !== RS.DOING || !q['반영 확인 값']) return;
    const v = String(q['반영 확인 값']);
    const live = v.indexOf('-s') > 0 ? idx.registrySyncId :
      (v.indexOf('-n') > 0 ? (content && content.newsControlRequestId) : (content && content.controlRequestId));
    if (!idAtLeast_(live, v)) return;
    q['상태'] = RS.DONE;
    q['처리 시각'] = now_();
    q['비고'] = (q['비고'] ? q['비고'] + ' · ' : '') + '화면 배포 완료';
    reqs.save(q);
  });

  teacherDigest_(t.rows.filter((r) => r['상태'] === S.WAIT_TEACHER), changedRows);
}

function notifyOnce_(r, key, kind, extra) {
  const log = String(r['알림 기록'] || '').split('\n').filter(Boolean);
  if (log.indexOf(key) >= 0) return;
  mail_(r, kind, extra);
  r['알림 기록'] = log.concat([key]).slice(-20).join('\n');
}

// 교사에게는 검토할 작품이 바뀔 때만 한 통으로 묶어 보낸다
function teacherDigest_(waiting, changed) {
  const key = waiting.map((r) => r.id).concat(changed.map((r) => 'c:' + r.id)).sort().join(',');
  if (key === (prop_('DIGEST_KEY') || '')) return;
  if (!key) { setProp_('DIGEST_KEY', ''); return; } // 검토할 작품이 없어지면 기록만 비운다
  const line = (r, note) => '<li>' + esc_(r['작품명']) + ' · ' + esc_(r['제작자 표시명']) + (note ? ' · ' + note : '') + '</li>';
  const html = mailHtml_([
    '검토할 작품이 있습니다.',
    '<ul>' + waiting.map((r) => line(r, '')).join('') + changed.map((r) => line(r, '승인 뒤 작품이 바뀜')).join('') + '</ul>',
  ], adminUrl_() ? { href: adminUrl_(), label: '관리 화면 열기' } : null);
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: '[' + CONFIG.TITLE + '] 검토할 작품 ' + (waiting.length + changed.length) + '개',
    htmlBody: html, name: CONFIG.TITLE });
  setProp_('DIGEST_KEY', key); // 발송 실패 때는 다음 확인에서 다시 시도한다
}

// ======================================================================
// 제작자 화면 (내 작품 상태) — 메일의 링크로 연다. 토큰을 아는 사람만 볼 수 있다.
// ======================================================================
function doGet(e) {
  if (e && e.parameter && e.parameter.api === 'votes') return json_(mealVotes_());
  const page = (e && e.parameter && e.parameter.page) || 'status';
  if (page === 'admin') {
    if (!isAdmin_()) return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">관리 권한이 없습니다.</p>');
    return HtmlService.createTemplateFromFile('Admin').evaluate().setTitle(CONFIG.TITLE + ' 관리')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const tpl = HtmlService.createTemplateFromFile('Status');
  tpl.token = (e && e.parameter && e.parameter.t) || '';
  return tpl.evaluate().setTitle('내 작품 상태').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ======================================================================
// 급식 메뉴 투표 — 스탠바이미 화면(메뉴 터치)과 휴대폰(site/vote.html)이 부른다.
// 이름·이메일은 받지 않는다. 기기마다 무작위 번호(dev)를 만들어 그 해시로만 중복을 막는다.
//   휴대폰: 같은 기기·같은 날·같은 메뉴는 6시간 안에 한 번  ·  화면: 한 화면에서 2초에 한 번
//   전체: 1분에 120표까지(웹 앱 실행 할당량 보호)
// 집계는 스크립트 속성 MEAL_VOTES {yyyyMMdd: {메뉴: 수}}에 두고 3주 지난 날은 지운다. 시트 '급식투표'에는 기록만 남긴다.
// ======================================================================
const VOTE = { BACK: 1, AHEAD: 14, KEEP: 21, MAX_DISHES: 24, PHONE_TTL: 21600, SCREEN_GAP: 2, PER_MIN: 120 };
const V_COLS = ['시각', '날짜', '메뉴', '출처', '기기'];

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: '형식 오류' }); }
  if (body && body.api === 'vote') return json_(mealVote_(body));
  return json_({ ok: false, error: '알 수 없는 요청' });
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 16);
}
function dayDiff_(a, b) {
  const t = (k) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
  return Math.round((t(b) - t(a)) / 86400000);
}

function mealVote_(b) {
  const date = String(b.date || '');
  const dish = clean_(b.dish, 40);
  const dev = String(b.dev || '');
  const src = b.src === 'screen' ? 'screen' : 'phone';
  if (!/^\d{8}$/.test(date) || !dish || !/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return { ok: false, error: '형식 오류' };
  const today = fmt_(now_(), 'yyyyMMdd');
  const diff = dayDiff_(today, date);
  if (diff < -VOTE.BACK || diff > VOTE.AHEAD) return { ok: false, error: '투표할 수 없는 날짜입니다' };
  const cache = CacheService.getScriptCache();
  const minute = 'mvm:' + fmt_(now_(), 'yyyyMMddHHmm');
  const used = Number(cache.get(minute) || 0);
  if (used >= VOTE.PER_MIN) return { ok: false, error: '잠시 뒤 다시 눌러 주세요' };
  cache.put(minute, String(used + 1), 120);
  const who = hash_(dev);
  const gate = src === 'phone' ? 'mvp:' + who + ':' + date + ':' + hash_(dish) : 'mvs:' + who;
  if (cache.get(gate)) return { ok: true, dup: src === 'phone', wait: src === 'screen', counts: dayVotes_(date) };
  cache.put(gate, '1', src === 'phone' ? VOTE.PHONE_TTL : VOTE.SCREEN_GAP);
  return withLock_(() => {
    const all = JSON.parse(prop_('MEAL_VOTES') || '{}');
    Object.keys(all).forEach((d) => { if (dayDiff_(d, today) > VOTE.KEEP) delete all[d]; });
    const day = all[date] = all[date] || {};
    if (!(dish in day) && Object.keys(day).length >= VOTE.MAX_DISHES) return { ok: false, error: '이 날은 더 받을 수 없습니다' };
    day[dish] = (day[dish] || 0) + 1;
    setProp_('MEAL_VOTES', JSON.stringify(all));
    const sh = ensureSheet_(ss_(), '급식투표', V_COLS);
    sh.appendRow([iso_(now_()), date, sheetValue_(dish), src === 'screen' ? '화면' : '휴대폰', who.slice(0, 8)]);
    cache.remove('mvj');
    return { ok: true, counts: day };
  });
}

function dayVotes_(date) { return (JSON.parse(prop_('MEAL_VOTES') || '{}'))[date] || {}; }

// 어제부터 앞으로의 집계. 화면 두 대가 1분마다 부르므로 20초 동안 캐시한다
function mealVotes_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('mvj');
  if (hit) return JSON.parse(hit);
  const today = fmt_(now_(), 'yyyyMMdd');
  const all = JSON.parse(prop_('MEAL_VOTES') || '{}');
  const days = {};
  Object.keys(all).forEach((d) => { if (dayDiff_(today, d) >= -VOTE.BACK) days[d] = all[d]; });
  const out = { ok: true, at: iso_(now_()), days: days };
  cache.put('mvj', JSON.stringify(out), 20);
  return out;
}

function rowByToken_(token) {
  if (!token || String(token).length < 20) return null;
  return table_('작품', P_COLS).rows.filter((r) => r['토큰'] === token)[0] || null;
}

function statusData(token) {
  const r = rowByToken_(token);
  if (!r) return null;
  const idx = site_('projects/index.json');
  const e = idx ? (idx.projects || []).filter((x) => x.id === r.id)[0] : null;
  const img = (k) => (e && e.images && e.images[k] ? CONFIG.SITE + '/' + e.images[k] : '');
  return {
    title: r['작품명'], maker: r['제작자 표시명'], status: r['상태'], explain: TEXT.status[r['상태']] || '',
    problems: String(r['문제'] || '').split('\n').filter(Boolean), editUrl: r['수정 링크'],
    canConfirm: r['상태'] === S.WAIT_MAKER, wide: img('wide'), mobile: img('mobile'),
    previewA: e ? CONFIG.SITE + '/?screen=a&embed=1&only=' + encodeURIComponent(r.id) : '',
    previewB: e ? CONFIG.SITE + '/?screen=b&embed=1&only=' + encodeURIComponent(r.id) : '',
    short: r['상태'] === S.LIVE ? r['짧은 주소'] : '', nextSync: nextSyncText_(),
  };
}

function makerConfirm(token) {
  return withLock_(() => {
    const t = table_('작품', P_COLS);
    const r = t.rows.filter((x) => x['토큰'] === token)[0];
    if (!r || r['상태'] !== S.WAIT_MAKER) return statusData(token);
    r['제작자 확인'] = true;
    r['상태'] = S.WAIT_TEACHER;
    r['갱신 시각'] = now_();
    t.save(r);
    addRequest_('제작자 확인', r.id, r['작품명'], RS.NEW, '');
    return statusData(token);
  });
}

// ======================================================================
// 관리 화면 — 같은 웹 앱 주소에 ?page=admin 을 붙여 연다.
// 웹 앱은 '나로 실행'이므로, 로그인한 사람이 스크립트 주인(또는 ADMIN_EMAILS)인지 함수마다 다시 확인한다.
// 학생이 상태 화면에서 관리 함수를 직접 불러도 여기서 막힌다.
// ======================================================================
function isAdmin_() {
  const me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!me) return false;
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const extra = String(prop_('ADMIN_EMAILS') || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return me === owner || extra.indexOf(me) >= 0;
}
function requireAdmin_() { if (!isAdmin_()) throw new Error('관리 권한이 없습니다.'); }

function adminData() {
  requireAdmin_();
  try { ensureFormItems_(); } catch (e) { Logger.log('설문 문항 갱신 실패: ' + e); }
  const idx = site_('projects/index.json') || { projects: [] };
  const live = site_('content.json') || {};
  const map = {};
  idx.projects.forEach((e) => { map[e.id] = e; });
  let requested = null;
  try { requested = readRepoJson_('projects/control.json').data; } catch (err) { requested = { error: String(err) }; }
  let newsControl = { entries: {} }, newsSource = { items: [] }, newsError = '';
  try {
    newsControl = readRepoJson_('projects/news-control.json').data;
    newsSource = readRepoJson_('projects/news.json').data;
  } catch (err) { newsError = String(err); }
  const newsEntries = newsControl.entries || {};
  const newsById = {};
  (newsSource.items || []).concat(live.news || []).forEach((n) => { if (!newsById[n.id]) newsById[n.id] = n; });
  Object.keys(newsEntries).forEach((id) => { if (!newsById[id]) newsById[id] = { id: id, title: newsEntries[id].label || id, summary: '' }; });
  const t = table_('작품', P_COLS);
  const requestRows = table_('요청', R_COLS).rows;
  return {
    site: CONFIG.SITE, nextSync: nextSyncText_(), sheetUrl: ss_().getUrl(),
    formUrl: prop_('FORM_ID') ? FormApp.openById(prop_('FORM_ID')).getPublishedUrl() : '',
    control: {
      requested: requested,
      live: { mode: live.mode, notice: live.notice, noticeUntil: live.noticeUntil, showcase: (live.showcase || {}).now || null,
        requestId: live.controlRequestId || '', version: live.version },
    },
    published: (live.projects || []).map((p) => ({ id: p.id, no: p.no, title: p.title })),
    news: {
      requestId: newsControl.requestId || '', liveRequestId: live.newsControlRequestId || '', error: newsError,
      items: Object.keys(newsById).map((id) => {
        const n = newsById[id], edit = newsEntries[id] || {};
        const pending = requestRows.filter((q) => q['작품 id'] === id && q['종류'] === '뉴스 수정 요청' && q['상태'] !== RS.DONE).slice(-1)[0];
        return { id: id, title: edit.title !== undefined ? edit.title : n.title,
          summary: edit.summary !== undefined ? edit.summary : (n.summary || ''), source: n.source || '', date: n.date || '',
          hidden: edit.hidden === true, request: pending ? pending['내용'] : '', link: n.link || '' };
      }),
    },
    projects: t.rows.filter((r) => r.id).map((r) => {
      const e = map[r.id] || {};
      return {
        id: r.id, no: r['번호'], status: r['상태'], title: r['작품명'], maker: r['제작자 표시명'], makerType: r['제작자 구분'] || '',
        email: r['제작자 이메일'],
        url: r['실행 주소'], short: r['짧은 주소'], teacher: r['교사'], makerConfirmed: r['제작자 확인'] === true,
        held: r['보류'] === true, pinUntil: r['기간 고정'] ? toRegistry_(r).pinUntil : '', check: r['검사'],
        problems: String(r['문제'] || '').split('\n').filter(Boolean), changed: !!e.changedAfterApproval,
        thumb: e.images && e.images.wide ? CONFIG.SITE + '/' + e.images.wide : '',
        previewA: CONFIG.SITE + '/?screen=a&embed=1&only=' + encodeURIComponent(r.id),
        previewB: CONFIG.SITE + '/?screen=b&embed=1&only=' + encodeURIComponent(r.id),
      };
    }),
    requests: requestRows.slice(-30).reverse().map((q) => ({
      id: q['요청 ID'], at: q['시각'] ? fmt_(new Date(q['시각']), 'MM/dd HH:mm') : '', type: q['종류'], project: q['작품 id'],
      text: q['내용'], status: q['상태'], note: q['비고'],
    })),
  };
}

function editRow_(id, fn, reqType, reqText) {
  const t = table_('작품', P_COLS);
  const r = t.rows.filter((x) => x.id === id)[0];
  if (!r) throw new Error('작품을 찾지 못했습니다: ' + id);
  fn(r);
  r['갱신 시각'] = now_();
  t.save(r);
  if (reqType) addRequest_(reqType, id, reqText || r['작품명'], RS.NEW, '');
  return r;
}

function adminApprove(id) {
  requireAdmin_();
  return withLock_(() => {
    editRow_(id, (r) => {
      r['교사'] = 'approved';
      r['승인 시각'] = now_();
      if (r['상태'] === S.WAIT_TEACHER || r['상태'] === S.HIDDEN) r['상태'] = S.WAIT_PUBLISH;
    }, '게시 승인');
    return '승인했습니다. ' + nextSyncText_() + '에 반영합니다. 바로 반영하려면 「지금 반영」을 누릅니다.';
  });
}

function adminHide(id) {
  requireAdmin_();
  return withLock_(() => {
    const r = editRow_(id, (x) => { x['교사'] = 'hidden'; x['상태'] = S.HIDDEN; });
    const syncId = patchRegistry_(id, { teacher: 'hidden' }, '긴급 숨김');
    if (syncId) {
      r['동기화 ID'] = syncId;
      table_('작품', P_COLS).save(r);
    }
    addRequest_('숨김', id, r['작품명'], syncId ? RS.DOING : RS.DONE, syncId ? '바로 반영' : '아직 GitHub에 올라가지 않은 작품', syncId);
    return '숨겼습니다. 1~2분 안에 화면에서 내려갑니다.';
  });
}

function adminRequestChanges(id, message) {
  requireAdmin_();
  const msg = clean_(message, 500, true);
  if (!msg) throw new Error('요청 내용을 적어 주세요.');
  return withLock_(() => {
    const r = editRow_(id, (x) => { x['상태'] = S.CHANGE_REQ; });
    addRequest_('수정 요청', id, msg, RS.DOING, '제작자에게 메일 보냄');
    mail_(r, 'teacherChange', { message: msg });
    return '제작자에게 수정 요청을 보냈습니다.';
  });
}

function adminPin(id, dateStr) {
  requireAdmin_();
  const d = String(dateStr || '').slice(0, 10);
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('날짜는 2026-11-06 처럼 적습니다.');
  return withLock_(() => {
    editRow_(id, (r) => { r['기간 고정'] = d; }, '기간 고정', d ? d + '까지 추천' : '고정 해제');
    return (d ? d + '까지 추천 작품으로 고정합니다. ' : '고정을 해제합니다. ') + nextSyncText_() + '에 반영합니다.';
  });
}

function adminHold(id, on) {
  requireAdmin_();
  return withLock_(() => {
    editRow_(id, (r) => { r['보류'] = !!on; }, on ? '' : '보류 해제');
    const reqs = table_('요청', R_COLS);
    reqs.rows.forEach((q) => {
      if (q['작품 id'] !== id) return;
      if (on && q['상태'] === RS.NEW) { q['상태'] = RS.HOLD; q['비고'] = '교사가 보류'; reqs.save(q); }
      if (!on && q['상태'] === RS.HOLD && q['비고'] === '교사가 보류') { q['상태'] = RS.NEW; q['비고'] = ''; reqs.save(q); }
    });
    return on ? '보류했습니다. 이 작품의 변경은 보류를 풀 때까지 반영하지 않습니다.' : '보류를 풀었습니다.';
  });
}

function adminStop(on) {
  requireAdmin_();
  return withLock_(() => {
    const rid = setControl_({ mode: on ? 'stop' : 'normal' }, on ? '긴급 정지' : '정지 해제');
    addRequest_(on ? '긴급 정지' : '정지 해제', '', '', RS.DOING, '바로 반영', rid);
    return on ? '긴급 정지를 요청했습니다. 1~2분 안에 두 화면이 정지 화면으로 바뀝니다.' : '정지를 해제했습니다.';
  });
}

function adminNotice(text, until) {
  requireAdmin_();
  const msg = clean_(text, 120);
  const u = String(until || '').trim();
  return withLock_(() => {
    const rid = setControl_({ notice: msg, noticeUntil: u ? iso_(new Date(u)) : '' }, msg ? '공지' : '공지 내림');
    addRequest_(msg ? '공지' : '공지 내림', '', msg, RS.DOING, '바로 반영', rid);
    return msg ? '공지를 올렸습니다.' : '공지를 내렸습니다.';
  });
}

function adminShowcase(id) {
  requireAdmin_();
  return withLock_(() => {
    const rid = setControl_({ showcase: id ? { project: String(id) } : null }, id ? 'B 화면 시연' : 'B 화면 복귀');
    addRequest_(id ? 'B 실행' : 'B 복귀', id || '', '', RS.DOING, '바로 반영', rid);
    return id ? 'B 화면에서 실행합니다. 학생이 체험 중이면 체험이 끝난 뒤 열립니다.' : 'B 화면을 기본 화면으로 돌립니다.';
  });
}

function adminSyncNow() {
  requireAdmin_();
  return withLock_(() => {
    const r = syncRegistry_('지금 반영');
    return r.changed ? 'GitHub에 보냈습니다. 검사가 필요한 작품은 몇 분 더 걸립니다.' : '새로 보낼 변경이 없습니다. 같은 내용의 기존 배포 여부를 확인합니다.';
  });
}

// 뉴스 숨김과 교사의 문구 수정은 RSS 재수집과 별도로 보관한다.
// 수정 요청 메모는 자동 집필이 아니라 대기 기록이며, 문구를 직접 고친 뒤 배포 확인으로 닫는다.
function newsId_(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value) || ['__proto__', 'constructor', 'prototype'].indexOf(value) >= 0) throw new Error('뉴스 번호가 올바르지 않습니다.');
  return value;
}

function setNewsControl_(id, patch, why, source) {
  const requestId = rid_('n');
  updateRepoJson_('projects/news-control.json', (c) => {
    const entries = c.entries || (c.entries = {});
    const before = entries[id] || {};
    const label = source ? { label: source.title || id } : {};
    entries[id] = Object.assign({}, label, before, patch, { updatedAt: iso_(now_()) });
    if (patch.request === null) delete entries[id].request;
    c.requestId = requestId;
    c.updatedAt = iso_(now_());
  }, '뉴스 관리: ' + why);
  return requestId;
}

function adminNewsHide(id, hidden) {
  requireAdmin_();
  const key = newsId_(id);
  return withLock_(() => {
    const source = (readRepoJson_('projects/news.json').data.items || []).filter((n) => n.id === key)[0];
    const requestId = setNewsControl_(key, { hidden: !!hidden }, hidden ? '숨김' : '숨김 해제', source);
    addRequest_(hidden ? '뉴스 숨김' : '뉴스 숨김 해제', key, '', RS.DOING, '화면 배포 대기', requestId);
    return hidden ? '뉴스 숨김을 요청했습니다. 다시 수집해도 숨김을 유지합니다.' : '뉴스 숨김을 해제했습니다. 수집 목록에 남아 있는 기사는 다시 표시합니다.';
  });
}

function adminNewsEdit(id, title, summary) {
  requireAdmin_();
  const key = newsId_(id), headline = clean_(title, 180), body = clean_(summary, 500);
  if (!headline) throw new Error('뉴스 제목을 적어 주세요.');
  return withLock_(() => {
    const requestId = setNewsControl_(key, { title: headline, summary: body, request: null }, '문구 수정');
    const reqs = table_('요청', R_COLS);
    reqs.rows.forEach((q) => {
      if (q['작품 id'] !== key || q['종류'] !== '뉴스 수정 요청' || q['상태'] === RS.DONE) return;
      q['상태'] = RS.DOING;
      q['반영 확인 값'] = requestId;
      q['비고'] = '문구 수정 · 화면 배포 대기';
      reqs.save(q);
    });
    addRequest_('뉴스 문구 수정', key, headline, RS.DOING, '화면 배포 대기', requestId);
    return '고친 제목과 요약을 보냈습니다. 화면 배포 뒤 반영 완료로 바뀝니다.';
  });
}

function adminNewsRequest(id, message) {
  requireAdmin_();
  const key = newsId_(id), text = clean_(message, 500, true);
  if (!text) throw new Error('수정할 내용을 적어 주세요.');
  return withLock_(() => {
    // 교사의 요청 메모는 비공개 시트에만 둔다. 공개 저장소에는 게시 문구만 보낸다.
    addRequest_('뉴스 수정 요청', key, text, RS.NEW, '수정 요청 기록 · 문구 수정으로 반영');
    return '수정 요청을 기록했습니다. 해당 뉴스의 「문구 수정」으로 고치면 배포까지 추적합니다.';
  });
}

// ======================================================================
// 요청 기록
// ======================================================================
function addRequest_(type, projectId, text, status, note, checkValue) {
  table_('요청', R_COLS).add({
    '요청 ID': rid_('r'), '시각': now_(), '종류': type, '작품 id': projectId || '', '내용': text || '', '상태': status,
    '처리 시각': status === RS.NEW ? '' : now_(), '반영 확인 값': checkValue || '', '비고': note || '',
  });
}

function closeRequests_(projectId, types, note) {
  const reqs = table_('요청', R_COLS);
  reqs.rows.forEach((q) => {
    if (q['작품 id'] !== projectId || types.indexOf(q['종류']) < 0 || q['상태'] === RS.DONE) return;
    q['상태'] = RS.DONE;
    q['처리 시각'] = now_();
    q['비고'] = note;
    reqs.save(q);
  });
}

// ======================================================================
// 메일
// ======================================================================
// Deploy.gs(배포 때 자동 생성)가 없으면 스크립트 속성과 현재 배포 주소를 사용한다
function deployed_(key) { return typeof DEPLOY !== 'undefined' && DEPLOY[key] ? DEPLOY[key] : ''; }
function webappUrl_() { return prop_('WEBAPP_URL') || deployed_('STATUS_URL') || ScriptApp.getService().getUrl() || ''; }
// 관리 화면은 스크립트 주인만 열 수 있는 테스트 배포(/dev) 주소를 쓴다
function adminUrl_() { return prop_('ADMIN_URL') || deployed_('ADMIN_URL') || (webappUrl_() ? webappUrl_() + '?page=admin' : ''); }

function statusUrl_(r) {
  const base = webappUrl_();
  return base ? base + '?t=' + encodeURIComponent(r['토큰']) : '';
}

function mail_(r, kind, extra) {
  const to = String(r['제작자 이메일'] || '').trim();
  if (!to || !TEXT.mail[kind]) return;
  const m = TEXT.mail[kind](r, extra || {}, statusUrl_(r));
  MailApp.sendEmail({ to: to, subject: '[' + CONFIG.TITLE + '] ' + m.subject, htmlBody: m.html, name: CONFIG.TITLE });
}

function mailHtml_(paras, button, link2) {
  return '<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">' +
    paras.filter(Boolean).map((p) => (p.charAt(0) === '<' ? p : '<p>' + p + '</p>')).join('') +
    (button && button.href ? '<p><a href="' + esc_(button.href) + '" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">' + esc_(button.label) + '</a></p>' : '') +
    (link2 && link2.href ? '<p><a href="' + esc_(link2.href) + '">' + esc_(link2.label) + '</a></p>' : '') +
    '<p style="color:#888;font-size:13px">이 메일은 ' + esc_(CONFIG.TITLE) + ' 작품 등록 시스템이 자동으로 보냈습니다.</p></div>';
}

function title_(r) { return '「' + esc_(r['작품명']) + '」'; }

function list_(items) { return items.length ? '<ul>' + items.map((x) => '<li>' + esc_(x) + '</li>').join('') + '</ul>' : ''; }

// 학생이 읽는 설문·상태·메일 문구는 이 한곳에만 둔다. 솔라 프로4가 집필했다(2026-10-30). 고칠 때도 여기만 고친다.
// 작품명 바로 뒤에는 조사를 붙이지 않는다. 작품명마다 받침이 달라 을/를, 이/가가 맞지 않으므로 「작품명」 작품을처럼 쓴다.
const TEXT = {
  formDesc: '학교 스탠바이미 화면에서 소개하고 체험할 웹앱을 등록하는 설문입니다. 이미 배포된 웹앱 주소가 필요합니다. ' +
    '제출 뒤 평일 하루 세 번 자동 검사가 진행되며, 시각은 7시 30분, 12시, 15시 30분 무렵입니다. 검사 결과는 메일로 안내합니다. ' +
    '작품명, 제작자 표시명, 소개, 작품 화면 캡처는 학교 화면과 공개 웹페이지에 표시됩니다. 이메일은 결과 안내에만 사용하며 공개되지 않습니다.',
  formDone: '접수가 완료되었습니다. 접수 확인 메일을 발송하였으며, 제출한 내용 수정은 메일 안의 「작품 정보 고치기」로 진행합니다.',
  consent: '작품명, 제작자 표시명, 소개, 작품 화면 캡처가 학교 화면과 공개 웹페이지에 표시되는 것에 동의합니다.',
  status: {
    '접수': '접수가 완료되었습니다. 다음 정기 처리 때 자동 검사가 시작됩니다.',
    '검사 대기': '자동 검사 차례를 기다리는 중입니다. 검사가 끝나면 메일로 안내합니다.',
    '보완 필요': '자동 검사에서 고칠 점이 나왔습니다. 아래 목록의 내용을 고친 뒤 「작품 정보 고치기」로 다시 제출합니다.',
    '제작자 확인 대기': '자동 검사가 끝났습니다. 학교 화면에 나올 모습을 확인한 뒤 「확인했습니다」를 누릅니다.',
    '교사 검토 대기': '선생님 검토를 기다리는 중입니다.',
    '게시 대기': '선생님 승인이 완료되었습니다. 다음 정기 처리 때 학교 화면에 게시됩니다.',
    '수정 요청': '선생님이 수정을 요청하였습니다. 메일로 보낸 요청 내용을 확인한 뒤 「작품 정보 고치기」로 다시 제출합니다.',
    '게시 중': '학교 화면에 게시 중입니다.',
    '숨김': '게시가 중지되었습니다. 궁금한 점은 선생님께 문의합니다.',
  },
  mail: {
    received: (r, x, link) => ({
      subject: '작품 접수: ' + r['작품명'],
      html: mailHtml_([title_(r) + ' 작품 접수가 완료되었습니다. 다음 정기 처리(' + esc_(nextSyncText_()) + ') 때 자동 검사가 시작되며, 검사 결과는 메일로 안내합니다.'],
        { href: link, label: '내 작품 상태 보기' }, { href: r['수정 링크'], label: '작품 정보 고치기' }),
    }),
    edited: (r, x, link) => ({
      subject: '작품 수정 접수: ' + r['작품명'],
      html: mailHtml_([title_(r) + ' 작품의 고친 내용 접수가 완료되었습니다. 다시 검사한 뒤 결과를 안내합니다. 고친 작품은 제작자 확인과 선생님 승인을 다시 거친 뒤 게시됩니다.'],
        { href: link, label: '내 작품 상태 보기' }),
    }),
    invalid: (r, x) => ({
      subject: '작품 등록 보완 필요: ' + (r['작품명'] || '이름 없음'),
      html: mailHtml_(['입력한 내용에 고칠 점이 있어 자동 검사를 시작하지 못했습니다.', list_(x.problems || [])],
        { href: r['수정 링크'], label: '작품 정보 고치기' }),
    }),
    checkFail: (r, x, link) => ({
      subject: '자동 검사 결과 보완 필요: ' + r['작품명'],
      html: mailHtml_([title_(r) + ' 작품의 자동 검사에서 고칠 점이 나왔습니다.', list_(x.problems || []), '고친 뒤 「작품 정보 고치기」로 다시 제출하면 다시 검사합니다.'],
        { href: r['수정 링크'], label: '작품 정보 고치기' }, { href: link, label: '내 작품 상태 보기' }),
    }),
    askConfirm: (r, x, link) => ({
      subject: '확인 요청: ' + r['작품명'],
      html: mailHtml_([title_(r) + ' 작품의 자동 검사가 끝났습니다. 학교 화면에 나올 모습을 확인한 뒤 「확인했습니다」를 누르면 선생님이 검토합니다.',
        (x.notes || []).length ? '참고: ' + list_(x.notes) : ''], { href: link, label: '화면 확인하기' }),
    }),
    teacherChange: (r, x, link) => ({
      subject: '선생님의 수정 요청: ' + r['작품명'],
      html: mailHtml_([title_(r) + ' 작품에 대한 선생님의 수정 요청을 전달합니다.', '<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px">' + esc_(x.message).replace(/\n/g, '<br>') + '</blockquote>',
        '고친 뒤 「작품 정보 고치기」로 다시 제출합니다.'], { href: r['수정 링크'], label: '작품 정보 고치기' }, { href: link, label: '내 작품 상태 보기' }),
    }),
    published: (r, x, link) => ({
      subject: '게시 시작: ' + r['작품명'],
      html: mailHtml_([title_(r) + ' 작품이 학교 화면에 게시되었습니다.' +
        (x.short ? ' 휴대폰으로 체험할 수 있는 짧은 주소는 <b>' + esc_(x.short) + '</b>입니다.' : '')],
        { href: link, label: '내 작품 상태 보기' }),
    }),
    changed: (r, x, link) => ({
      subject: '작품 변경 확인: ' + r['작품명'],
      html: mailHtml_(['선생님 승인 뒤 ' + title_(r) + ' 작품의 화면이 바뀐 것을 자동 검사가 확인하였습니다. 학교 화면의 소개와 실제 작품이 다를 수 있어 선생님이 다시 확인합니다. 제작자가 따로 할 일은 없습니다.'],
        { href: link, label: '내 작품 상태 보기' }),
    }),
  },
};

// ======================================================================
// 도구
// ======================================================================
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function ss_() { return SpreadsheetApp.openById(prop_('SHEET_ID')); }
function now_() { return new Date(); }
function fmt_(d, f) { return Utilities.formatDate(d, CONFIG.TZ, f); }
function iso_(d) { return fmt_(d instanceof Date ? d : new Date(d), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function rid_(kind) {
  // 같은 밀리초에 연속 요청이 와도 순서를 알 수 있도록 잠금 안에서 단조 증가시킨다.
  const previous = Number(prop_('LAST_REQUEST_MS') || 0);
  const ms = Math.max(now_().getTime(), previous + 1);
  setProp_('LAST_REQUEST_MS', String(ms));
  return fmt_(new Date(ms), 'yyyyMMdd-HHmmss') + String(ms % 1000).padStart(3, '0') + '-' + kind + Utilities.getUuid().slice(0, 4);
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// 이 앱의 관리 시트에는 수식을 사용하지 않는다. Google Sheets는 '=' 문자열을
// 수식으로 실행하므로, 모든 쓰기 경로에서 문자로 저장한다.
function sheetValue_(value) { return typeof value === 'string' && value.charAt(0) === '=' ? "'" + value : value; }

function neutralizeSheetFormulas_() {
  let count = 0;
  ['작품', '요청', '급식투표'].forEach((name) => {
    const sh = ss_().getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    const formulas = sh.getDataRange().getFormulas();
    formulas.slice(1).forEach((row, i) => row.forEach((formula, j) => {
      if (!formula) return;
      sh.getRange(i + 2, j + 1).setValue(sheetValue_(formula));
      count++;
    }));
  });
  return count;
}

function nextSyncText_() {
  const d = now_();
  for (let add = 0; add < 8; add++) {
    const day = new Date(d.getTime() + add * 86400000);
    const dow = Number(fmt_(day, 'u'));
    if (dow >= 6) continue;
    for (let i = 0; i < CONFIG.SYNC_TIMES.length; i++) {
      const hm = CONFIG.SYNC_TIMES[i];
      const label = (add === 0 ? '오늘' : fmt_(day, 'M월 d일')) + ' ' + hm[0] + '시' + (hm[1] ? ' ' + hm[1] + '분' : '') + ' 무렵';
      if (add > 0) return label;
      const nowMin = Number(fmt_(d, 'H')) * 60 + Number(fmt_(d, 'm'));
      if (hm[0] * 60 + hm[1] > nowMin) return label;
    }
  }
  return '다음 평일';
}

// 시트를 머리글 이름으로 읽고 쓴다. 열 순서를 바꿔도 동작한다.
function table_(name, cols) {
  const sh = ss_().getSheetByName(name);
  const range = sh.getDataRange();
  const values = range.getValues(), formulas = range.getFormulas();
  // 이전 버전에서 저장된 수식이 있더라도 계산 결과(다른 학생의 정보)를 내보내지 않는다.
  formulas.forEach((row, i) => row.forEach((formula, j) => { if (formula) values[i][j] = formula; }));
  const head = values[0];
  const rows = values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = v[j]; });
    return o;
  });
  const toArr = (o) => head.map((h) => sheetValue_(o[h] === undefined ? '' : o[h]));
  return {
    rows: rows,
    save: (o) => { sh.getRange(o._row, 1, 1, head.length).setValues([toArr(o)]); },
    add: (o) => { sh.appendRow(toArr(o)); o._row = sh.getLastRow(); rows.push(o); return o; },
  };
}

// GitHub 연동. 토큰은 스크립트 속성에만 둔다.
function gh_(method, path, body) {
  const token = prop_('GITHUB_TOKEN');
  if (!token) throw new Error('스크립트 속성에 GITHUB_TOKEN이 없습니다.');
  const opt = { method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch('https://api.github.com' + path, opt);
  const text = res.getContentText();
  return { code: res.getResponseCode(), json: text ? JSON.parse(text) : null };
}

function readRepoJson_(path) {
  const r = gh_('get', '/repos/' + CONFIG.REPO + '/contents/' + path + '?ref=main');
  if (r.code !== 200) throw new Error('GitHub 읽기 실패 ' + path + ' (' + r.code + ')');
  const text = Utilities.newBlob(Utilities.base64Decode(String(r.json.content).replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { sha: r.json.sha, data: JSON.parse(text) };
}

// 읽고 고쳐서 쓴다. 그 사이 다른 커밋이 끼어들면(sha 불일치) 다시 읽어서 고친다.
function updateRepoJson_(path, mutate, message) {
  for (let i = 0; i < 3; i++) {
    const cur = readRepoJson_(path);
    const before = JSON.stringify(cur.data);
    mutate(cur.data);
    if (JSON.stringify(cur.data) === before) return false;
    const content = Utilities.base64Encode(JSON.stringify(cur.data, null, 2) + '\n', Utilities.Charset.UTF_8);
    const w = gh_('put', '/repos/' + CONFIG.REPO + '/contents/' + path, { message: message, content: content, sha: cur.sha, branch: 'main' });
    if (w.code === 200 || w.code === 201) return true;
    if (w.code !== 409 && w.code !== 422) throw new Error('GitHub 쓰기 실패 ' + path + ' (' + w.code + ')');
    Utilities.sleep(1500 * (i + 1));
  }
  throw new Error('GitHub 쓰기가 계속 충돌합니다: ' + path);
}

function site_(path) {
  const res = UrlFetchApp.fetch(CONFIG.SITE + '/' + path + '?t=' + Date.now(), { muteHttpExceptions: true });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null;
}
