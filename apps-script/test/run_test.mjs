// Code.gs 전체 흐름 시험: 구글 서비스는 가짜로 두고, GitHub 저장소는 임시 복사본으로 흉내 낸다.
// 검사·편성은 실제 파이썬 스크립트(check_projects.py, build_projects.py)를 임시 복사본에서 돌린다.
// 사용법: node apps-script/test/run_test.mjs <임시 폴더>
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const TMP = process.argv[2];
if (!TMP) { console.error('임시 폴더를 인자로 넘깁니다.'); process.exit(2); }
fs.rmSync(TMP, { recursive: true, force: true });
for (const d of ['projects', 'site', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(TMP, d), { recursive: true });

const SITE = 'https://greatsong.github.io/screens';
const TEACHER = 'teacher@school.kr';
const state = { active: TEACHER, outbox: [], commits: [], conflictOnce: '' };

// ---------- 가짜 구글 서비스 ----------
class Sheet {
  constructor() { this.data = []; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) { const row = sh.data[r - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j]))); }
        return out;
      },
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
const props = { SHEET_ID: 'SHEET', GITHUB_TOKEN: 'test-token', WEBAPP_URL: 'https://script.example/exec' };

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

const ctx = vm.createContext({
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
  SpreadsheetApp: { openById: () => ss, create: () => ss },
  Utilities: {
    formatDate, getUuid: () => crypto.randomUUID(), sleep: () => {}, Charset: { UTF_8: 'UTF-8' },
    base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'), base64Decode: (b) => [...Buffer.from(b, 'base64')],
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
  },
  UrlFetchApp: { fetch },
  MailApp: { sendEmail: (o) => state.outbox.push(o) },
  Session: { getActiveUser: () => ({ getEmail: () => state.active }), getEffectiveUser: () => ({ getEmail: () => TEACHER }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ScriptApp: { getService: () => ({ getUrl: () => '' }) },
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
  const [head, ...rest] = sheets[name].data;
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
function github() { console.log('  [GitHub 흉내] 작품 검사 → 편성'); py('check_projects.py'); py('build_projects.py'); }
function poll() { G.applyResults_(json('site/projects/index.json'), json('site/content.json')); }
function submit(id, email, a) {
  return G.handleSubmission_({
    getId: () => id, getRespondentEmail: () => email, getEditResponseUrl: () => 'https://forms.example/edit/' + id,
    getItemResponses: () => Object.entries(a).map(([t, v]) => ({ getItem: () => ({ getTitle: () => t }), getResponse: () => v })),
  });
}
const answers = (title, url, extra = {}) => ({ '작품명': title, '실행 주소': url, '한 줄 소개': title + ' 소개입니다.', '제작자 표시명': '2학년 시험팀',
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

console.log(fails ? `\n실패 ${fails}개` : '\n모든 시험 통과');
console.log(`보낸 메일 ${state.outbox.length}통, GitHub 커밋 ${state.commits.length}번`);
process.exit(fails ? 1 : 0);
