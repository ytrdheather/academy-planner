/**
 * 카카오워크 채널 ID 와 구성원 ID 를 찾는다.
 *
 * 🔴 봇은 채널을 **만들 수는 있는데 이름을 못 붙인다**(2026-09-04 실측 → wiki/entities/kakaowork-platform-limits.md).
 *    `conversations.open` 에 `user_ids` 를 주면 group/public 방이 생기지만 `name` 은 무시된다.
 *    그래서 봇이 만들고 사람이 앱에서 이름을 바꾼다. 이 스크립트는 그 방의 ID 를 읽어 준다.
 *    이름을 바꾸기 전에는 목록에 `(이름없음)` 으로 나오니 ID 로 알아봐야 한다.
 *
 * 실행:
 *   node scripts/kakaowork-ids.mjs              전체(봇이 들어가 있는 방 + 구성원)
 *   node scripts/kakaowork-ids.mjs 미수금        이름에 '미수금' 이 든 것만
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const KEY = process.env.KAKAOWORK_APP_KEY;
if (!KEY) { console.error('KAKAOWORK_APP_KEY 가 없습니다'); process.exit(1); }

const 검색어 = (process.argv[2] || '').trim();
const 맞나 = s => !검색어 || String(s || '').includes(검색어);

// GET 은 된다. POST 로는 conversations.list 가 api_not_found 다 — 헷갈리지 말 것.
const get = async (p) => {
    const r = await fetch(`https://api.kakaowork.com/v1/${p}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const b = await r.json();
    if (!b?.success) throw new Error(`${p} 실패: ${JSON.stringify(b).slice(0, 200)}`);
    return b;
};

const 페이지전체 = async (p, 키) => {
    const out = [];
    let cursor = '';
    do {
        const b = await get(`${p}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        out.push(...(b[키] || []));
        cursor = b.cursor || '';
    } while (cursor);
    return out;
};

console.log('\n=== 봇이 들어가 있는 방 (KAKAOWORK_*_CONV 에 넣을 값) ===');
const convs = await 페이지전체('conversations.list', 'conversations');
const 방 = convs.filter(c => 맞나(c.name));
if (!방.length) {
    console.log('없습니다.');
    console.log('→ 카카오워크 앱에서 채널을 만들고 Readitude_Bot 을 초대한 뒤 다시 돌려 주세요.');
}
for (const c of 방) console.log(`${String(c.id).padEnd(20)} ${c.type}/${c.channel_type || '-'}  ${c.name || '(이름없음)'}`);

console.log('\n=== 구성원 (KAKAOWORK_UNPAID_DM_USER 에 넣을 값) ===');
const users = await 페이지전체('users.list', 'users');
const 사람 = users.filter(u => 맞나(u.name) || 맞나(u.nickname) || 맞나(u.identifications?.[0]?.value));
for (const u of 사람) {
    console.log(`${String(u.id).padEnd(20)} ${(u.name || u.nickname || '').padEnd(16)} ${u.identifications?.[0]?.value || ''}`);
}
console.log(`\n총 방 ${방.length} / 구성원 ${사람.length}`);
