/**
 * 교재비 관리 DB 생성 (docs/교재비관리-설계.md §2)
 *
 *   node scripts/create-textbook-fee-db.mjs          계획만 출력 (아무것도 안 만듦)
 *   node scripts/create-textbook-fee-db.mjs --go     실제 생성
 *
 * 무엇을 하나:
 *   1) '각종 데이터 베이스 모음' 페이지 아래에 DB 생성 (일반 속성 + relation 3개)
 *   2) relation 이 만들어진 뒤 PATCH 로 롤업 3개 추가
 *   3) 롤업이 생긴 뒤 PATCH 로 수식 2개 추가 (`청구 금액` 이 `합계 금액` 롤업을 참조하므로 순서 중요)
 *
 * ⚠️ relation 은 전부 single_property 로 만든다.
 *    dual_property 로 만들면 교재 마스터·학생 명부에 역방향 컬럼이 자동으로 생긴다.
 *    설계 문서 §1 이 "교재 마스터는 절대 구조를 바꾸지 말 것"이라고 못박은 부분이다.
 *
 *    🔴 이름이 헷갈리는데 single_property 는 "한 개만 연결된다"는 뜻이 **아니다.**
 *    상대 DB 에 역방향 컬럼을 안 만든다는 뜻일 뿐이고, 연결 개수는 무제한이다.
 *    `변경 교재` 에 교재 10권을 담아도 된다 — 그게 이 DB 를 만든 이유다.
 *
 * 이 스크립트는 새 DB 만 만든다. 기존 DB 는 읽지도 쓰지도 않는다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
    const candidates = [
        process.env.NOTION_ENV_FILE,
        path.join(ROOT, '.env'),
        path.join(os.homedir(), '.secrets', 'academy-planner.env'),
    ].filter(Boolean);
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        const env = {};
        for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
            if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
        console.log(`env 파일: ${p}`);
        return env;
    }
    console.error('환경변수 파일을 찾지 못했습니다:');
    candidates.forEach(c => console.error(`  - ${c}`));
    process.exit(1);
}

const env = loadEnv();
const TOKEN = env.NOTION_ACCESS_TOKEN;
const STUDENT = env.STUDENT_DATABASE_ID || '25409320-bce2-80f8-ace1-ddcdd022b360';
const TEXTBOOK = env.TEXTBOOK_DB_ID || '18f09320bce2800aac09c7856bf17e7d';
/** '각종 데이터 베이스 모음' — 다른 DB 가 전부 이 페이지 아래에 있다 */
const PARENT_PAGE = process.env.PARENT_PAGE_ID || '17809320-bce2-803c-9eb4-fe3ef856c63d';
const DB_TITLE = '교재비 관리';

if (!TOKEN) { console.error('NOTION_ACCESS_TOKEN 이 비어 있습니다.'); process.exit(1); }

