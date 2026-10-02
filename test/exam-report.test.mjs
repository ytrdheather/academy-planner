import test from 'node:test';
import assert from 'node:assert/strict';

import { initializeExamAnalyzerRoutes } from '../api/examAnalyzerModule.js';
import { fakeApp, fakeNotion, fakeRes, page, prop } from './fakes.mjs';

// 학부모용 시험 분석 리포트 — 생성(난이도·학습 브리핑) → 공개(사본 저장) → 학부모 링크 → 공개 취소
// → wiki/systems/exam-analyzer.md

const DB = { EXAM_DB_ID: 'db-exam', QUESTION_DB_ID: 'db-question', STUDENT_RESULT_DB_ID: 'db-result', STUDENT_ANSWER_DB_ID: 'db-answer' };
const owner = { user: { loginId: 'manager', name: '원장' } };

const resultPage = (extra = {}) => ({
    ...page('res-1', {
        '학생명': prop.title('조은서'),
        '시험': prop.relation(['exam-1']),
        '점수': prop.number(91), '만점': prop.number(100), '정답수': prop.number(2), '오답수': prop.number(1),
        '서술형채점': prop.select('완료'), '학교': prop.select('영덕중학교'), '학년': prop.select('2학년'),
        ...extra,
    }),
    created_time: '2026-10-02T03:00:00.000Z',
    parent: { type: 'database_id', database_id: 'db-result' },
});

const answer = (n, verdict, score, earned, type, sa, a) => page('ans-' + n, {
    '번호': prop.title(n), '유형': prop.select(type), '문법포인트': prop.text(n === '14' ? '분사 어형' : ''),
    '정답': prop.text(a), '학생답': prop.text(sa), '정오': prop.select(verdict), '배점': prop.number(score), '획득점수': prop.number(earned),
});
const keyRow = (n, difficulty, source) => page('q-' + n, {
    '번호': prop.title(n), '유형': prop.select('어법이해'), '출제범위': prop.select(source), '문법포인트': prop.text(''),
    '정답': prop.text('3'), '배점': prop.number(5), '난이도': prop.select(difficulty),
});

/** 프롬프트에 따라 답한다: JSON 을 요구하면 리포트 문구, 아니면 종합 코멘트 */
function gemini() {
    const prompts = [];
    return {
        prompts,
        model: {
            generateContent: async ({ contents }) => {
                const p = contents[0].parts[0].text;
                prompts.push(p);
                const text = p.includes('JSON 형식')
                    ? JSON.stringify({ diagnosis: '진단 문장', reasons: { '15': '확인 부족으로 보입니다.' }, plan: ['계획1', '계획2', '계획3'],
                        attitude: { good: '숙제를 빠짐없이', regret: '본문 암기가 늦음', selfImprove: '은서가 스스로', academyFocus: '본문 점검' } })
                    : '종합 코멘트 문장입니다.';
                return { response: { text: () => text } };
            },
        },
    };
}

function setup({ coverage = null, result = resultPage(), study = { classDays: 12, stats: { hwAvg: 92, vocabAvg: 91, grammarAvg: 80, readingPassRate: 100 }, comments: '[2026-09-20] 본문 암기 재시험' } } = {}) {
    const app = fakeApp();
    const g = gemini();
    const notion = fakeNotion({
        'db-result': { rows: [result] },
        'db-exam': { rows: [page('exam-1', { '시험명': prop.title('영덕중학교 2학년 2026 2학기 중간고사'), '학기': prop.select('2학기'), '시험년도': prop.number(2026) })] },
        'db-answer': { rows: [
            answer('14', '정답', 5, 5, '어휘추론', '3', '3'),
            answer('15', '오답', 5, 0, '내용일치', '1', '5'),
            answer('16', '정답', 5, 5, '어법이해', '2', '2'),
        ] },
        'db-question': { rows: [keyRow('14', '상', '외부지문'), keyRow('15', '하', '교과서본문'), keyRow('16', '중', '대화문')] },
    });
    const studyCalls = [];
    initializeExamAnalyzerRoutes({
        app, requireAuth: (req, res, next) => next(), fetchNotion: notion.fetchNotion, geminiModel: g.model,
        loadStudyPeriod: async (...args) => { studyCalls.push(args); return study; },
        loadCoverage: () => coverage,
        dbIds: DB,
    });
    const call = async (key, req) => { const res = fakeRes(); res.set = () => res; await app.routes[key]({ ...owner, ...req }, res); return res; };
    return { app, notion, g, studyCalls, call };
}

