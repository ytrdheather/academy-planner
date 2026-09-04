import { REQUIRED_PROPERTIES } from './notionSchema.js';

/**
 * 노션 스키마 드리프트 점검.
 *
 * 노션에서 속성 이름을 바꾸거나 지우면, 그 속성을 필터·정렬·쓰기에 쓰던 기능이
 * 통째로 죽는다(노션이 요청을 400 으로 거절한다). 그런데 화면엔 아무 말도 안 나온다.
 * 과거 사고는 전부 며칠 뒤 사람이 눈으로 발견했다 → wiki/pitfalls/teacher-rollup-name.md
 *
 * 이 모듈은 매일 각 DB 의 속성 목록을 읽어 api/notionSchema.js 선언과 대조하고,
 * 사라진 게 있으면 원장 DM 으로 올린다. **이상이 없으면 아무 말도 하지 않는다.**
 */

let fetchNotion;
let dbIds;
let notifyOwner;

/**
 * 속성 이름을 비교용으로 정규화한다.
 * NBSP 와 앞뒤·중복 공백 차이는 눈으로 구분이 안 되는데 노션은 다른 이름으로 친다
 * → wiki/pitfalls/textbook-name-whitespace.md
 */
function normalize(name) {
    // JS 의 \s 는 NBSP 와 얇은 공백까지 포함한다 — 눈에 안 보이는 차이가 여기서 접힌다
    return String(name).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 사라진 이름과 '거의 같은' 이름이 노션에 있으면 개명으로 본다. 진단이 훨씬 빨라진다. */
function findRenameCandidate(missing, actualNames) {
    const target = normalize(missing);
    return actualNames.find(a => a !== missing && normalize(a) === target) || null;
}

/**
 * DB 하나를 점검한다.
 * 반환: { db, label, status, missing[], renamed[{from,to}], error }
 *   status — 'ok' | 'drift' | 'unreachable' | 'unconfigured'
 */
async function checkDatabase(dbKey, spec) {
    const id = dbIds[dbKey];
    if (!id) return { db: dbKey, label: spec.label, status: 'unconfigured' };

    let data;
    try {
        data = await fetchNotion(`https://api.notion.com/v1/databases/${id}`);
    } catch (e) {
        // 404 는 보통 "통합이 이 DB 에서 제외됐다"는 뜻이다. 이것도 조용한 킬러다.
        return { db: dbKey, label: spec.label, status: 'unreachable', error: e.message };
    }

    const actualNames = Object.keys(data?.properties || {});
    if (!actualNames.length) {
        return { db: dbKey, label: spec.label, status: 'unreachable', error: '속성 목록이 비어 있다' };
    }

    const missing = [];
    const renamed = [];
    for (const prop of spec.props) {
        if (actualNames.includes(prop)) continue;
        const candidate = findRenameCandidate(prop, actualNames);
        if (candidate) renamed.push({ from: prop, to: candidate });
        else missing.push(prop);
    }

    const status = (missing.length || renamed.length) ? 'drift' : 'ok';
    return { db: dbKey, label: spec.label, status, missing, renamed };
}

/** 전체 점검. 결과 배열을 돌려준다. */
async function runSchemaCheck() {
    const results = [];
    for (const [dbKey, spec] of Object.entries(REQUIRED_PROPERTIES)) {
        results.push(await checkDatabase(dbKey, spec));
    }
    return results;
}

/** 사람이 읽을 보고서. 이상 없으면 null — 조용한 게 기본이다. */
function buildReport(results) {
    const bad = results.filter(r => r.status === 'drift' || r.status === 'unreachable');
    if (!bad.length) return null;

    const lines = [];
    for (const r of bad) {
        if (r.status === 'unreachable') {
            lines.push(`· ${r.label}: 읽을 수 없다 (${r.error}) — 통합 권한이 빠졌을 수 있다`);
            continue;
        }
        for (const { from, to } of r.renamed) {
            lines.push(`· ${r.label}: '${from}' → '${to}' 로 바뀐 것 같다 (공백·특수문자 차이)`);
        }
        if (r.missing.length) {
            lines.push(`· ${r.label}: ${r.missing.map(m => `'${m}'`).join(', ')} 가 없다`);
        }
    }

    lines.push('');
    // 🔴 문구 순서가 중요하다. 2026-09-03 첫 알림 때 "노션이 바뀌었나" 로 읽혀 원장이 놀랐는데
    // 실제 원인은 선언 오류였다. 오탐이 훨씬 흔하니 그쪽을 먼저 의심하게 쓴다.
    lines.push('먼저 의심할 것: api/notionSchema.js 의 선언이 틀렸을 수 있다(속성을 엉뚱한 DB 에 적어둔 경우).');
    lines.push('노션에서 이름을 바꾼 기억이 없다면 노션은 건드리지 말고 선언을 고쳐라.');
    lines.push('정말 노션에서 이름이 바뀐 것이라면, 그 속성을 쓰는 기능이 통째로 멈춘 상태다(노션이 400 을 준다).');
    return lines.join('\n');
}

export function initializeSchemaCheck(dependencies) {
    const app = dependencies.app;
    const cron = dependencies.cron;
    const requireAuth = dependencies.requireAuth || ((req, res, next) => next());
    fetchNotion = dependencies.fetchNotion;
    dbIds = dependencies.dbIds || {};
    notifyOwner = dependencies.notifyOwner || null;

    /** 수동 점검. 결과를 그대로 돌려주므로 노션을 안 건드리고도 지금 상태를 볼 수 있다. */
    app.post('/api/schema-check/tick', requireAuth, async (req, res) => {
        try {
            const results = await runSchemaCheck();
            res.json({
                success: true,
                drift: results.filter(r => r.status === 'drift' || r.status === 'unreachable'),
                ok: results.filter(r => r.status === 'ok').map(r => r.label),
                unconfigured: results.filter(r => r.status === 'unconfigured').map(r => r.db),
            });
        } catch (e) {
            console.error('🚨 스키마 점검 실패:', e);
            res.status(500).json({ message: e.message });
        }
    });

    // 매일 07:30(KST). 08:00 보강 명단보다 앞이라 그날 업무가 시작되기 전에 눈에 띈다.
    cron.schedule('30 7 * * *', async () => {
        try {
            const results = await runSchemaCheck();
            const report = buildReport(results);

            if (!report) {
                console.log(`--- ✅ 노션 스키마 점검 이상 없음 (${results.filter(r => r.status === 'ok').length}개 DB) ---`);
                return;
            }

            console.error('🚨 노션 스키마 드리프트:\n' + report);
            if (notifyOwner) await notifyOwner('🚨 노션 속성이 바뀌었다', report);
        } catch (e) {
            console.error('🚨 스키마 점검 크론 에러:', e);
        }
    }, { timezone: 'Asia/Seoul' });
}
