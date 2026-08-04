/**
 * 노션 읽기 전용 점검 도구 (교재비 관리 설계용)
 *
 *   node scripts/notion-inspect.mjs           전체
 *   node scripts/notion-inspect.mjs schema    DB 속성 목록만
 *   node scripts/notion-inspect.mjs price     교재 가격 체계 + 누락 현황
 *   node scripts/notion-inspect.mjs workflow  현행 교재변경 워크플로 상태
 *
 * ⚠️ GET 과 /query(조회)만 호출한다. 쓰기·수정·삭제 없음. 마음 놓고 돌려도 된다.
 *
 * 환경변수 파일 찾는 순서:
 *   1) NOTION_ENV_FILE 환경변수가 가리키는 경로
 *   2) C:\Users\<사용자>\.secrets\academy-planner.env      ← 집·학원 공통 권장 위치
 *   3) 프로젝트 루트의 .env
 *
 * 🔴 .env 를 이 프로젝트 폴더 안에 두지 말 것.
 *    바탕화면이 구글 드라이브로 동기화되고 있어서 토큰이 통째로 클라우드에 올라간다.
 *    (.gitignore 는 git 에만 적용되고 드라이브 동기화는 막지 못한다.)
 *    자세한 내용은 docs/교재비관리-설계.md §11 참조.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 환경변수 로드 ────────────────────────────────────────────────
function loadEnv() {
    const candidates = [
        process.env.NOTION_ENV_FILE,
        path.join(os.homedir(), '.secrets', 'academy-planner.env'),
        path.join(process.cwd(), '.env'),
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
    console.error('환경변수 파일을 찾지 못했습니다. 아래 중 하나를 만드세요:');
    candidates.forEach(c => console.error(`  - ${c}`));
    process.exit(1);
}

const env = loadEnv();
const TOKEN = env.NOTION_ACCESS_TOKEN;
const TEXTBOOK = env.TEXTBOOK_DB_ID || '18f09320bce2800aac09c7856bf17e7d';
const STUDENT = env.STUDENT_DATABASE_ID || '25409320-bce2-80f8-ace1-ddcdd022b360';
if (!TOKEN) { console.error('NOTION_ACCESS_TOKEN 이 비어 있습니다.'); process.exit(1); }

// ── 노션 호출 ────────────────────────────────────────────────────
async function notion(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    });
    const b = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${b.code || ''} ${b.message || ''}`);
    return b;
}

async function queryAll(id, body = {}) {
    const out = []; let cursor, more = true;
    while (more) {
        const d = await notion(`https://api.notion.com/v1/databases/${id}/query`, {
            method: 'POST',
            body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
        });
        out.push(...d.results); more = d.has_more; cursor = d.next_cursor;
    }
    return out;
}

const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

/** 어떤 속성 타입이든 사람이 읽을 수 있는 값으로 바꾼다 */
function val(p) {
    if (!p) return '';
    switch (p.type) {
        case 'title': case 'rich_text': return plain(p);
        case 'number': return p.number ?? '(빈값)';
        case 'select': return p.select?.name ?? '';
        case 'multi_select': return (p.multi_select || []).map(o => o.name).join(', ');
        case 'checkbox': return p.checkbox ? 'V' : '';
        case 'phone_number': return p.phone_number ?? '';
        case 'date': return p.date?.start ?? '';
        case 'formula': return p.formula.string ?? p.formula.number ?? p.formula.boolean ?? '(빈값)';
        case 'rollup':
            if (p.rollup.type === 'number') return p.rollup.number ?? '(빈값)';
            return (p.rollup.array || []).map(x => val(x)).filter(Boolean).join(' + ');
        case 'relation': return `${p.relation.length}건`;
        default: return `(${p.type})`;
    }
}

// ── 1. 스키마 덤프 ───────────────────────────────────────────────
async function schema(id, label) {
    const db = await notion(`https://api.notion.com/v1/databases/${id}`);
    const title = (db.title || []).map(t => t.plain_text).join('') || '(제목없음)';
    console.log(`\n=== ${label}: "${title}" (속성 ${Object.keys(db.properties).length}개) ===`);
    console.table(Object.entries(db.properties).map(([name, p]) => {
        let detail = '';
        if (p.type === 'select' || p.type === 'multi_select') detail = (p[p.type].options || []).map(o => o.name).join(' | ');
        else if (p.type === 'rollup') detail = `${p.rollup.relation_property_name} → ${p.rollup.rollup_property_name} (${p.rollup.function})`;
        else if (p.type === 'formula') detail = (p.formula.expression || '').slice(0, 60);
        else if (p.type === 'relation') detail = `→ ${p.relation.database_id}`;
        return { 속성: name, 타입: p.type, 비고: detail.slice(0, 70) };
    }));
    return db.properties;
}

