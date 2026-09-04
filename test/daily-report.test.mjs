import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeDailyReportRoutes } from '../api/dailyReportModule.js';
import { fakeApp, fakeCron, fakeNotion, fakeRes, page, prop, helpers } from './fakes.mjs';

const publicPath = fileURLToPath(new URL('../public', import.meta.url));
const PROGRESS = 'db-progress';

/**
 * api/index.js 에서 통째로 옮긴 모듈이다. 옮기면서 깨지지 않았는지 —
 * 라우트·크론이 그대로 달리고 생성 로직이 그대로 도는지 — 를 본다.
 */
function setup({ students = [], existingRows = [], pause = null, parsed = null } = {}) {
    const app = fakeApp();
    const cron = fakeCron();
    const notion = fakeNotion({ [PROGRESS]: { rows: existingRows } });

    initializeDailyReportRoutes({
        app, cron, fs, path, publicPath,
        requireAuth: (req, res, next) => next(),
        fetchNotion: notion.fetchNotion,
        DOMAIN_URL: 'https://readiplan.example.com',
        PROGRESS_DATABASE_ID: PROGRESS,
        getKSTTodayRange: () => ({ dateString: '2026-09-03', start: '', end: '' }),
        getKoreanDate: helpers.getKoreanDate,
        getSimpleText: helpers.getSimpleText,
        getActivePause: async () => pause,
        readStudentConfigs: async () => students,
        dashboardCache: { dailyReport: { lastFetch: Date.now(), data: null, date: null } },
        // buildReportHtml 이 실제로 읽는 모양 그대로 (parsed.* 참조를 코드에서 뽑아 맞췄다)
        parseDailyReportData: async () => ({
            studentName: '김리디',
            date: '2026-09-03',
            teachers: ['헤더쌤'],
            completionRate: 100,
            comment: { grammarTopic: 'to부정사', grammarHomework: 'p.30', teacherComment: '오늘 잘했습니다.' },
            homework: { grammar: '숙제 함', vocabCards: '숙제 함', readingCards: '숙제 함',
                        dailyReading: '숙제 함', diary: '숙제 함', summary: '숙제 함' },
            assignedHw: { vocab: 'Day 3', mainR: 'Unit 2', subR: '-' },
            reading: { bookTitle: 'Holes', bookAR: 4.6, bookLexile: '660L',
                       englishBooks: ['Holes'], readingStatus: '완료', writingStatus: '완료' },
            listening: { study: '' },
            tests: { vocabScore: 90, grammarScore: 88, readingResult: 'PASS' },
            ...(parsed || {}),
        }),
    });
    return { app, cron, notion };
}

/** 오늘 요일 문자('수' 등). 모듈이 같은 방식으로 계산한다. */
const todayChar = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' }).format(new Date());
const student = (name, pageId) => ({ name, pageId, days: [todayChar] });

test('옮긴 뒤에도 라우트가 전부 그대로 달린다', () => {
    const { app } = setup();
    for (const r of [
        'GET /report', 'GET /my-report', 'GET /api/my-report-dates', 'GET /api/my-report',
        'GET /api/my-homework', 'GET /api/admin/regenerate-urls', 'POST /api/generate-daily-reports',
    ]) {
        assert.ok(app.routes[r], `라우트가 사라졌다: ${r}`);
    }
});

test('크론 둘이 KST 로 등록된다 — 10:20 생성 · 22:00 URL', () => {
    const { cron } = setup();
    const exprs = cron.jobs.map(j => j.expression).sort();
    assert.deepEqual(exprs, ['0 22 * * *', '20 10 * * *']);
    assert.ok(cron.jobs.every(j => j.options.timezone === 'Asia/Seoul'));
});

test('오늘 수강요일인 학생의 진도 행을 만든다', async () => {
    const { app, notion } = setup({ students: [student('김리디', 'stu-1'), student('이튜드', 'stu-2')] });

    const res = fakeRes();
    await app.routes['POST /api/generate-daily-reports']({ query: {}, body: {} }, res);

    assert.deepEqual(res.body.created, ['김리디', '이튜드']);
    assert.equal(notion.writes.length, 2);
    assert.equal(notion.writes[0].db, PROGRESS);
    assert.equal(notion.writes[0].properties['🕐 날짜'].date.start, '2026-09-03');
    assert.equal(notion.writes[0].properties['학생 명부 관리'].relation[0].id, 'stu-1');
});

