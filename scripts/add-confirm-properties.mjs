/**
 * 확정 안내 알림톡에 필요한 속성을 붙인다.
 *   결석·보강 신청 → 보강 확정일 / 보강 시간 / 확정발송 / 확정발송일시
 *   재원생 상담 신청 → 통화 예정일 / 통화 시간 / 확정발송 / 확정발송일시
 *
 * 몇 번을 돌려도 안전하다. 이미 있는 속성은 건너뛰고, 지울 속성은 값이 없을 때만 지운다.
 * 실행: node scripts/add-confirm-properties.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!process.env.NOTION_ACCESS_TOKEN) { console.error('NOTION_ACCESS_TOKEN 이 없습니다'); process.exit(1); }

const H = {
    Authorization: `Bearer ${process.env.NOTION_ACCESS_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
};
const api = async (url, opt = {}) => {
    const r = await fetch(url, { ...opt, headers: H });
    const b = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${b.code}: ${b.message}`);
    return b;
};

const 작업 = [
    {
        db: process.env.ABSENCE_DB_ID || '3b009320-bce2-8182-b306-ee8f3f1e8c2e',
        추가: {
            '보강 확정일': { date: {} },       // 담임이 정한 실제 보강 날짜
            '보강 시간': { rich_text: {} },    // "오전 10시" 처럼. 매번 달라서 하드코딩할 수 없다
            '확정발송': { checkbox: {} },      // 사람이 누르는 발송 스위치
            '확정발송일시': { date: {} },       // 서버 기록. 있으면 다시 안 보낸다
        },
        // 전날 리마인더를 폐기하면서 같이 지운다(2026-08-10). 쓰인 적이 없어 지울 값이 없다.
        삭제: ['리마인드발송일시'],
    },
    {
        db: process.env.COUNSEL_DB_ID || '3b109320-bce2-8197-a62b-e232bd5d74b7',
        추가: {
            '통화 예정일': { date: {} },       // 담임이 학부모와 맞춘 통화 날짜
            '통화 시간': { rich_text: {} },    // "밤 9시 30분" 처럼
            '확정발송': { checkbox: {} },
            '확정발송일시': { date: {} },
        },
        삭제: [],
    },
];

for (const { db, 추가, 삭제 } of 작업) {
    const info = await api(`https://api.notion.com/v1/databases/${db}`);
    console.log(`\n=== ${info.title?.map(t => t.plain_text).join('')} ===`);

    const 있는것 = new Set(Object.keys(info.properties));
    const 바꿀것 = {};
    for (const [name, spec] of Object.entries(추가)) {
        if (있는것.has(name)) { console.log(`  = ${name} — 이미 있음`); continue; }
        바꿀것[name] = spec;
    }
    // 속성 삭제는 되돌릴 수 없다. 값이 하나도 없을 때만 지운다.
    for (const name of 삭제) {
        if (!있는것.has(name)) continue;
        const 쓴행 = await api(`https://api.notion.com/v1/databases/${db}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: { property: name, date: { is_not_empty: true } }, page_size: 1 }),
        });
        if (쓴행.results.length) { console.log(`  ! ${name} — 값이 들어 있어 지우지 않습니다`); continue; }
        바꿀것[name] = null;   // 노션은 null 을 주면 속성을 지운다
    }

    if (!Object.keys(바꿀것).length) { console.log('  바꿀 것 없음'); continue; }
    await api(`https://api.notion.com/v1/databases/${db}`, { method: 'PATCH', body: JSON.stringify({ properties: 바꿀것 }) });
    for (const [name, spec] of Object.entries(바꿀것)) console.log(`  ${spec === null ? '-' : '+'} ${name} ${spec === null ? '삭제됨' : '추가됨'}`);

    // PATCH 가 200 이어도 되읽어 확인한다.
    const after = await api(`https://api.notion.com/v1/databases/${db}`);
    const 빠진것 = Object.keys(추가).filter(n => !after.properties[n]);
    console.log(빠진것.length ? `  🔴 안 붙은 속성: ${빠진것.join(', ')}` : `  ✅ ${Object.keys(추가).length}개 확인됨`);
}
