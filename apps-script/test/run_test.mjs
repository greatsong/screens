// Code.gs 전체 흐름 시험: 구글 서비스는 가짜로 두고, GitHub 저장소는 임시 복사본으로 흉내 낸다.
// 기본 검사는 고정 검사 결과와 실제 편성 스크립트로 네트워크 없이 실행한다.
// 실제 사이트 캡처까지 시험하려면 --network-checks를 명시한다.
// 사용법: node apps-script/test/run_test.mjs <임시 폴더> [--network-checks]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const TMP = process.argv[2];
const NETWORK_CHECKS = process.argv.includes('--network-checks');
if (!TMP) { console.error('임시 폴더를 인자로 넘깁니다.'); process.exit(2); }
fs.rmSync(TMP, { recursive: true, force: true });
for (const d of ['projects', 'site', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(TMP, d), { recursive: true });
fs.writeFileSync(path.join(TMP, 'projects/news-control.json'), JSON.stringify({ requestId: '', updatedAt: '', entries: {} }));

const SITE = 'https://greatsong.github.io/screens';
const TEACHER = 'teacher@school.kr';
const state = { active: TEACHER, outbox: [], commits: [], conflictOnce: '', failMailOnce: false, triggers: [], deletedTriggers: [], createdTriggers: [] };

// ---------- 가짜 구글 서비스 ----------
class Sheet {
  constructor() { this.data = []; }
  value(v) {
    if (typeof v !== 'string') return v;
    if (v.startsWith("'=")) return v.slice(1); // Google Sheets의 문자 이스케이프
    const m = /^=([A-Z]+)([1-9][0-9]*)$/.exec(v);
    if (!m) return v;
    let c = 0;
    for (const a of m[1]) c = c * 26 + a.charCodeAt(0) - 64;
    return this.data[Number(m[2]) - 1]?.[c - 1] ?? '';
  }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) { const row = sh.data[r - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => sh.value(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]))); }
        return out;
      },
      getFormulas() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = sh.data[r - 1 + i]?.[c - 1 + j]; return typeof v === 'string' && v.startsWith('=') ? v : ''; })); },
      setValues(v) { for (let i = 0; i < nr; i++) { sh.data[r - 1 + i] = sh.data[r - 1 + i] || []; for (let j = 0; j < nc; j++) sh.data[r - 1 + i][c - 1 + j] = v[i][j]; } },
      setValue(x) { sh.data[r - 1] = sh.data[r - 1] || []; sh.data[r - 1][c - 1] = x; },
    };
  }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  appendRow(a) { this.data.push(a.slice()); }
  setFrozenRows() {}
}
const sheets = {};
const ss = { getId: () => 'SHEET', getUrl: () => 'https://sheets.example/SHEET', getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = new Sheet()) };
const props = { SHEET_ID: 'SHEET', GITHUB_TOKEN: 'test-token', WEBAPP_URL: 'https://script.example/exec', FORM_ID: 'fake-form', FORM_VERSION: '2' };

