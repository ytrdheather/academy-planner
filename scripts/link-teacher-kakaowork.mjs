/**
 * 선생님 명부의 '카카오워크 ID' 칸을 채운다. (교재비 승인 알림용)
 *
 *   node scripts/link-teacher-kakaowork.mjs
 *       → 현재 상태만 출력 (아무것도 안 바꿈). 이메일로 짝이 맞는 것도 같이 보여준다
 *
 *   node scripts/link-teacher-kakaowork.mjs --sync
 *       → 이메일이 일치하는 선생의 '카카오워크 ID' 를 자동으로 채운다
 *
 *   node scripts/link-teacher-kakaowork.mjs --set "레일라쌤=12034567"
 *       → 이메일이 다르거나 없을 때 수동 지정
 *
 * 🔴 매칭은 이메일로만 한다.
 *   카카오워크 계정 이름은 실명(김연수)인데 선생님 명부는 "레일라쌤" 형식이라
 *   이름으로 짝지으면 엉뚱한 선생에게 학생 정보가 갈 수 있다. 이름 매칭은 절대 하지 않는다.
 *
 * 선행 조건:
 *   1) 선생님 명부의 '이메일' 칸에 학원 이메일을 채운다
 *   2) 원장이 카카오워크 관리자에서 그 이메일로 초대한다 (봇은 초대를 대신 못 한다)
 *   3) 선생님이 가입을 마쳐야 users.list 에 나타난다
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
        return env;
    }
    console.error('환경변수 파일을 찾지 못했습니다.');
    process.exit(1);
}

const env = loadEnv();
const TEACHER_DB = env.TEACHER_DB_ID || '27a09320-bce2-80ca-a2b2-fe0f69e52506';
const NH = { Authorization: `Bearer ${env.NOTION_ACCESS_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

async function notion(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: NH });
    const b = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${b.code}: ${b.message}`);
    return b;
}
const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

async function kakaoworkUsers() {
    const out = [];
    let cursor = null;
    do {
        const url = 'https://api.kakaowork.com/v1/users.list?limit=100' + (cursor ? `&cursor=${cursor}` : '');
        const r = await fetch(url, { headers: { Authorization: `Bearer ${env.KAKAOWORK_APP_KEY}` } });
        const b = await r.json();
        if (!b.success) throw new Error(JSON.stringify(b).slice(0, 200));
        out.push(...(b.users || []));
        cursor = b.cursor || null;
    } while (cursor);
    return out;
}

const setArg = (() => {
    const i = process.argv.indexOf('--set');
    return i >= 0 ? process.argv[i + 1] : null;
})();
const SYNC = process.argv.includes('--sync');
const CLEAR = process.argv.includes('--clear-invalid');

const 이메일of = u => (u.identifications || []).map(x => x.value).find(Boolean) || u.work_email || '';
const norm = e => String(e || '').trim().toLowerCase();

async function writeId(row, name, id) {
    await notion(`https://api.notion.com/v1/pages/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { '카카오워크 ID': { rich_text: [{ text: { content: String(id) } }] } } }),
    });
}

(async () => {
    const [users, rows] = await Promise.all([
        kakaoworkUsers(),
        notion(`https://api.notion.com/v1/databases/${TEACHER_DB}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100 }) }).then(d => d.results),
    ]);

    console.log(`=== 카카오워크 워크스페이스 사용자 ${users.length}명 ===`);
    for (const u of users) {
        console.log(`  ${String(u.id).padEnd(12)} ${u.name}  ${이메일of(u) || '(이메일없음)'}`);
    }

    const byEmail = new Map(users.filter(u => 이메일of(u)).map(u => [norm(이메일of(u)), u]));

    console.log(`\n=== 선생님 명부 ${rows.length}명 ===`);
    const 대기 = [];
    for (const r of rows) {
        const 이름 = plain(r.properties['이름']);
        const kwid = plain(r.properties['카카오워크 ID']);
        const email = r.properties['이메일']?.email || '';
        const 매치 = email ? byEmail.get(norm(email)) : null;

        // 카카오워크 ID 는 반드시 숫자다. 이메일·이름이 들어가 있으면 발송이 실패하므로 걸러낸다.
        const 유효 = /^\d+$/.test(kwid);
        const 실재 = 유효 && users.some(u => String(u.id) === kwid);

        let 상태;
        if (kwid && !유효) 상태 = `🔴 잘못된 값 "${kwid}" — 숫자 ID 여야 함. 비우고 다시 연결할 것`;
        else if (유효 && !실재) 상태 = `🔴 id=${kwid} 가 카카오워크에 없음 — 탈퇴했거나 오타`;
        else if (실재) 상태 = `✅ 연결됨 (${kwid})`;
        else if (!email) 상태 = '⛔ 이메일 먼저 채워야 함';
        else if (매치) 상태 = `🔗 매칭 가능 → ${매치.id} (${매치.name})`;
        else 상태 = '⏳ 카카오워크 가입 대기';

        console.log(`  ${이름.padEnd(12)} ${(email || '-').padEnd(28)} ${상태}`);
        if (!실재 && 매치) 대기.push({ row: r, 이름, id: 매치.id, 실명: 매치.name, 덮어씀: Boolean(kwid) });
    }

    if (CLEAR) {
        console.log('\n=== 잘못된 카카오워크 ID 비우기 ===');
        let n = 0;
        for (const r of rows) {
            const kwid = plain(r.properties['카카오워크 ID']);
            if (!kwid || /^\d+$/.test(kwid)) continue;
            await notion(`https://api.notion.com/v1/pages/${r.id}`, {
                method: 'PATCH', body: JSON.stringify({ properties: { '카카오워크 ID': { rich_text: [] } } }),
            });
            console.log(`  🧹 ${plain(r.properties['이름'])} — "${kwid}" 지움`);
            n++;
        }
        if (!n) console.log('  비울 게 없습니다.');
        return;
    }

    if (SYNC) {
        console.log('\n=== 이메일 매칭분 쓰기 ===');
        if (!대기.length) console.log('  채울 게 없습니다.');
        for (const t of 대기) {
            await writeId(t.row, t.이름, t.id);
            console.log(`  ✅ ${t.이름} → ${t.id} (${t.실명})${t.덮어씀 ? ' [기존 값 덮어씀]' : ''}`);
        }
        return;
    }

    if (setArg) {
        console.log('\n=== 수동 지정 쓰기 ===');
        for (const s of setArg.split(',').map(x => x.trim()).filter(Boolean)) {
            const [name, id] = s.split('=').map(x => x.trim());
            const row = rows.find(r => plain(r.properties['이름']) === name);
            if (!row) { console.log(`  ❌ ${name} — 선생님 명부에 없음`); continue; }
            if (!users.some(u => String(u.id) === String(id))) {
                console.log(`  ❌ ${name} — 카카오워크에 id=${id} 인 사용자가 없음 (가입 완료됐는지 확인)`);
                continue;
            }
            await writeId(row, name, id);
            console.log(`  ✅ ${name} → ${id}`);
        }
        return;
    }

    console.log('\n--- 출력만 했습니다 ---');
    console.log(`  이메일로 지금 연결 가능한 사람: ${대기.length}명`);
    console.log('  자동 연결:  node scripts/link-teacher-kakaowork.mjs --sync');
    console.log('  잘못된 값 비우기: node scripts/link-teacher-kakaowork.mjs --clear-invalid');
    console.log('  수동 지정:  node scripts/link-teacher-kakaowork.mjs --set "레일라쌤=12034567"');
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