test('리포트 데이터: 난이도별 결과가 코멘트 프롬프트에 들어가고 학습 브리핑이 붙는다', async () => {
    const { call, g, studyCalls } = setup();
    const res = await call('GET /api/student-report-data', { query: { resultId: 'res-1' } });
    assert.equal(res.body.success, true, JSON.stringify(res.body));

    const comment = g.prompts.find(p => !p.includes('JSON 형식'));
    assert.match(comment, /상 난이도 1문항 중 1문항 정답 — 맞힌 상 문항: 14번/);
    assert.match(comment, /하 난이도 1문항 중 0문항 정답 — 틀린 문항: 15번/);
    assert.match(comment, /하 난이도 문항을 틀린 것이 있으면 따로 분석한다/);

    // 학습 브리핑은 채점일 기준 30일 전부터
    assert.deepEqual(studyCalls[0], ['조은서', '2026-09-02', '2026-10-02']);
    assert.equal(res.body.parentReport.attitude.good, '숙제를 빠짐없이');
    assert.equal(res.body.parentReport.attitude.classDays, 12);
    assert.equal(res.body.parentReport.v, 3);
    assert.equal(res.body.wrongQuestions[0].difficulty, '하');
    assert.equal(res.body.publishedAt, null);
});

test('리포트 데이터: 프롬프트 버전이 같은 캐시가 있으면 AI 를 부르지 않는다', async () => {
    const cached = JSON.stringify({ v: 3, diagnosis: '캐시 진단', reasons: {}, plan: ['p'], attitude: null });
    const { call, g, studyCalls } = setup({ result: resultPage({ '리포트AI': prop.text(cached), 'AI코멘트': prop.text('캐시 코멘트') }) });
    const res = await call('GET /api/student-report-data', { query: { resultId: 'res-1' } });
    assert.equal(g.prompts.length, 0);
    assert.equal(studyCalls.length, 0);
    assert.equal(res.body.overallComment, '캐시 코멘트');
    assert.equal(res.body.parentReport.diagnosis, '캐시 진단');
});

test('리포트 데이터: 옛 버전 캐시는 버리고 코멘트까지 다시 만든다', async () => {
    const old = JSON.stringify({ diagnosis: '옛 진단', reasons: {}, plan: [], attitude: null }); // v 없음
    const { call, g } = setup({ result: resultPage({ '리포트AI': prop.text(old), 'AI코멘트': prop.text('옛 코멘트') }) });
    const res = await call('GET /api/student-report-data', { query: { resultId: 'res-1' } });
    assert.equal(g.prompts.length, 2);
    assert.equal(res.body.overallComment, '종합 코멘트 문장입니다.');
    assert.equal(res.body.parentReport.diagnosis, '진단 문장');
});

test('학부모 공개: 사본과 공개일시를 결과행에 쓴다', async () => {
    const { call, notion } = setup();
    const report = { student: { name: '조은서' }, summary: { score: 91 }, overallComment: '고친 코멘트' };
    const res = await call('POST /api/exam-report/publish', { body: { resultId: 'res-1', report } });
    assert.equal(res.body.success, true, JSON.stringify(res.body));
    assert.equal(res.body.path, '/exam-report?id=res-1');

    const w = notion.writes.find(x => x.op === 'patch' && x.id === 'res-1');
    const saved = JSON.parse(w.properties['학부모리포트'].rich_text.map(t => t.text.content).join(''));
    assert.equal(saved.report.overallComment, '고친 코멘트');
    assert.ok(w.properties['공개일시'].date.start);
});

test('학부모 공개: 긴 사본은 2000자 조각으로 나눠 쓴다', async () => {
    const { call, notion } = setup();
    const report = { student: { name: '조은서' }, summary: { score: 91 }, overallComment: '가'.repeat(5000) };
    await call('POST /api/exam-report/publish', { body: { resultId: 'res-1', report } });
    const chunks = notion.writes.find(x => x.op === 'patch').properties['학부모리포트'].rich_text;
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every(c => c.text.content.length <= 2000));
});

