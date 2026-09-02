import test from 'node:test';
import assert from 'node:assert/strict';

import { initializeSchemaCheck } from '../api/schemaCheckModule.js';
import { REQUIRED_PROPERTIES } from '../api/notionSchema.js';
import { fakeApp, fakeCron, fakeNotion, fakeNotify, fakeRes } from './fakes.mjs';

const NBSP = ' ';

/** 선언된 속성을 그대로 가진 '건강한' 노션을 만든 뒤, 케이스마다 망가뜨린다. */
function setup(breakIt = () => {}) {
    const databases = {};
    const dbIds = {};
    for (const [key, spec] of Object.entries(REQUIRED_PROPERTIES)) {
        dbIds[key] = 'id-' + key;
        databases['id-' + key] = {
            properties: Object.fromEntries(spec.props.map(p => [p, { type: 'rich_text' }])),
        };
    }
    breakIt(databases, dbIds);

    const app = fakeApp();
    const cron = fakeCron();
    const notifyOwner = fakeNotify();
    const { fetchNotion } = fakeNotion(databases);

    initializeSchemaCheck({
        app, cron, fetchNotion, dbIds,
        requireAuth: (req, res, next) => next(),
        notifyOwner,
    });
    return { app, cron, notifyOwner };
}

test('크론은 07:30 KST 에 등록된다', () => {
    const { cron } = setup();
    assert.equal(cron.jobs.length, 1);
    assert.equal(cron.jobs[0].expression, '30 7 * * *');
    assert.equal(cron.jobs[0].options.timezone, 'Asia/Seoul');
});

test('이상이 없으면 아무 말도 하지 않는다', async () => {
    const { cron, notifyOwner } = setup();
    await cron.jobs[0].run();
    assert.equal(notifyOwner.sent.length, 0, '정상인데 알림이 나갔다 — 매일 오면 아무도 안 본다');
});

test('속성이 사라지면 어느 DB 의 무엇인지 알린다', async () => {
    const { cron, notifyOwner } = setup((dbs) => {
        delete dbs['id-PROGRESS_DATABASE_ID'].properties['🕐 날짜'];
    });
    await cron.jobs[0].run();

    assert.equal(notifyOwner.sent.length, 1);
    const { body } = notifyOwner.sent[0];
    assert.match(body, /진도 관리/);
    assert.match(body, /🕐 날짜/);
});

test('눈에 안 보이는 개명(NBSP)은 사라짐이 아니라 개명으로 보고한다', async () => {
    const { cron, notifyOwner } = setup((dbs) => {
        const props = dbs['id-MONTHLY_REPORT_DB_ID'].properties;
        delete props['리포트 월'];
        props['리포트' + NBSP + '월'] = { type: 'rich_text' };
    });
    await cron.jobs[0].run();

    const { body } = notifyOwner.sent[0];
    assert.match(body, /바뀐 것 같다/, 'NBSP 차이를 개명으로 못 봤다');
    assert.doesNotMatch(body, /가 없다/, '개명인데 "사라졌다"로 보고했다');
});

test('DB 를 못 읽으면(통합 권한 빠짐) 그것도 알린다', async () => {
    const { cron, notifyOwner } = setup((dbs) => {
        dbs['id-GRAMMAR_DB_ID'] = new Error('404 object_not_found');
    });
    await cron.jobs[0].run();
    assert.match(notifyOwner.sent[0].body, /읽을 수 없다/);
});

test('env 가 없는 DB 는 조용히 건너뛴다 (그 기능이 꺼져 있다는 뜻)', async () => {
    const { cron, notifyOwner } = setup((dbs, dbIds) => {
        delete dbIds.EXAM_DB_ID;
    });
    await cron.jobs[0].run();
    assert.equal(notifyOwner.sent.length, 0);
});

test('수동 트리거는 어긋난 목록을 그대로 돌려준다', async () => {
    const { app } = setup((dbs) => {
        delete dbs['id-ABSENCE_DB_ID'].properties['담임'];
    });
    const res = fakeRes();
    await app.routes['POST /api/schema-check/tick']({ query: {} }, res);

    assert.equal(res.body.success, true);
    assert.equal(res.body.drift.length, 1);
    assert.deepEqual(res.body.drift[0].missing, ['담임']);
});