function formatDate(d, tz, f) {
  const k = new Date(d.getTime() + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  const v = { yyyy: k.getUTCFullYear(), MM: p(k.getUTCMonth() + 1), M: k.getUTCMonth() + 1, dd: p(k.getUTCDate()), d: k.getUTCDate(),
    HH: p(k.getUTCHours()), H: k.getUTCHours(), mm: p(k.getUTCMinutes()), m: k.getUTCMinutes(), ss: p(k.getUTCSeconds()),
    u: k.getUTCDay() === 0 ? 7 : k.getUTCDay(), XXX: '+09:00' };
  let out = '';
  for (let i = 0; i < f.length;) {
    if (f[i] === "'") { const j = f.indexOf("'", i + 1); out += f.slice(i + 1, j); i = j + 1; continue; }
    const m = f.slice(i).match(/^(yyyy|MM|M|dd|d|HH|H|mm|m|ss|u|XXX)/);
    if (m) { out += v[m[1]]; i += m[1].length; } else { out += f[i]; i++; }
  }
  return out;
}
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fetch(url, opt = {}) {
  const api = 'https://api.github.com/repos/greatsong/screens/contents/';
  if (url.startsWith(api)) {
    const rel = decodeURIComponent(url.slice(api.length).split('?')[0]);
    const file = path.join(TMP, rel);
    if ((opt.method || 'get').toLowerCase() === 'get') {
      const buf = fs.readFileSync(file);
      return resp(200, { sha: sha(buf), content: buf.toString('base64').replace(/(.{60})/g, '$1\n') });
    }
    const body = JSON.parse(opt.payload);
    if (state.conflictOnce === rel) { // 그 사이 다른 커밋이 끼어든 상황
      state.conflictOnce = '';
      fs.appendFileSync(file, '\n');
      return resp(409, { message: 'sha mismatch' });
    }
    if (body.sha !== sha(fs.readFileSync(file))) return resp(409, { message: 'sha mismatch' });
    fs.writeFileSync(file, Buffer.from(body.content, 'base64'));
    state.commits.push({ path: rel, message: body.message });
    return resp(200, { content: { sha: sha(fs.readFileSync(file)) } });
  }
  if (url.startsWith(SITE + '/')) {
    const file = path.join(TMP, 'site', url.slice(SITE.length + 1).split('?')[0]);
    return fs.existsSync(file) ? resp(200, fs.readFileSync(file, 'utf8')) : resp(404, '');
  }
  throw new Error('예상하지 못한 요청 ' + url);
}

// 캐시: 시간이 지나 만료된 것처럼 하려면 cache.clear()
const cache = new Map();
const CacheMock = { get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => { cache.set(k, String(v)); }, remove: (k) => { cache.delete(k); } };
const ctx = vm.createContext({
  console,
  CacheService: { getScriptCache: () => CacheMock },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
  SpreadsheetApp: { openById: () => ss, create: () => ss },
  Utilities: {
    formatDate, getUuid: () => crypto.randomUUID(), sleep: () => {}, Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, s) => [...crypto.createHash('sha256').update(String(s), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'), base64Decode: (b) => [...Buffer.from(b, 'base64')],
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
  },
  UrlFetchApp: { fetch },
  MailApp: { sendEmail: (o) => { if (state.failMailOnce) { state.failMailOnce = false; throw new Error('mock mail failure'); } state.outbox.push(o); } },
  Session: { getActiveUser: () => ({ getEmail: () => state.active }), getEffectiveUser: () => ({ getEmail: () => TEACHER }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  FormApp: { openById: () => ({ getPublishedUrl: () => 'https://forms.example/fake', getEditUrl: () => 'https://forms.example/edit/fake' }) },
  ScriptApp: {
    getService: () => ({ getUrl: () => '' }), getProjectTriggers: () => state.triggers,
    deleteTrigger: (t) => state.deletedTriggers.push(t),
    newTrigger: (name) => {
      const chain = { create: () => { state.createdTriggers.push(name); } };
      for (const f of ['forForm', 'onFormSubmit', 'timeBased', 'atHour', 'nearMinute', 'everyDays', 'inTimezone', 'everyMinutes']) chain[f] = () => chain;
      return chain;
    },
  },
  Logger: { log: (x) => console.log('  [Logger]', x) },
});
vm.runInContext(fs.readFileSync(path.join(REPO, 'apps-script', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
const G = ctx;

// ---------- 도우미 ----------
let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  if (!ok) fails++;
}
function rows(name = '작품') {
  const [head, ...rest] = sheets[name].getDataRange().getValues();
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const row = (id) => rows().find((r) => r.id === id);
const reqs = (pid) => rows('요청').filter((q) => !pid || q['작품 id'] === pid);
const json = (rel) => JSON.parse(fs.readFileSync(path.join(TMP, rel), 'utf8'));
const mails = (to, sub) => state.outbox.filter((m) => m.to === to && (!sub || m.subject.includes(sub)));
function py(script) {
  const out = execFileSync('python3', [path.join(TMP, 'scripts', script)], { env: { ...process.env, SITE_BASE: SITE }, encoding: 'utf8' });
  console.log(out.trim().split('\n').map((l) => '    ' + l).join('\n'));
}
function github() {
  console.log('  [GitHub 흉내] ' + (NETWORK_CHECKS ? '실제 작품 검사' : '고정 검사 결과') + ' → 편성');
  if (NETWORK_CHECKS) py('check_projects.py');
  else {
    for (const p of json('projects/registry.json').projects) {
      if (p.source !== 'form') continue;
      const run = p.pinnedUrl || p.tryUrl || p.url, fail = run.includes('no-such-repo-xyz-123');
      const dir = path.join(TMP, 'site/projects', p.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({
        id: p.id, target: p.target || 'wide', url: run, checkedAt: '2026-10-31T09:00:00+09:00',
        status: fail ? 'fail' : 'ok', frame: { allowed: true }, fingerprint: sha(Buffer.from(run)),
        shots: { wide: { ok: !fail, image: 'wide.jpg' } }, problems: fail ? ['HTTP 404'] : [],
      }));
    }
  }
  py('build_projects.py');
}
function poll() { G.applyResults_(json('site/projects/index.json'), json('site/content.json')); }
function submit(id, email, a) {
  return G.handleSubmission_({
    getId: () => id, getRespondentEmail: () => email, getEditResponseUrl: () => 'https://forms.example/edit/' + id,
    getItemResponses: () => Object.entries(a).map(([t, v]) => ({ getItem: () => ({ getTitle: () => t }), getResponse: () => v })),
  });
}
const answers = (title, url, extra = {}) => ({ '작품명': title, '실행 주소': url, '한 줄 소개': title + ' 소개입니다.', '제작자 표시명': '2학년 시험팀', '제작자 구분': '2학년',
  '어느 화면에 맞나요?': '큰 화면용', '체험 방법': '첫 화면의 버튼을 누릅니다.', '공개 동의': ['동의'], ...extra });
const manualIds = () => json('projects/registry.json').projects.filter((p) => p.source !== 'form').map((p) => p.id).join(',');
const MANUAL = manualIds();

// ---------- 시나리오 ----------
console.log('1. 시트 준비와 설문 접수');
G.initSheets_();
const A = submit('resp-A', 'a@school.kr', answers('시험 작품 A', 'https://greatsong.github.io/aileader/'));
const B = submit('resp-B', 'b@school.kr', answers('시험 작품 B', 'https://greatsong.github.io/no-such-repo-xyz-123/'));
const C = submit('resp-C', 'c@school.kr', answers('시험 작품 C', 'http://example.com/'));
check('A·B 접수, C는 https가 아니라 보완 필요', row(A.id)['상태'] === '접수' && row(B.id)['상태'] === '접수' && row(C.id)['상태'] === '보완 필요');
check('접수 메일 2통, 보완 메일 1통', mails('a@school.kr', '작품 접수').length === 1 && mails('b@school.kr', '작품 접수').length === 1 && mails('c@school.kr', '보완 필요').length === 1);
check('접수 메일에 내 작품 상태 링크(토큰)', mails('a@school.kr')[0].htmlBody.includes('https://script.example/exec?t=' + row(A.id)['토큰']));

console.log('2. 정기 동기화');
G.syncRegistry_('시험');
let reg = json('projects/registry.json');
check('등록부에 A·B만 올라가고 C는 빠짐', reg.projects.filter((p) => p.source === 'form').map((p) => p.title).join() === '시험 작품 A,시험 작품 B');
check('사람이 등록한 작품은 그대로', manualIds() === MANUAL);
check('등록부에 이메일·토큰이 없음', !JSON.stringify(reg).includes('@school.kr') && !JSON.stringify(reg).includes(row(A.id)['토큰']));
check('배지용 제작자 구분이 등록부에 들어감 (2학년 → g2)', reg.projects.filter((p) => p.source === 'form').every((p) => p.makerType === 'g2'));
check('A·B 검사 대기, 등록 요청 처리 중', row(A.id)['상태'] === '검사 대기' && reqs(A.id)[0]['상태'] === '처리 중');

console.log('3. GitHub 검사·편성 뒤 결과 확인');
github();
poll();
check('A는 제작자 확인 대기, B는 보완 필요', row(A.id)['상태'] === '제작자 확인 대기' && row(B.id)['상태'] === '보완 필요', [row(A.id)['상태'], row(B.id)['상태']]);
check('A에 확인 요청 메일, B에 검사 결과 메일', mails('a@school.kr', '확인 요청').length === 1 && mails('b@school.kr', '자동 검사 결과').length === 1);
check('등록 요청은 반영 완료', reqs(A.id)[0]['상태'] === '반영 완료');
poll();
check('같은 결과로 다시 확인해도 메일을 또 보내지 않음', mails('a@school.kr', '확인 요청').length === 1 && mails('b@school.kr', '자동 검사 결과').length === 1);
check('상태 화면: 잘못된 토큰은 열리지 않음', G.statusData('wrong-token-wrong-token') === null);
const sd = G.statusData(row(A.id)['토큰']);
check('상태 화면: 캡처와 A·B 미리보기 주소', sd.canConfirm && sd.wide.startsWith(SITE + '/projects/') && sd.previewB.includes('only=' + A.id));

console.log('4. 제작자 확인 → 교사 알림 → 승인 → 게시');
G.makerConfirm(row(A.id)['토큰']);
check('A는 교사 검토 대기', row(A.id)['상태'] === '교사 검토 대기');
poll();
check('교사에게 검토 알림 한 통', mails(TEACHER, '검토할 작품 1개').length === 1);
poll();
check('검토할 작품이 그대로면 알림을 또 보내지 않음', mails(TEACHER, '검토할').length === 1);
check('승인 메시지에 다음 정기 처리 안내', G.adminApprove(A.id).includes('반영합니다'));
check('승인 직후 게시 대기', row(A.id)['상태'] === '게시 대기');
G.adminSyncNow();
reg = json('projects/registry.json');
const regA = reg.projects.find((p) => p.id === A.id);
check('등록부에 승인·제작자 확인·승인 시각', regA.teacher === 'approved' && regA.makerConfirmed === true && !!regA.approvedAt);
github();
poll();
const content = json('site/content.json');
check('편성된 화면 내용에도 배지 값이 들어감', content.projects.find((p) => p.id === A.id).makerType === 'g2');
check('A가 화면 편성에 들어감', content.projects.some((p) => p.id === A.id));
check('A 게시 중, 게시 메일에 짧은 주소', row(A.id)['상태'] === '게시 중' && mails('a@school.kr', '게시 시작')[0].htmlBody.includes('/p/' + row(A.id)['번호']));
check('짧은 주소 이동 페이지 생성', fs.existsSync(path.join(TMP, 'site/p', String(row(A.id)['번호']), 'index.html')));

console.log('5. 긴급 정지 (바로 반영)');
G.adminStop(true);
const ctl = json('projects/control.json');
check('control.json에 정지와 요청 id', ctl.mode === 'stop' && /-a/.test(ctl.requestId));
const stopReq = rows('요청').filter((q) => q['종류'] === '긴급 정지')[0];
check('긴급 정지 요청은 처리 중', stopReq['상태'] === '처리 중');
py('build_projects.py');
poll();
check('편성 뒤 content.json이 정지 상태', json('site/content.json').mode === 'stop');
check('화면 배포를 확인하고 반영 완료', rows('요청').filter((q) => q['종류'] === '긴급 정지')[0]['상태'] === '반영 완료');
G.adminStop(false);
py('build_projects.py');

console.log('6. 긴급 숨김 (해당 작품만 바로 반영)');
const before = state.commits.length;
G.adminHide(A.id);
check('등록부 커밋 1번, A만 숨김', state.commits.length === before + 1 && json('projects/registry.json').projects.find((p) => p.id === A.id).teacher === 'hidden');
py('build_projects.py');
poll();
check('A가 편성에서 빠지고 짧은 주소도 지워짐', !json('site/content.json').projects.some((p) => p.id === A.id) && !fs.existsSync(path.join(TMP, 'site/p', String(row(A.id)['번호']))));
check('A 숨김, 숨김 요청 반영 완료', row(A.id)['상태'] === '숨김' && rows('요청').filter((q) => q['종류'] === '숨김')[0]['상태'] === '반영 완료');
G.syncRegistry_('시험');
check('다시 동기화해도 숨김 유지', json('projects/registry.json').projects.find((p) => p.id === A.id).teacher === 'hidden');

console.log('7. 교사 수정 요청 → 제작자가 고쳐 제출 → 다시 검사');
G.adminRequestChanges(B.id, '주소가 열리지 않습니다. 배포 주소를 확인해 주세요.');
check('B 수정 요청, 제작자에게 메일', row(B.id)['상태'] === '수정 요청' && mails('b@school.kr', '수정 요청').length === 1);
submit('resp-B', 'b@school.kr', answers('시험 작품 B', 'https://greatsong.github.io/workshop/'));
check('같은 응답을 고치면 같은 작품으로 접수', rows().filter((r) => r['응답 ID'] === 'resp-B').length === 1 && row(B.id)['상태'] === '접수');
check('수정 요청은 반영 완료로 닫힘', reqs(B.id).find((q) => q['종류'] === '수정 요청')['상태'] === '반영 완료');
G.syncRegistry_('시험');
github();
poll();
check('B는 새 주소로 검사해 제작자 확인 대기', row(B.id)['상태'] === '제작자 확인 대기', row(B.id)['상태']);

console.log('8. 보류와 쓰기 충돌');
G.adminHold(B.id, true);
submit('resp-B', 'b@school.kr', answers('시험 작품 B', 'https://greatsong.github.io/workshop/', { '한 줄 소개': '보류 중에 고친 소개' }));
G.syncRegistry_('시험');
check('보류한 작품은 지난번 내용 유지', json('projects/registry.json').projects.find((p) => p.id === B.id).summary === '시험 작품 B 소개입니다.');
G.adminHold(B.id, false);
state.conflictOnce = 'projects/registry.json';
G.adminSyncNow();
check('쓰기 충돌이 나도 다시 읽어 반영', json('projects/registry.json').projects.find((p) => p.id === B.id).summary === '보류 중에 고친 소개');
check('사람이 등록한 작품은 끝까지 그대로', manualIds() === MANUAL);

console.log('9. 권한');
state.active = 'student@school.kr';
let denied = false;
try { G.adminStop(true); } catch (e) { denied = /권한/.test(e.message); }
check('학생 계정으로는 관리 함수를 부를 수 없음', denied && json('projects/control.json').mode === 'normal');
state.active = '';
denied = false;
try { G.adminData(); } catch (e) { denied = true; }
check('로그인하지 않은 사람도 막힘', denied);

console.log('10. 메일 문구');
const bodies = state.outbox.map((m) => m.htmlBody).join('\n');
check('작품명 바로 뒤에 조사가 붙지 않음', !/시험 작품 [ABC]」(을|를|이|가|은|는)/.test(bodies));
check('빈 문단이 없음', !bodies.includes('<p></p>'));
check('게시 메일에 짧은 주소를 굵게 표시', /짧은 주소는 <b>[^<]+\/p\/\d+<\/b>입니다/.test(mails('a@school.kr', '게시 시작')[0].htmlBody));

console.log('11. 수식 주입·설치 권한·기존 수식 전환');
state.active = '';
denied = false;
try { G.setup(); } catch (e) { denied = /권한/.test(e.message); }
check('비로그인 setup 차단, 트리거 변경 없음', denied && state.deletedTriggers.length === 0 && state.createdTriggers.length === 0);
check('트리거 전용 함수는 공개 RPC 이름에서 제거', !G.onFormSubmitTrigger && !G.scheduledSync && !G.pollResults && typeof G.pollResults_ === 'function');
for (const fn of ['adminNewsHide', 'adminNewsEdit', 'adminNewsRequest']) {
  denied = false;
  try { G[fn]('news-fixture-1', 'test', 'test'); } catch (e) { denied = /권한/.test(e.message); }
  check(fn + ' 비로그인 차단', denied);
}
state.active = TEACHER;
const formula = submit('resp-formula', 'formula@school.kr', answers('=L2', 'https://app.example.invalid/', {
  '한 줄 소개': '=X2', '제작자 표시명': '=Y2', '체험 방법': '=L2', '자동 시연할 동작': '=X2',
}));
const formulaRow = row(formula.id);
check('제출 문구를 수식이 아닌 문자로 보관', formulaRow['작품명'] === '=L2' && formulaRow['한 줄 소개'] === '=X2' && formulaRow['제작자 표시명'] === '=Y2');
check('새로 저장한 셀에는 실행 수식이 없음', sheets['작품'].getDataRange().getFormulas().flat().every((f) => !f));
G.adminPin(formula.id, '2026-11-06'); // editRow_ → save 경로도 같은 보호를 적용한다
G.addRequest_('수식 시험', formula.id, '=L2', '접수', '=X2');
check('save와 요청 기록의 수식도 문자 유지', row(formula.id)['작품명'] === '=L2' && reqs(formula.id).at(-1)['내용'] === '=L2' && sheets['요청'].getDataRange().getFormulas().flat().every((f) => !f));
const dataRow = rows().findIndex((r) => r.id === formula.id) + 2;
sheets['작품'].getRange(dataRow, 3).setValue('=L2'); // 이전 버전에서 들어온 수식
check('기존 수식은 계산된 개인정보 대신 수식 문자로 읽음', G.table_('작품', []).rows.find((r) => r.id === formula.id)['작품명'] === '=L2');
state.triggers = ['old-form-trigger', 'old-sync-trigger'];
G.setup();
check('관리자 setup이 기존 수식을 문자로 전환', sheets['작품'].getDataRange().getFormulas().flat().every((f) => !f) && row(formula.id)['작품명'] === '=L2');
check('setup이 기존 트리거를 비공개 함수 이름으로 교체', state.deletedTriggers.length === 2 && state.createdTriggers.length === 5 && state.createdTriggers.every((n) => n.endsWith('_')));
G.syncRegistry_('수식 안전 시험');
const safeEntry = json('projects/registry.json').projects.find((p) => p.id === formula.id);
check('공개 등록부에도 수식 문자만 나오고 다른 학생 정보 없음', safeEntry.title === '=L2' && safeEntry.summary === '=X2' && safeEntry.maker === '=Y2');

console.log('12. 교사 메일 실패 뒤 재시도');
const oldDigest = props.DIGEST_KEY;
props.DIGEST_KEY = 'before-failure';
state.failMailOnce = true;
let mailFailed = false;
try { G.teacherDigest_([row(A.id)], []); } catch (e) { mailFailed = /mock mail failure/.test(e.message); }
check('메일 실패 때 알림 완료로 기록하지 않음', mailFailed && props.DIGEST_KEY === 'before-failure');
const teacherMailsBefore = mails(TEACHER).length;
G.teacherDigest_([row(A.id)], []);
check('다음 확인 때 같은 검토 목록을 다시 발송', mails(TEACHER).length === teacherMailsBefore + 1 && props.DIGEST_KEY === A.id);
props.DIGEST_KEY = oldDigest;

console.log('13. 뉴스 숨김·문구 수정·수정 요청 추적');
const newsId = 'news-fixture-1';
const newsFixture = { id: newsId, title: '원래 뉴스 제목', summary: '원래 요약', source: '시험 출처', date: new Date().toISOString().slice(0, 10), link: 'https://news.example.invalid/1' };
fs.writeFileSync(path.join(TMP, 'projects/news.json'), JSON.stringify({ items: [newsFixture] }));
G.adminNewsHide(newsId, true);
let newsControl = json('projects/news-control.json');
check('뉴스 숨김을 별도 파일에 저장', newsControl.entries[newsId].hidden && newsControl.entries[newsId].label === newsFixture.title && !('title' in newsControl.entries[newsId]));
newsFixture.title = '다시 받은 뉴스 제목';
fs.writeFileSync(path.join(TMP, 'projects/news.json'), JSON.stringify({ items: [newsFixture] }));
py('build_projects.py');
poll();
check('재수집·편성해도 숨긴 뉴스가 다시 나타나지 않음', !json('site/content.json').news.some((n) => n.id === newsId));
check('뉴스 숨김 요청은 배포 확인 뒤 완료', reqs(newsId).find((q) => q['종류'] === '뉴스 숨김')['상태'] === '반영 완료');
check('관리 화면에는 숨긴 뉴스도 남음', G.adminData().news.items.some((n) => n.id === newsId && n.hidden));
G.adminNewsHide(newsId, false);
py('build_projects.py');
check('숨김 해제는 최신 원문 제목을 사용', json('site/content.json').news.find((n) => n.id === newsId)?.title === newsFixture.title);
const privateNewsNote = '요약에서 핵심 기능을 먼저 알려 주세요. 비공개 교사 메모입니다.';
const commitsBeforeNewsNote = state.commits.length;
G.adminNewsRequest(newsId, privateNewsNote);
check('교사 수정 요청은 공개 JSON이나 새 커밋에 남기지 않음', state.commits.length === commitsBeforeNewsNote && !JSON.stringify(json('projects/news-control.json')).includes(privateNewsNote));
check('비공개 수정 요청은 관리자에게 표시', G.adminData().news.items.find((n) => n.id === newsId).request === privateNewsNote);
py('build_projects.py');
poll();
check('요청 메모만 배포했다고 수정 완료로 표시하지 않음', reqs(newsId).find((q) => q['종류'] === '뉴스 수정 요청')['상태'] === '접수');
G.adminNewsEdit(newsId, '교사가 고친 제목', '교사가 고친 요약');
check('문구 수정 뒤에도 내부 메모를 공개하지 않음', !JSON.stringify(json('projects/news-control.json')).includes(privateNewsNote) && !('request' in json('projects/news-control.json').entries[newsId]));
check('문구 수정 뒤 요청은 배포 대기', reqs(newsId).find((q) => q['종류'] === '뉴스 수정 요청')['상태'] === '처리 중');
py('build_projects.py');
poll();
check('교사 문구를 화면에 반영', json('site/content.json').news.find((n) => n.id === newsId)?.title === '교사가 고친 제목' && json('site/content.json').news.find((n) => n.id === newsId)?.summary === '교사가 고친 요약');
check('수정 요청과 문구 수정 모두 배포 확인 뒤 완료', reqs(newsId).filter((q) => ['뉴스 수정 요청', '뉴스 문구 수정'].includes(q['종류'])).every((q) => q['상태'] === '반영 완료'));

console.log('14. 연속 요청의 배포 확인 순서');
check('같은 초에 나온 새 요청이 앞선 요청을 반영 완료로 만들 수 있음', G.idAtLeast_('20261031-090000124-nbbbb', '20261031-090000123-naaaa') && !G.idAtLeast_('20261031-090000123-naaaa', '20261031-090000124-nbbbb'));
check('예전 초 단위 ID와 새 밀리초 ID를 함께 비교', G.idAtLeast_('20261031-090000001-nbbbb', '20261031-090000-naaaa') && G.idAtLeast_('20261031-090001-nbbbb', '20261031-090000999-naaaa'));
check('같은 초의 서로 다른 예전 ID는 완료로 추측하지 않음', !G.idAtLeast_('20261031-090000-nbbbb', '20261031-090000-naaaa'));
const oldNow = G.now_, oldRequestMs = props.LAST_REQUEST_MS;
G.now_ = () => new Date(Number(oldRequestMs) + 2000);
const firstId = G.rid_('n'), secondId = G.rid_('n');
check('시계가 같은 밀리초여도 요청 ID가 순서대로 증가', firstId !== secondId && G.idAtLeast_(secondId, firstId) && !G.idAtLeast_(firstId, secondId));
G.now_ = oldNow;
props.LAST_REQUEST_MS = oldRequestMs;

console.log('15. 같은 내용을 다시 요청해도 배포 전에 완료로 표시하지 않음');
G.adminPin(B.id, '2026-12-01');
G.adminSyncNow();
const pendingSyncId = json('projects/registry.json').syncId;
G.adminPin(B.id, '2026-12-01');
const duplicatePinId = reqs(B.id).at(-1)['요청 ID'];
const duplicateSync = G.syncRegistry_('중복 요청 시험');
const duplicatePin = () => reqs(B.id).find((q) => q['요청 ID'] === duplicatePinId);
check('내용이 같으면 새 커밋 없이 기존 동기화 ID에 연결', !duplicateSync.changed && duplicatePin()['반영 확인 값'] === pendingSyncId);
check('기존 커밋이 배포되기 전 중복 요청도 처리 중 유지', duplicatePin()['상태'] === '처리 중');
poll();
check('예전 배포 파일을 확인해도 중복 요청을 완료로 만들지 않음', duplicatePin()['상태'] === '처리 중');
py('build_projects.py');
poll();
check('기존 커밋의 실제 배포를 확인한 뒤 중복 요청 완료', duplicatePin()['상태'] === '반영 완료');

console.log('16. 급식 메뉴 투표 (화면 터치·휴대폰)');
const today = G.fmt_(G.now_(), 'yyyyMMdd');
const vote = (o) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ api: 'vote', date: today, src: 'phone', ...o }) } }).text);
check('형식이 틀린 투표는 받지 않음', !vote({ dish: '카레', dev: 'short' }).ok && !vote({ dish: '', dev: 'phone-aaaaaaaa' }).ok && !vote({ date: '2026-11-02', dish: '카레', dev: 'phone-aaaaaaaa' }).ok);
check('너무 먼 날짜는 받지 않음', !vote({ date: '20301231', dish: '카레', dev: 'phone-aaaaaaaa' }).ok);
check('깨진 JSON은 오류', JSON.parse(G.doPost({ postData: { contents: '{' } }).text).ok === false);
const v1 = vote({ dish: '단호박카레라이스', dev: 'phone-aaaaaaaa' });
check('휴대폰 첫 투표가 1표', v1.ok && v1.counts['단호박카레라이스'] === 1, v1);
const v2 = vote({ dish: '단호박카레라이스', dev: 'phone-aaaaaaaa' });
check('같은 휴대폰·같은 메뉴는 다시 세지 않음', v2.dup && v2.counts['단호박카레라이스'] === 1, v2);
check('다른 휴대폰은 따로 셈', vote({ dish: '단호박카레라이스', dev: 'phone-bbbbbbbb' }).counts['단호박카레라이스'] === 2);
const s1 = vote({ dish: '조각케이크', dev: 'screen-b-0001', src: 'screen' });
const s2 = vote({ dish: '조각케이크', dev: 'screen-b-0001', src: 'screen' });
check('화면 터치는 2초 안에 한 번만', s1.counts['조각케이크'] === 1 && s2.wait && s2.counts['조각케이크'] === 1, [s1, s2]);
cache.clear();
check('2초가 지나면 같은 화면에서 다시 투표', vote({ dish: '조각케이크', dev: 'screen-b-0001', src: 'screen' }).counts['조각케이크'] === 2);
vote({ dish: '=HYPERLINK("https://evil.example","x")', dev: 'phone-cccccccc' });
check('수식처럼 보이는 메뉴 이름은 시트에 문자로 저장', sheets['급식투표'].data.some((r) => String(r[2]).startsWith("'=")));
check('시트 기록에 기기 번호 원문이 없음', !JSON.stringify(sheets['급식투표'].data).includes('phone-aaaaaaaa'));
const all = JSON.parse(props.MEAL_VOTES);
all['20200101'] = { '옛 메뉴': 3 };
props.MEAL_VOTES = JSON.stringify(all);
cache.clear();
vote({ dish: '팽이장국', dev: 'phone-dddddddd' });
check('3주 지난 집계는 지움', !('20200101' in JSON.parse(props.MEAL_VOTES)));
const got = JSON.parse(G.doGet({ parameter: { api: 'votes' } }).text);
check('?api=votes 가 오늘 집계를 돌려줌', got.ok && got.days[today]['단호박카레라이스'] === 2 && got.days[today]['팽이장국'] === 1, got);

console.log(fails ? `\n실패 ${fails}개` : '\n모든 시험 통과');
console.log(`보낸 메일 ${state.outbox.length}통, GitHub 커밋 ${state.commits.length}번`);
process.exit(fails ? 1 : 0);