test('학부모 링크: 공개된 사본만 내준다', async () => {
    const snapshot = JSON.stringify({ v: 1, report: { student: { name: '조은서' }, summary: { score: 91 }, overallComment: '고친 코멘트' } });
    const published = setup({ result: resultPage({ '학부모리포트': prop.text(snapshot), '공개일시': prop.date('2026-10-02T05:00:00.000Z') }) });
    const ok = await published.call('GET /api/public/exam-report', { query: { id: 'res-1' } });
    // 테스트용 id 'res-1' 은 노션 ID 모양이 아니라 형식 검사에서 막힌다 → 실제 모양의 ID 로 다시 확인
    assert.equal(ok.code, 404);

    const realId = '0f6a2c1e-1111-4a2b-9c3d-1234567890ab';
    const withRealId = (props) => ({ ...resultPage(props), id: realId });
    const pub = setup({ result: withRealId({ '학부모리포트': prop.text(snapshot), '공개일시': prop.date('2026-10-02T05:00:00.000Z') }) });
    const res = await pub.call('GET /api/public/exam-report', { query: { id: realId } });
    assert.equal(res.code, 200);
    assert.equal(res.body.overallComment, '고친 코멘트');
    assert.equal(pub.g.prompts.length, 0); // 학부모가 열 때 AI 를 부르지 않는다

    // 공개 안 된 것 · 다른 DB 페이지는 404
    const notPub = setup({ result: withRealId({ '학부모리포트': prop.text(snapshot) }) });
    assert.equal((await notPub.call('GET /api/public/exam-report', { query: { id: realId } })).code, 404);
    const otherDb = { ...withRealId({ '학부모리포트': prop.text(snapshot), '공개일시': prop.date('2026-10-02') }), parent: { database_id: 'db-other' } };
    const other = setup({ result: otherDb });
    assert.equal((await other.call('GET /api/public/exam-report', { query: { id: realId } })).code, 404);
});

test('공개 취소: 사본과 공개일시를 비운다', async () => {
    const { call, notion } = setup();
    const res = await call('POST /api/exam-report/unpublish', { body: { resultId: 'res-1' } });
    assert.equal(res.body.success, true);
    const w = notion.writes.find(x => x.op === 'patch' && x.id === 'res-1');
    assert.deepEqual(w.properties['학부모리포트'], { rich_text: [] });
    assert.deepEqual(w.properties['공개일시'], { date: null });
});

const COVERAGE = { exams: [
    { school: '영덕중', grade: 2, year: 2026, semester: 2, sitting: '중간', mock_sets: 5,
      points: [{ code: 'VOICE_PARTICIPLE', label: '현재분사 vs 과거분사' }, { code: 'VOICE_ACTIVE_PASSIVE', label: '능동 vs 수동' }] },
    { school: '영일중', grade: 2, year: 2026, semester: 2, sitting: '중간', mock_sets: 5, points: [{ code: 'X', label: '영일 포인트' }] },
] };

test('리디테스트 대비 범위: 그 학교·시험의 동형 포인트가 코멘트·오답 요인 프롬프트에 들어간다', async () => {
    const { call, g } = setup({ coverage: COVERAGE, result: resultPage({ '시험종류': prop.select('중간고사') }) });
    const res = await call('GET /api/student-report-data', { query: { resultId: 'res-1' } });
    assert.equal(res.body.success, true);
    for (const p of g.prompts) {
        assert.match(p, /동형 모의고사 5세트를 만들어 학생이 모두 풀었다/);
        assert.match(p, /현재분사 vs 과거분사, 능동 vs 수동/);
        assert.doesNotMatch(p, /영일 포인트/);
    }
    assert.match(g.prompts.find(p => !p.includes('JSON 형식')), /완전히 숙지하지 못했다/);
});

test('리디테스트 대비 범위: 맞는 시험이 없으면(다른 회차·학교) 문구를 넣지 않는다', async () => {
    const { call, g } = setup({ coverage: COVERAGE, result: resultPage({ '시험종류': prop.select('기말고사') }) });
    await call('GET /api/student-report-data', { query: { resultId: 'res-1' } });
    assert.ok(g.prompts.length > 0);
    for (const p of g.prompts) assert.doesNotMatch(p, /학원 내신 대비/);
});
