import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { initializeMonthlyReportRoutes } from '../api/monthlyReportModule.js';
import { fakeApp, fakeCron, fakeNotion, fakeNotify, fakeGemini, fakeRes, page, prop, helpers } from './fakes.mjs';

const publicPath = fileURLToPath(new URL('../public', import.meta.url));
const DB = { STUDENT_DATABASE_ID: 'db-student', PROGRESS_DATABASE_ID: 'db-progress', MONTHLY_REPORT_DB_ID: 'db-monthly' };

/** 노션 수식이 실제로 돌려주는 값은 87.77777777777779 같은 실수다. */
const progressRow = (date, grammarScore) => page('p-' + date, {
    '수행율': prop.formulaString('83.33333333333334%'),
    '📰 단어 테스트 점수': prop.formulaNumber(92.5),
    '📑 문법 시험 점수': prop.formulaNumber(grammarScore),
    '📚 독해 해석 시험 결과': prop.formulaString('PASS'),
    '문법 테스트 내용': prop.multi(['to부정사']),
    '단어(맞은 개수)': prop.number(18),
    '🕐 날짜': prop.date(date),
    "❤ Today's Notice!": prop.text('오늘 to부정사를 정리했습니다.'),
});

function setup({ students, progress, existingReport = [], gemini = fakeGemini() } = {}) {
    const app = fakeApp();
    const cron = fakeCron();
    const notifyOwner = fakeNotify();
    const notion = fakeNotion({
        'db-student': { rows: students ?? [page('stu-1', { '이름': prop.title('김리디') })] },
        'db-progress': { rows: progress ?? [progressRow('2026-08-05', 87.77777777777779), progressRow('2026-08-29', 66.66666666666667)] },
        'db-monthly': { rows: existingReport },
    });

    initializeMonthlyReportRoutes({
        app, cron, fetchNotion: notion.fetchNotion, geminiModel: gemini.model,
        requireAuth: (req, res, next) => next(),
        dbIds: DB, domainUrl: 'https://readiplan.example.com', publicPath,
        notifyOwner, ...helpers,
    });
    return { app, cron, notion, gemini, notifyOwner };
}

const genOne = async (app, query) => {
    const res = fakeRes();
    await app.routes['GET /api/manual-monthly-report-gen']({ query }, res);
    return res;
};

test('노션 수식의 실수 점수는 정수로 저장된다', async () => {
    const { app, notion } = setup();
    await genOne(app, { studentName: '김리디', month: '2026-08' });

    const props = notion.writes[0].properties;
    assert.equal(props['문법점수(평균)'].number, 78);   // (88 + 67) / 2 = 77.5 → 78
    assert.equal(props['어휘점수(평균)'].number, 93);   // 92.5 → 93
    assert.doesNotMatch(JSON.stringify(props), /\d+\.\d{3,}/, '저장된 통계에 소수점이 샜다');
});

test('AI 프롬프트에도 소수점이 들어가지 않는다', async () => {
    const { app, gemini } = setup();
    await genOne(app, { studentName: '김리디', month: '2026-08' });

    const prompt = gemini.prompts[0];
    assert.match(prompt, /to부정사\(88점\)/);
    assert.doesNotMatch(prompt, /\d+\.\d{3,}/, '프롬프트로 소수점이 새면 AI 요약 본문에 박힌다');
});

test('프롬프트는 목록에 없는 섹션을 요구하지 않는다', async () => {
    const { app, gemini } = setup();
    await genOne(app, { studentName: '김리디', month: '2026-08' });
    assert.doesNotMatch(gemini.prompts[0], /독해 및 문법/);
});

test('긴 AI 요약은 문장 한가운데가 아니라 문장 끝에서 잘린다', async () => {
    const long = '### 🌟 종합\n' + '이번 달 성취도는 전반적으로 안정적인 흐름을 보였습니다. '.repeat(80);
    const { app, notion } = setup({ gemini: fakeGemini(long) });
    await genOne(app, { studentName: '김리디', month: '2026-08' });

    const saved = notion.writes[0].properties['AI 요약'].rich_text[0].text.content;
    assert.ok(saved.length <= 2000, '노션 rich_text 상한을 넘었다');
    assert.match(saved, /다\.$/, '문장 중간에서 끊겼다 — 학부모 화면에 그대로 나간다');
});

test('조회 범위는 그 달 1일부터 말일까지 닫힌다', async () => {
    const { app, notion } = setup();
    await genOne(app, { studentName: '김리디', month: '2026-02' });

    const q = notion.queries.find(x => x.db === 'db-progress');
    assert.equal(q.filter.and[1].date.on_or_after, '2026-02-01');
    assert.equal(q.filter.and[2].date.on_or_before, '2026-02-28');
});

