/**
 * 결석·보강 신청 DB 에 보강 확정 알림톡용 속성을 붙인다.
 *
 * 이미 있는 속성은 건드리지 않는다(같은 이름이면 그냥 넘어간다).
 * 실행: node scripts/add-makeup-properties.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const DB = process.env.ABSENCE_DB_ID || '3b009320-bce2-8182-b306-ee8f3f1e8c2e';
const TOKEN = process.env.NOTION_ACCESS_TOKEN;
if (!TOKEN) { console.error('NOTION_ACCESS_TOKEN 이 없습니다'); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
const api = async (url, opt = {}) => {
    const r = await fetch(url, { ...opt, headers: H });
    const b = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${b.code}: ${b.message}`);
    return b;
};

// 담임이 채우는 칸과 서버가 채우는 칸을 나눠 둔다.
const 새속성 = {
    '보강 확정일': { date: {} },              // 담임이 정한 실제 보강 날짜. 전날 리마인더가 이 값을 본다
    '보강 시간': { rich_text: {} },           // "오전 10시" 처럼. 매번 달라서 하드코딩할 수 없다
    '확정발송': { checkbox: {} },             // 담임이 누르는 발송 스위치
    '확정발송일시': { date: {} },              // 서버 기록. 있으면 다시 안 보낸다
    '리마인드발송일시': { date: {} },           // 서버 기록. 있으면 다시 안 보낸다
};

const db = await api(`https://api.notion.com/v1/databases/${DB}`);
console.log(`DB: ${db.title?.map(t => t.plain_text).join('')}\n`);

const 있는것 = new Set(Object.keys(db.properties));
const 넣을것 = {};
for (const [name, spec] of Object.entries(새속성)) {
    if (있는것.has(name)) { console.log(`  = ${name} — 이미 있음, 건너뜀`); continue; }
    넣을것[name] = spec;
}

if (!Object.keys(넣을것).length) { console.log('\n추가할 속성이 없습니다.'); process.exit(0); }

await api(`https://api.notion.com/v1/databases/${DB}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: 넣을것 }),
});
for (const name of Object.keys(넣을것)) console.log(`  + ${name} 추가됨`);

// 진짜 붙었는지 되읽어 확인한다. PATCH 가 200 이어도 확인하는 편이 낫다.
const after = await api(`https://api.notion.com/v1/databases/${DB}`);
const 빠진것 = Object.keys(새속성).filter(n => !after.properties[n]);
console.log(빠진것.length ? `\n🔴 안 붙은 속성: ${빠진것.join(', ')}` : '\n✅ 다섯 속성 모두 확인됨');
