/**
 * 교재비 DB 에 미입금 안내용 속성을 붙인다.
 *   미입금 안내일시 (date) — 미입금 안내를 보낸 시각. 있으면 다시 안 보낸다.
 *
 * 체크박스가 아니라 타임스탬프인 이유: 체크는 사람이 껐다 켤 수 있고,
 * 그러면 독촉이 두 번 나간다. 발송 판정은 언제나 타임스탬프로 한다.
 *
 * 몇 번을 돌려도 안전하다. 이미 있으면 건너뛴다.
 * 실행: node scripts/add-unpaid-property.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!process.env.NOTION_ACCESS_TOKEN) { console.error('NOTION_ACCESS_TOKEN 이 없습니다'); process.exit(1); }

const DB = process.env.TEXTBOOK_FEE_DB_ID;
if (!DB) { console.error('TEXTBOOK_FEE_DB_ID 가 없습니다'); process.exit(1); }

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

const 추가 = { '미입금 안내일시': { date: {} } };

const db = await api(`https://api.notion.com/v1/databases/${DB}`);
const 있음 = Object.keys(db.properties || {});
const 넣을것 = Object.fromEntries(Object.entries(추가).filter(([k]) => !있음.includes(k)));

if (!Object.keys(넣을것).length) {
    console.log('이미 다 있습니다 — 아무것도 바꾸지 않았습니다');
} else {
    await api(`https://api.notion.com/v1/databases/${DB}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: 넣을것 }),
    });
    console.log(`추가함: ${Object.keys(넣을것).join(', ')}`);
}

// 발송 판정이 걸려 있는 속성들이 그대로 있는지 같이 확인한다. 이름이 바뀌면 조용히 안 나간다.
const 지금 = Object.keys((await api(`https://api.notion.com/v1/databases/${DB}`)).properties);
for (const p of ['미입금 안내일시', '발송 일시', '입금 확인', '진행상태', '교사알림함']) {
    if (!지금.includes(p)) console.warn(`🔴 '${p}' 속성이 없습니다 — 미입금/교사 알림이 돌지 않습니다`);
}
console.log('확인 완료');