test('이미 오늘 행이 있는 학생은 건너뛴다 (몇 번 돌려도 안전)', async () => {
    const existing = [page('p-1', { '학생 명부 관리': prop.relation(['stu-1']) })];
    const { app, notion } = setup({ students: [student('김리디', 'stu-1'), student('이튜드', 'stu-2')], existingRows: existing });

    const res = fakeRes();
    await app.routes['POST /api/generate-daily-reports']({ query: {}, body: {} }, res);

    assert.deepEqual(res.body.skipped, ['김리디']);
    assert.deepEqual(res.body.created, ['이튜드']);
    assert.equal(notion.writes.length, 1);
});

test('오늘이 수강요일이 아닌 학생은 만들지 않는다', async () => {
    const notToday = { name: '박플랜', pageId: 'stu-9', days: ['일'].filter(d => d !== todayChar) };
    const { app, notion } = setup({ students: [notToday] });

    const res = fakeRes();
    await app.routes['POST /api/generate-daily-reports']({ query: {}, body: {} }, res);
    assert.equal(notion.writes.length, 0);
});

test('10:20 크론은 정지 기간(휴강)이면 아무것도 만들지 않는다', async () => {
    const { cron, notion } = setup({
        students: [student('김리디', 'stu-1')],
        pause: { reason: '추석 휴강' },
    });
    const gen = cron.jobs.find(j => j.expression === '20 10 * * *');
    await gen.run();

    assert.equal(notion.writes.length, 0, '휴강인데 진도 행이 생겼다 — 그날 리포트가 나가고 등원한 것처럼 보인다');
});

test('22:00 크론은 그날 행에 데일리리포트URL 을 채운다', async () => {
    const rows = [page('p-1', { '데일리리포트URL': prop.url(null) })];
    const { cron, notion } = setup({ existingRows: rows });

    await cron.jobs.find(j => j.expression === '0 22 * * *').run();

    assert.equal(notion.writes.length, 1);
    assert.equal(notion.writes[0].op, 'patch');
    assert.equal(
        notion.writes[0].properties['데일리리포트URL'].url,
        'readiplan.example.com/report?pageId=p-1&date=2026-09-03',
    );
});

test('URL 이 이미 맞으면 다시 쓰지 않는다 (노션 쓰기 아끼기)', async () => {
    const url = 'readiplan.example.com/report?pageId=p-1&date=2026-09-03';
    const rows = [page('p-1', { '데일리리포트URL': prop.url(url) })];
    const { cron, notion } = setup({ existingRows: rows });

    await cron.jobs.find(j => j.expression === '0 22 * * *').run();
    assert.equal(notion.writes.length, 0);
});

/**
 * 🔴 2026-09-03 사고: 모듈을 분리하면서 parseDailyReportData 주입을 빠뜨렸다.
 * /report 가 ReferenceError 를 던졌고 라우트의 catch 가 그걸 500 'Report Error' 로 삼켜
 * 학부모가 리포트를 열 때마다 에러를 봤다. 라우트가 '존재하는지'만 보던 테스트는 이걸 못 잡는다.
 * 그래서 실제로 그려보는 테스트를 둔다.
 */
test('/report 가 실제로 HTML 을 그린다 (주입 누락이면 500 이 된다)', async () => {
    const { app } = setup({ existingRows: [page('p-1', {})] });
    const res = fakeRes();
    await app.routes['GET /report']({ query: { pageId: 'p-1' } }, res);

    assert.notEqual(res.code, 500, '/report 가 500 을 뱉었다 — 주입 누락이나 렌더 오류다');
    assert.ok(res.sent, 'HTML 이 안 나왔다');
    assert.match(res.sent, /<html|<!DOCTYPE|<div/i, 'HTML 이 아니다');
});

test('pageId 가 없으면 400 (500 이 아니라)', async () => {
    const { app } = setup();
    const res = fakeRes();
    await app.routes['GET /report']({ query: {} }, res);
    assert.equal(res.code, 400);
});