// ── 2. 교재 가격 체계 ────────────────────────────────────────────
async function price() {
    const books = await queryAll(TEXTBOOK);
    console.log(`\n=== 교재 마스터: 총 ${books.length}권 ===`);

    console.log('\n[가격 vs 안내가] — 안내가 = floor(가격 × 0.9). 할인은 "합계에 한 번" 적용해야 함');
    console.table(books.filter(b => b.properties['가격']?.number != null).slice(0, 8).map(b => ({
        교재이름: val(b.properties['교재이름']).slice(0, 32),
        과목: val(b.properties['과목']),
        가격: val(b.properties['가격']),
        안내가: val(b.properties['안내가']),
    })));

    const noPrice = books.filter(b => b.properties['가격']?.number == null);
    console.log(`\n[가격 누락] ${noPrice.length}/${books.length}권 — 롤업이 0원으로 무시하므로 발송 전 검증 필수`);
    const bySubj = {}, total = {};
    for (const b of books) {
        const s = val(b.properties['과목']) || '(과목없음)';
        total[s] = (total[s] || 0) + 1;
        if (b.properties['가격']?.number == null) bySubj[s] = (bySubj[s] || 0) + 1;
    }
    console.table(Object.keys(total).sort().map(s => ({
        과목: s, 전체: total[s], 가격없음: bySubj[s] || 0,
        비율: `${Math.round(((bySubj[s] || 0) / total[s]) * 100)}%`,
    })));

    const 문법서 = noPrice.filter(b => val(b.properties['과목']) === '문법서');
    console.log(`\n[가격 채워야 할 문법서 ${문법서.length}권]`);
    console.log(문법서.map(b => val(b.properties['교재이름'])).filter(Boolean).join(' / '));

    const 빈행 = books.filter(b => !val(b.properties['교재이름']));
    console.log(`\n[이름도 비어 있는 쓰레기 행] ${빈행.length}개 — 삭제 대상`);
}

// ── 3. 현행 교재변경 워크플로 상태 ───────────────────────────────
async function workflow() {
    const students = await queryAll(STUDENT, { filter: { property: '재원상태', select: { equals: '재원' } } });
    console.log(`\n=== 재원생 ${students.length}명 ===`);

    console.log('\n[승인상태 분포]');
    const dist = {};
    for (const s of students) { const v = val(s.properties['승인상태']) || '(비어있음)'; dist[v] = (dist[v] || 0) + 1; }
    console.table(Object.entries(dist).map(([k, v]) => ({ 승인상태: k, 인원: v })));

    console.log('\n[연락처 채워짐 확인] — 전화번호(학부모)가 핵심');
    for (const k of ['전화번호', '학생 전화번호']) {
        const empty = students.filter(s => !s.properties[k]?.phone_number);
        console.log(`  · ${k}: 빈값 ${empty.length}/${students.length}명`);
    }

    const keys = ['승인상태', '교재1 이름', '교재1 가격', '교재2 이름', '교재2 가격',
        '알림톡용_교재명', '알림톡용_합계금액', '교재원장알림발송', '교재안내 발송체크', '교재코멘트'];
    const active = students.filter(s => val(s.properties['새교재1']) !== '0건' || val(s.properties['승인상태']));

    console.log(`\n[교재 변경건이 걸려 있는 학생: ${active.length}명]`);
    console.table(active.slice(0, 20).map(s => {
        const r = { 이름: val(s.properties['이름']) };
        for (const k of keys) r[k] = String(val(s.properties[k])).slice(0, 22);
        return r;
    }));
}

// ── 실행 ─────────────────────────────────────────────────────────
const mode = process.argv[2] || 'all';
(async () => {
    if (mode === 'all' || mode === 'schema') {
        await schema(TEXTBOOK, '교재 마스터');
        await schema(STUDENT, '학생 명부');
    }
    if (mode === 'all' || mode === 'price') await price();
    if (mode === 'all' || mode === 'workflow') await workflow();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
