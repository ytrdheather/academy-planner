/**
 * 교재비 — 담당쌤 알림 두 갈래 · 미입금 안내.
 *
 * 🔴 이 모듈은 진짜로 학부모에게 돈 얘기를 보낸다. 로컬에서 서버를 띄우면 실제로 나간다
 *    → wiki/pitfalls/local-server-fires-crons.md
 *    그래서 노션·솔라피·카카오워크를 전부 가짜로 바꾸고 모듈만 올린다.
 *
 * 여기서 지키려는 것 (전부 실제로 사고가 났거나 날 뻔한 지점):
 *   · 금요일에 몰아 승인하면 담당쌤 알림이 통째로 안 나가던 것 (2026-09-04)
 *   · 미입금 독촉이 두 번 나가는 것 — 타임스탬프로 막는다
 *   · 템플릿이 없을 때 "보낸 셈" 치고 넘어가는 것 — 고치면 나가야 한다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { initializeTextbookFeeRoutes } from '../api/textbookFeeModule.js';
import { fakeNotion, fakeApp, fakeCron, fakeRes, page, prop } from './fakes.mjs';

const FEE_DB = 'fee-db';
const TEACHER_DB = 'teacher-db';
const 하루 = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/** 바깥으로 나가는 fetch 를 전부 가로챈다. 진짜 네트워크는 한 번도 안 탄다. */
function stubFetch() {
    const calls = { solapi: [], kakaowork: [], openDm: [] };
    const 원래 = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : {};
        if (String(url).includes('solapi')) {
            calls.solapi.push(body.message);
            return { ok: true, json: async () => ({ groupInfo: {} }) };
        }
        if (String(url).includes('conversations.open')) {
            calls.openDm.push(body.user_id);
            return { ok: true, json: async () => ({ success: true, conversation: { id: 'dm-conv' } }) };
        }
        if (String(url).includes('messages.send')) {
            calls.kakaowork.push({ conv: body.conversation_id, text: body.text });
            return { ok: true, json: async () => ({ success: true }) };
        }
        throw new Error('가짜가 모르는 요청: ' + url);
    };
    calls.restore = () => { globalThis.fetch = 원래; };
    return calls;
}

/** filter 를 문자열로 훑어 어떤 질의인지 가른다 — 실제 필터 모양을 그대로 검사하게 된다. */
const 질의 = (body) => JSON.stringify(body.filter || {});

function 세우기({ feeRows, textbookConv = 'conv-교재', unpaidConv = 'conv-미수금', unpaidDmUserId = '777' }) {
    const notion = fakeNotion({
        [FEE_DB]: { rows: feeRows },
        // 학생·교재 페이지는 id 로 GET 된다. rows 가 함수인 DB 는 가짜가 훑지 않으므로 따로 둔다.
        'aux-db': { rows: [학생, 교재] },
        [TEACHER_DB]: {
            rows: [page('t1', { 이름: prop.title('레일라쌤'), '카카오워크 ID': prop.text('9001') })],
        },
    });
    const app = fakeApp();
    const cron = fakeCron();
    initializeTextbookFeeRoutes({
        app, cron, path, publicPath: '',
        requireAuth: (req, res, next) => next(),
        fetchNotion: notion.fetchNotion,
        sendKakaoWork: async () => true,
        sendSms: async () => true,
        jwtSecret: 'test', domainUrl: 'http://test',
        dbIds: { TEXTBOOK_FEE_DB_ID: FEE_DB, TEACHER_DB_ID: TEACHER_DB },
        approvalConv: 'conv-원장', textbookConv, unpaidConv, unpaidDmUserId,
    });
    return { notion, app, cron };
}

/** 학생·교재 페이지. 위 'aux-db' 에 담겨 id 로 GET 된다. */
const 학생 = page('s1', { 이름: prop.title('윤재현') });
const 교재 = page('b1', { 교재이름: prop.title('Core Phonics 1'), 가격: prop.number(15000) });

const 미입금행 = (over = {}) => page('r1', {
    학생: prop.relation(['s1']),
    '변경 교재': prop.relation(['b1']),
    '교재 목록': prop.formulaString('Core Phonics 1'),
    '청구 금액': prop.formulaNumber(13500),
    '학부모 연락처': { type: 'rollup', rollup: { type: 'array', array: [{ type: 'phone_number', phone_number: '01012345678' }] } },
    진행상태: prop.select('발송완료'),
    '발송 일시': prop.date(iso(Date.now() - 8 * 하루)),
    '입금 확인': prop.checkbox(false),
    '미입금 안내일시': prop.date(null),
    교사알림함: prop.checkbox(true),
    원장알림함: prop.checkbox(false),
    ...over,
});