test('이미 리포트가 있으면 통계만 갱신하고 AI 는 다시 만들지 않는다', async () => {
    const existing = [page('rep-1', {})];
    const { app, notion, gemini } = setup({ existingReport: existing });
    await genOne(app, { studentName: '김리디', month: '2026-08' });

    assert.equal(gemini.prompts.length, 0, 'AI 를 다시 불렀다 — 비용');
    assert.equal(notion.writes[0].op, 'patch');
    assert.ok(notion.writes[0].properties['문법점수(평균)'], '통계는 갱신돼야 한다');
    assert.ok(!('AI 요약' in notion.writes[0].properties), '기존 AI 요약을 덮어썼다');
});

test('force=true 면 AI 를 다시 만든다', async () => {
    const { app, gemini } = setup({ existingReport: [page('rep-1', {})] });
    await genOne(app, { studentName: '김리디', month: '2026-08', force: 'true' });
    assert.equal(gemini.prompts.length, 1);
});

test('크론은 매월 1일 09:00 KST 에 등록된다', () => {
    const { cron } = setup();
    assert.equal(cron.jobs[0].expression, '0 9 1 * *');
    assert.equal(cron.jobs[0].options.timezone, 'Asia/Seoul');
});

test('배치는 명부 100명을 넘어도 이어 읽고, 한 명이 터져도 계속 돈다', async () => {
    const students = (body) => body.start_cursor
        ? { results: [page('s3', { '이름': prop.title('박플랜') }), page('s4', { '이름': prop.title('최폭발') })] }
        : { results: [page('s1', { '이름': prop.title('김리디') })], has_more: true, next_cursor: 'c2' };

    const progress = (body) => {
        const name = body.filter.and[0].title.equals;
        if (name === '박플랜') return [];                       // 데이터 없음 → skip
        if (name === '최폭발') throw new Error('Notion 409');    // 한 명만 터진다
        return [progressRow('2026-08-05', 87.77777777777779)];
    };

    const app = fakeApp();
    const cron = fakeCron();
    const notion = fakeNotion({ 'db-student': { rows: students }, 'db-progress': { rows: progress }, 'db-monthly': { rows: [] } });
    initializeMonthlyReportRoutes({
        app, cron, fetchNotion: notion.fetchNotion, geminiModel: fakeGemini().model,
        requireAuth: (q, r, n) => n(), dbIds: DB,
        domainUrl: 'https://readiplan.example.com', publicPath, notifyOwner: fakeNotify(), ...helpers,
    });

    const res = fakeRes();
    await app.routes['POST /api/monthly-report/tick']({ query: { month: '2026-08' } }, res);

    assert.equal(res.body.created, 1);                       // 1쪽의 김리디
    assert.equal(res.body.skipped, 1, '2쪽까지 이어 읽지 못했다');  // 2쪽의 박플랜 — 데이터 없음
    assert.equal(res.body.failed, 1);                        // 2쪽의 최폭발 — 터졌지만 루프는 계속됐다
    assert.deepEqual(res.body.failedNames, ['최폭발']);

    const rosterReads = notion.queries.filter(q => q.db === 'db-student');
    assert.equal(rosterReads.length, 2, '명부를 한 쪽만 읽었다');
    assert.equal(rosterReads[1].cursor, 'c2', 'next_cursor 를 따라가지 않았다');
});

test('학부모가 보는 화면에도 소수점이 남지 않는다', async () => {
    const reportRow = page('rep-1', {
        '학생': prop.relation(['stu-1']),
        '숙제수행율(평균)': prop.number(83),
        '어휘점수(평균)': prop.number(93),
        '문법점수(평균)': prop.number(77),
        '독해 통과율(%)': prop.number(100),
        '총 읽은 권수': prop.number(0),
        'AI 요약': prop.text('### 🌟 종합\n안정적입니다.'),
    });
    const notion = fakeNotion({
        'db-monthly': { rows: [reportRow] },
        'db-progress': { rows: [progressRow('2026-08-05', 87.77777777777779), progressRow('2026-08-29', 95)] },
    });
    // 학생 페이지 조회(GET /v1/pages/stu-1)는 fakeNotion 이 모르므로 이 테스트에서만 감싼다
    const fetchNotion = async (url, opts) => url.includes('/v1/pages/stu-1') && !opts
        ? { properties: { '이름': prop.title('김리디') } }
        : notion.fetchNotion(url, opts);

    const app = fakeApp();
    initializeMonthlyReportRoutes({
        app, cron: fakeCron(), fetchNotion, geminiModel: null,
        requireAuth: (q, r, n) => n(), dbIds: DB,
        domainUrl: 'https://readiplan.example.com', publicPath, ...helpers,
    });

    const res = fakeRes();
    await app.routes['GET /monthly-report']({ query: { studentId: 'stu-1', month: '2026-08' } }, res);

    assert.ok(res.sent, '페이지가 안 그려졌다');
    assert.match(res.sent, /88점/);
    assert.doesNotMatch(res.sent, /\d+\.\d{3,}/, '학부모 화면에 87.7777… 이 남았다');
});