async function notion(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    });
    const b = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${b.code || ''} ${b.message || ''}`);
    return b;
}

// ── 1단계: 생성 시점에 넣는 속성 (롤업 제외) ────────────────────
const baseProps = {
    '제목': { title: {} },
    '학생': { relation: { database_id: STUDENT, single_property: {} } },
    '변경 교재': { relation: { database_id: TEXTBOOK, single_property: {} } },
    '기존 교재': { relation: { database_id: TEXTBOOK, single_property: {} } },
    '조정 금액': { number: { format: 'won' } },
    '진행상태': {
        select: {
            options: [
                { name: '작성중', color: 'default' },
                { name: '승인대기', color: 'yellow' },
                { name: '승인됨', color: 'green' },
                { name: '반려', color: 'red' },
                { name: '보류', color: 'orange' },   // §6-2 가격 미입력 교재로 발송 못 한 건
                { name: '발송중', color: 'blue' },
                { name: '발송완료', color: 'purple' },
            ],
        },
    },
    '요청 메모': { rich_text: {} },
    '반려 사유': { rich_text: {} },
    '발송 예약': { checkbox: {} },
    '발송 일시': { date: {} },
    '구매 상태': {
        select: {
            options: [
                { name: '미구매', color: 'default' },
                { name: '일부구매', color: 'yellow' },
                { name: '구매완료', color: 'green' },
            ],
        },
    },
    '미확보 교재': { rich_text: {} },
    '입금 확인': { checkbox: {} },
    '입금 확인일': { date: {} },
    '원장알림함': { checkbox: {} },   // 서버 전용 — 뷰에서 숨길 것
    '교사알림함': { checkbox: {} },   // 서버 전용 — 뷰에서 숨길 것
};

// ── 2단계: relation 이 생긴 뒤에 붙이는 롤업 ────────────────────
const rollupProps = {
    // 학생 이름 롤업은 두지 않는다 — `학생` relation 칩이 이미 이름을 보여준다. §2-1 참조
    '학부모 연락처': { rollup: { relation_property_name: '학생', rollup_property_name: '전화번호', function: 'show_original' } },
    '담당쌤': { rollup: { relation_property_name: '학생', rollup_property_name: '담당쌤', function: 'show_original' } },
    // 🔴 '안내가'(권당 할인가)가 아니라 '가격'(정가)을 합산한다. 할인은 청구 금액 수식에서 한 번만. §3-2
    '합계 금액': { rollup: { relation_property_name: '변경 교재', rollup_property_name: '가격', function: 'sum' } },
};

// ── 3단계: 롤업이 생긴 뒤에 붙이는 수식 ─────────────────────────
const formulaProps = {
    // 🔴 `join(map(prop("변경 교재"), current.name), ", ")` 는 API 가 거부한다(Type error).
    //    API 수식 파서는 `current` 를 모른다. `format(관계)` 이 같은 일을 하고, 노션이 내부적으로
    //    join(map(...)) 으로 펼쳐 준다. 구분자도 ", " 라 §5(줄바꿈 금지)에 맞는다.
    //    실측 출력: "60-Word Reading 2, 60-Word Reading 1, 50-Word Reading 2"
    '교재 목록': { formula: { expression: 'format(prop("변경 교재"))' } },
    // 할인은 합계에 한 번만. `안내가`(권당 할인) 합산이 아니다. §3-2
    '청구 금액': { formula: { expression: 'floor((prop("합계 금액") + if(empty(prop("조정 금액")), 0, prop("조정 금액"))) * 0.9)' } },
};

const GO = process.argv.includes('--go');

(async () => {
    console.log(`\n부모 페이지: ${PARENT_PAGE}`);
    console.log(`DB 이름    : ${DB_TITLE}`);
    console.log(`학생 명부  : ${STUDENT}`);
    console.log(`교재 마스터: ${TEXTBOOK}  (single_property — 역방향 컬럼 안 생김)`);
    console.log(`\n1단계 생성 속성 ${Object.keys(baseProps).length}개: ${Object.keys(baseProps).join(', ')}`);
    console.log(`2단계 롤업 ${Object.keys(rollupProps).length}개: ${Object.keys(rollupProps).join(', ')}`);
    console.log(`3단계 수식 ${Object.keys(formulaProps).length}개: ${Object.keys(formulaProps).join(', ')}`);

    if (!GO) {
        console.log('\n--- 계획만 출력했습니다. 실제로 만들려면 --go 를 붙이세요 ---');
        return;
    }

    console.log('\n[1/3] DB 생성 중…');
    const db = await notion('https://api.notion.com/v1/databases', {
        method: 'POST',
        body: JSON.stringify({
            parent: { type: 'page_id', page_id: PARENT_PAGE },
            title: [{ type: 'text', text: { content: DB_TITLE } }],
            description: [{ type: 'text', text: { content: '한 행에 교재를 몇 권이든 담으세요. \'변경 교재\'에 4권을 넣으면 4권이 한 통의 문자로 안내됩니다. 행을 나누지 마세요 — 1행 = 학생 1명의 교재 변경 1회입니다. 설계: docs/교재비관리-설계.md' } }],
            properties: baseProps,
        }),
    });
    console.log(`      완료 — id=${db.id}`);
    console.log(`      url=${db.url}`);

    console.log('[2/3] 롤업 3개 추가 중…');
    const patched = await notion(`https://api.notion.com/v1/databases/${db.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: rollupProps }),
    });
    for (const name of Object.keys(rollupProps)) {
        const p = patched.properties[name];
        console.log(`      ${p ? '✅' : '❌'} ${name}${p ? ` (${p.rollup.function})` : ''}`);
    }

    console.log('[3/3] 수식 2개 추가 중…');
    const withFormulas = await notion(`https://api.notion.com/v1/databases/${db.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: formulaProps }),
    });
    for (const name of Object.keys(formulaProps)) {
        console.log(`      ${withFormulas.properties[name] ? '✅' : '❌'} ${name}`);
    }
    console.log(`      총 속성 ${Object.keys(withFormulas.properties).length}개`);

    console.log('\n남은 일 — 노션 UI 에서만 되는 것\n');
    console.log('  ① `학생` relation 의 "페이지 1개로 제한" 켜기 (API 로는 못 켬)');
    console.log('  ② `원장알림함`·`교사알림함` 을 모든 뷰에서 숨기기');
    console.log('\n  ③ .env 와 Render 환경변수에 추가:');
    console.log(`       TEXTBOOK_FEE_DB_ID=${db.id}`);
})().catch(e => { console.error('\n실패:', e.message); process.exit(1); });