test('미입금: 안내가 나가고 안내일시가 찍힌다 — 채널과 DM 양쪽에 올라간다', async () => {
    process.env.ALIMTALK_TPL_TEXTBOOK_UNPAID = 'KA01TP_TEST_UNPAID';
    process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's'; process.env.SOLAPI_SENDER = '0212345678';
    const f = stubFetch();
    try {
        const { notion, app } = 세우기({
            feeRows: (body) => (질의(body).includes('미입금 안내일시') ? [미입금행()] : []),
        });
        const res = fakeRes();
        await app.routes['POST /api/textbook/notify-unpaid']({ query: {} }, res);

        assert.equal(res.body.대상, 1);
        assert.equal(res.body.발송, 1);
        assert.equal(f.solapi.length, 1, '학부모께 한 번만 나가야 한다');
        assert.equal(f.solapi[0].kakaoOptions.templateId, 'KA01TP_TEST_UNPAID');
        assert.equal(f.solapi[0].kakaoOptions.disableSms, true, '독촉은 문자 폴백을 두지 않는다');
        // 🔴 변수가 비면 자리표시자가 그대로 학부모 폰에 찍힌다
        for (const v of Object.values(f.solapi[0].kakaoOptions.variables)) assert.ok(v, `빈 변수: ${v}`);
        assert.equal(f.solapi[0].kakaoOptions.variables['#{학생이름}'], '윤재현');

        const 찍음 = notion.writes.find(w => w.properties?.['미입금 안내일시']);
        assert.ok(찍음, '미입금 안내일시를 찍어야 두 번 안 나간다');
        assert.equal(찍음.id, 'r1');

        const 방 = f.kakaowork.map(x => x.conv);
        assert.ok(방.includes('conv-미수금'), '미수금 채널에 올라가야 한다');
        assert.ok(방.includes('dm-conv'), '이명수님 DM 에도 가야 한다');
        assert.deepEqual(f.openDm, [777]);
    } finally { f.restore(); }
});

test('미입금: 한 학생에 두 건이면 합쳐서 한 통만 보낸다 (두 통 받으면 안 된다)', async () => {
    process.env.ALIMTALK_TPL_TEXTBOOK_UNPAID = 'KA01TP_TEST_UNPAID';
    process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's'; process.env.SOLAPI_SENDER = '0212345678';
    const f = stubFetch();
    try {
        const 둘째 = { ...미입금행(), id: 'r2' };
        const { notion, app } = 세우기({
            feeRows: (body) => (질의(body).includes('미입금 안내일시') ? [미입금행(), 둘째] : []),
        });
        const res = fakeRes();
        await app.routes['POST /api/textbook/notify-unpaid']({ query: {} }, res);

        assert.equal(res.body.대상, 2, '행은 두 개다');
        assert.equal(f.solapi.length, 1, '🔴 학부모께는 한 통만 나가야 한다');
        assert.equal(f.solapi[0].kakaoOptions.variables['#{교재비}'], '27,000원', '금액은 합산');
        const 찍은행 = notion.writes.filter(w => w.properties?.['미입금 안내일시']).map(w => w.id).sort();
        assert.deepEqual(찍은행, ['r1', 'r2'], '묶인 행 전부에 찍어야 내일 또 안 나간다');
    } finally { f.restore(); }
});

test('미입금: 템플릿 ID 가 없으면 아무것도 찍지 않는다 (고치면 다음 회차에 나가야 하므로)', async () => {
    delete process.env.ALIMTALK_TPL_TEXTBOOK_UNPAID;
    const f = stubFetch();
    try {
        const { notion, app } = 세우기({
            feeRows: (body) => (질의(body).includes('미입금 안내일시') ? [미입금행()] : []),
        });
        const res = fakeRes();
        await app.routes['POST /api/textbook/notify-unpaid']({ query: {} }, res);

        assert.equal(res.body.발송, 0);
        assert.equal(f.solapi.length, 0);
        assert.equal(notion.writes.filter(w => w.properties?.['미입금 안내일시']).length, 0,
            '못 보냈는데 찍으면 영영 안 나간다');
        assert.ok(res.body.실패.some(s => s.includes('ALIMTALK_TPL_TEXTBOOK_UNPAID')));
    } finally { f.restore(); }
});

test('미입금: 질의 조건이 (발송완료 · 입금 미확인 · 안내 안 함 · 기준일 경과) 네 가지를 다 건다', async () => {
    process.env.ALIMTALK_TPL_TEXTBOOK_UNPAID = 'KA01TP_TEST_UNPAID';
    const f = stubFetch();
    try {
        const { notion, app } = 세우기({ feeRows: () => [] });
        await app.routes['POST /api/textbook/notify-unpaid']({ query: {} }, fakeRes());
        const q = notion.queries.map(x => JSON.stringify(x.filter)).find(s => s.includes('미입금 안내일시'));
        assert.ok(q.includes('"발송완료"'));
        assert.ok(q.includes('"입금 확인"') && q.includes('false'));
        assert.ok(q.includes('is_empty'));
        assert.ok(q.includes('on_or_before'), '노션에 날짜 필터를 넘긴다 — JS 로 거르지 않는다');
    } finally { f.restore(); }
});

test('교사알림: 주간 알림이 발송완료 건을 잡는다 (금요일 몰아 승인으로 묻히던 것)', async () => {
    const f = stubFetch();
    try {
        const 행 = 미입금행({ 진행상태: prop.select('발송완료'), 교사알림함: prop.checkbox(false), 담임쌤: { type: 'rollup', rollup: { type: 'array', array: [prop.multi(['레일라쌤'])] } } });
        const { notion, app } = 세우기({
            feeRows: (body) => (질의(body).includes('교사알림함') && 질의(body).includes('발송완료') ? [행] : []),
        });
        const res = fakeRes();
        await app.routes['POST /api/textbook/notify-teachers']({ query: {} }, res);

        assert.equal(res.body.mode, '주간');
        assert.equal(res.body.선생, 1, '레일라쌤께 나가야 한다');
        assert.ok(f.kakaowork.some(x => x.text.includes('윤재현')));
        assert.ok(notion.writes.some(w => w.properties?.['교사알림함']?.checkbox === true), '플래그를 올려야 반복되지 않는다');
    } finally { f.restore(); }
});

test('교사알림: 주간은 최근 2주만 본다 (플래그 규칙을 바꾼 첫 회차에 과거가 쓸려 나오면 안 된다)', async () => {
    const f = stubFetch();
    try {
        const { notion, app } = 세우기({ feeRows: () => [] });
        await app.routes['POST /api/textbook/notify-teachers']({ query: {} }, fakeRes());
        const q = notion.queries.map(x => JSON.stringify(x.filter)).find(s => s.includes('교사알림함'));
        assert.ok(q.includes('on_or_after'), '오래된 발송완료 건이 통째로 딸려 나온다');
        assert.ok(q.includes('is_empty'), '아직 안 나간 승인 건은 날짜로 거르면 안 된다');
    } finally { f.restore(); }
});

test('교사알림: mode=반려 는 반려 건만 묻는다', async () => {
    const f = stubFetch();
    try {
        const { notion, app } = 세우기({ feeRows: () => [] });
        await app.routes['POST /api/textbook/notify-teachers']({ query: { mode: '반려' } }, fakeRes());
        const q = notion.queries.map(x => JSON.stringify(x.filter)).find(s => s.includes('교사알림함'));
        assert.ok(q.includes('"반려"'));
        assert.ok(!q.includes('"발송완료"'), '반려 회차에 승인 건이 섞이면 선생이 주 2통 넘게 받는다');
    } finally { f.restore(); }
});

test('플래그 정리: 교사알림함은 되돌아간 상태에서만 내린다 (발송완료에서 내리면 알림이 묻힌다)', async () => {
    const f = stubFetch();
    try {
        const { notion, app } = 세우기({ feeRows: () => [] });
        await app.routes['POST /api/textbook/tick']({ query: {} }, fakeRes());
        const q = notion.queries.map(x => JSON.stringify(x.filter)).find(s => s.includes('교사알림함'));
        assert.ok(q.includes('"승인대기"') && q.includes('"작성중"'));
        assert.ok(!q.includes('does_not_equal'), '"승인됨·반려가 아니면 내린다" 로 돌아가면 안 된다');
    } finally { f.restore(); }
});

test('크론 등록: 새 스케줄에도 timezone 이 붙어 있다', async () => {
    const f = stubFetch();
    try {
        const { cron } = 세우기({ feeRows: () => [] });
        const 표 = cron.jobs.map(j => j.expression);
        assert.ok(표.includes('10 11 * * 1'), '월요일 11:10 미입금 독촉');
        assert.ok(!표.includes('0 11 * * 1'), '11:00 정각은 숙제 자동 생성과 겹친다');
        assert.ok(표.includes('0 14 * * 1-5'), '평일 14시 반려 알림');
        for (const j of cron.jobs) assert.equal(j.options?.timezone, 'Asia/Seoul', `timezone 없음: ${j.expression}`);
    } finally { f.restore(); }
});
