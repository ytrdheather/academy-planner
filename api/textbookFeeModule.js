/**
 * 교재비 관리 — 신청 → 승인 → 알림톡 발송까지.
 * 설계 문서: docs/교재비관리-설계.md
 *
 * 흐름 (5분 크론 한 개가 전부 처리한다)
 *   1) 진행상태=승인대기 & 원장알림함=false  → 원장 DM(승인/반려 버튼) → 원장알림함=true
 *   2) 진행상태=승인됨|반려 & 교사알림함=false → 담당쌤 DM            → 교사알림함=true
 *   3) 진행상태=승인됨 & 발송예약=true       → 발송중 선점 → 검증 → 알림톡 → 발송완료
 *   4) 발송중인데 30분 넘게 멈춘 행          → 원장에게 알림 (조용히 안 나가는 게 제일 나쁘다)
 *
 * 중복 발송 방지가 이 모듈에서 제일 중요하다. 학부모가 입금 요청을 두 번 받으면 안 된다.
 * 그래서 발송 직전에 진행상태를 '발송중'으로 먼저 PATCH 하고, 그 PATCH 가 성공한 행만 보낸다.
 */
import crypto from 'crypto';

// 알림톡 — 이미 승인된 템플릿을 쓴다. 새로 심사받지 않는다. (설계 §5)
// 계좌번호가 템플릿 본문에 하드코딩돼 있어서 계좌가 바뀌면 재심사가 필요하다.
const ALIMTALK_PF_ID = 'KA01PF250113084507284jSE3GEmbOOw';
const ALIMTALK_TEMPLATE_ID = 'KA01TP2512261533265840etUCdm2j2f';

const STUCK_MINUTES = 30;          // 발송중에서 이만큼 멈춰 있으면 사고로 본다
const TEACHER_CACHE_MS = 5 * 60 * 1000;

const won = n => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

// 제목에 박히는 날짜. toISOString() 은 UTC 라 새벽 0~9시에 전날로 찍힌다.
// (실제로 8월 5일 새벽에 "· 2026-08-04" 가 찍히는 걸 확인했다)
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function initializeTextbookFeeRoutes({
    app, requireAuth, fetchNotion, sendKakaoWork, sendSms,
    jwtSecret, domainUrl, dbIds, approvalConv, cron,
}) {
    const FEE_DB = dbIds?.TEXTBOOK_FEE_DB_ID;
    const TEACHER_DB = dbIds?.TEACHER_DB_ID;

    if (!FEE_DB) {
        console.warn('⚠️ TEXTBOOK_FEE_DB_ID 없음 — 교재비 기능 비활성화');
        return;
    }
    if (!approvalConv) {
        console.warn('⚠️ KAKAOWORK_APPROVAL_CONV 없음 — 원장 승인 알림이 나가지 않는다');
    }

    // ── 승인/반려 링크 서명 ────────────────────────────────────────
    // 이 링크 자체가 열쇠다. 원장 DM 에만 들어가지만 서명이 없으면 페이지 id 만 알아도 승인이 된다.
    const sign = (id, action) =>
        crypto.createHmac('sha256', jwtSecret).update(`${id}:${action}`).digest('hex').slice(0, 32);
    const actionUrl = (id, action) =>
        `${domainUrl}/api/textbook/act?id=${id}&a=${action}&t=${sign(id, action)}`;

    // ── 노션 읽기 ──────────────────────────────────────────────────
    /** 교재비 행 하나를 쓰기 편한 모양으로 바꾼다. 속성 타입별 접근법은 설계 §8 참조. */
    function readRow(page) {
        const p = page.properties;
        return {
            id: page.id,
            url: page.url,
            제목: plain(p['제목']),
            학생Id: p['학생']?.relation?.[0]?.id || '',
            변경교재Ids: (p['변경 교재']?.relation || []).map(r => r.id),
            교재목록: p['교재 목록']?.formula?.string || '',
            기존교재목록: p['기존 교재 목록']?.formula?.string || '',
            합계금액: p['합계 금액']?.rollup?.number ?? null,
            청구금액: p['청구 금액']?.formula?.number ?? null,
            연락처: p['학부모 연락처']?.rollup?.array?.[0]?.phone_number || '',
            담당쌤: (p['담당쌤']?.rollup?.array?.[0]?.multi_select || []).map(o => o.name),
            진행상태: p['진행상태']?.select?.name || '',
            요청메모: plain(p['요청 메모']),
            반려사유: plain(p['반려 사유']),
            발송예약: !!p['발송 예약']?.checkbox,
            원장알림함: !!p['원장알림함']?.checkbox,
            교사알림함: !!p['교사알림함']?.checkbox,
        };
    }

    const patch = (id, properties) =>
        fetchNotion(`https://api.notion.com/v1/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });

    async function queryFee(filter) {
        const out = [];
        let cursor, more = true;
        while (more) {
            const d = await fetchNotion(`https://api.notion.com/v1/databases/${FEE_DB}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
            });
            out.push(...d.results); more = d.has_more; cursor = d.next_cursor;
        }
        return out.map(readRow);
    }

    /** 학생 이름. relation 은 id 만 오므로 페이지를 따로 읽어야 한다(설계 §2-1). */
    const nameCache = new Map();
    async function studentName(id) {
        if (!id) return '';
        if (nameCache.has(id)) return nameCache.get(id);
        try {
            const page = await fetchNotion(`https://api.notion.com/v1/pages/${id}`);
            const n = plain(page.properties?.['이름']);
            nameCache.set(id, n);
            return n;
        } catch { return ''; }
    }

    // ── 발송 전 검증 (설계 §6-2) ───────────────────────────────────
    /**
     * 조용히 틀린 금액이 나가는 것을 막는다.
     * 교재 552권 중 197권에 가격이 없어서, 그 교재를 담으면 롤업이 0원으로 무시하고
     * 학부모에게 실제보다 적게 청구된다. 나중에 차액을 다시 달라고 해야 하는데 그게 제일 나쁘다.
     */
    async function validate(row) {
        const problems = [];
        if (!row.변경교재Ids.length) problems.push('변경 교재가 비어 있음');
        if (!row.연락처) problems.push('학부모 연락처 없음');

        const 무가격 = [];
        for (const id of row.변경교재Ids) {
            try {
                const book = await fetchNotion(`https://api.notion.com/v1/pages/${id}`);
                const 가격 = book.properties?.['가격']?.number;
                if (가격 == null || 가격 === 0) 무가격.push(plain(book.properties?.['교재이름']) || '(이름없음)');
            } catch { problems.push('교재 정보를 읽지 못함'); }
        }
        if (무가격.length) problems.push(`가격 미입력: ${무가격.join(', ')}`);

        // 알림톡은 변수 자리에 빈 문자열이 들어가면 카카오가 거부한다 (설계 §5)
        if (!row.교재목록) problems.push('교재 목록이 비어 있음');
        if (!row.청구금액) problems.push('청구 금액이 0이거나 비어 있음');
        return problems;
    }

    // ── 알림톡 ─────────────────────────────────────────────────────
    /**
     * 승인된 템플릿으로 보낸다. 변수 3개뿐이고 교재는 몇 권이든 #{교재정보} 하나에 들어간다.
     * 알림톡이 거부되면 같은 내용을 문자로 보낸다 — 안 나가는 것보다는 문자가 낫다.
     * (다만 솔라피가 접수한 뒤 비동기로 실패하는 경우는 여기서 못 잡는다.)
     */
    async function sendAlimtalk(row, 이름) {
        const key = process.env.SOLAPI_API_KEY;
        const secret = process.env.SOLAPI_API_SECRET;
        const from = process.env.SOLAPI_SENDER;
        if (!key || !secret || !from) throw new Error('솔라피 설정 없음');

        const date = new Date().toISOString();
        const salt = crypto.randomBytes(16).toString('hex');
        const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');

        const res = await fetch('https://api.solapi.com/messages/v4/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`,
            },
            body: JSON.stringify({
                message: {
                    to: String(row.연락처).replace(/[^0-9]/g, ''),
                    from,
                    kakaoOptions: {
                        pfId: ALIMTALK_PF_ID,
                        templateId: ALIMTALK_TEMPLATE_ID,
                        disableSms: true,   // 폴백은 아래에서 직접 한다(어느 경로로 나갔는지 로그에 남기려고)
                        variables: {
                            '#{학생이름}': 이름,
                            '#{교재정보}': row.교재목록,
                            '#{교재비}': won(row.청구금액),
                        },
                    },
                },
            }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && !body?.failedMessageList?.length) return '알림톡';

        // 폴백: 문자. 계좌는 템플릿에만 있으므로 문자용 문구를 여기서 만든다.
        console.warn('알림톡 실패 → 문자 폴백:', JSON.stringify(body).slice(0, 300));
        const ok = await sendSms(row.연락처,
            `[리디튜드] 교재 입금 안내\n${이름} 학생의 새 교재입니다.\n\n${row.교재목록}\n\n교재비 ${won(row.청구금액)}\n국민 4266 02 01415 043 (예금주 : 이명수)`,
            '교재 입금 안내');
        if (!ok) throw new Error('알림톡·문자 모두 실패');
        return '문자';
    }

    // ── 카카오워크 ─────────────────────────────────────────────────
    async function openDm(userId) {
        const res = await fetch('https://api.kakaowork.com/v1/conversations.open', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.KAKAOWORK_APP_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: Number(userId) }),
        });
        const b = await res.json();
        if (!b?.success) throw new Error(`conversations.open 실패: ${JSON.stringify(b).slice(0, 200)}`);
        return b.conversation.id;
    }

    /** 버튼 달린 메시지. 블록에 description 은 안 먹으므로 text + button 만 쓴다. */
    async function sendCard(conversationId, title, body, buttons = []) {
        const blocks = [
            { type: 'header', text: title, style: 'blue' },
            { type: 'text', text: body, markdown: false },
        ];
        for (const b of buttons) {
            blocks.push({ type: 'button', text: b.text, style: b.style || 'default', action_type: 'open_system_browser', value: b.url });
        }
        const res = await fetch('https://api.kakaowork.com/v1/messages.send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.KAKAOWORK_APP_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId, text: `${title}\n\n${body}`, blocks }),
        });
        const b = await res.json();
        if (!b?.success) throw new Error(`messages.send 실패: ${JSON.stringify(b).slice(0, 200)}`);
        return true;
    }

    const notifyOwner = (title, body, buttons) =>
        approvalConv ? sendCard(approvalConv, title, body, buttons) : Promise.resolve(false);

    /** 선생님 이름 → 카카오워크 숫자 ID. 이메일로 연결해 둔 값을 읽기만 한다. */
    let teacherCache = { at: 0, map: new Map() };
    async function teacherMap() {
        if (!TEACHER_DB) return new Map();
        if (Date.now() - teacherCache.at < TEACHER_CACHE_MS) return teacherCache.map;
        const d = await fetchNotion(`https://api.notion.com/v1/databases/${TEACHER_DB}/query`, {
            method: 'POST', body: JSON.stringify({ page_size: 100 }),
        });
        const map = new Map();
        for (const r of d.results) {
            const 이름 = plain(r.properties['이름']);
            const id = plain(r.properties['카카오워크 ID']);
            // 이메일이 잘못 들어가 있던 적이 있다. 숫자가 아니면 쓰지 않는다.
            if (이름 && /^\d+$/.test(id)) map.set(이름, id);
        }
        teacherCache = { at: Date.now(), map };
        return map;
    }

    // ── 메시지 본문 ────────────────────────────────────────────────
    function summary(row, 이름) {
        const lines = [`학생    ${이름 || '(이름없음)'}${row.담당쌤.length ? `  (담당 ${row.담당쌤.join(', ')})` : ''}`];
        if (row.기존교재목록) lines.push('', `기존    ${row.기존교재목록}`);
        lines.push(row.기존교재목록 ? `변경    ${row.교재목록}` : `\n교재    ${row.교재목록}`);
        lines.push('', `정가    ${won(row.합계금액)}`, `청구    ${won(row.청구금액)}`);
        if (row.요청메모) lines.push('', `메모    ${row.요청메모}`);
        return lines.join('\n');
    }

    // ── 크론 한 바퀴 ───────────────────────────────────────────────
    async function tick() {
        const r = { 원장알림: 0, 교사알림: 0, 발송: 0, 보류: 0, 실패: [] };

        // 1) 승인대기 → 원장에게
        for (const row of await queryFee({
            and: [{ property: '진행상태', select: { equals: '승인대기' } }, { property: '원장알림함', checkbox: { equals: false } }],
        })) {
            try {
                const 이름 = await studentName(row.학생Id);
                const problems = await validate(row);
                // 승인 시점에 미리 알려주면 원장이 교재 마스터를 고치고 승인할 수 있다 (설계 §6-2)
                const body = summary(row, 이름) + (problems.length ? `\n\n⚠️ 이대로는 발송이 막힙니다\n· ${problems.join('\n· ')}` : '');
                await notifyOwner('교재 변경 승인 요청', body, [
                    { text: '✅ 승인', style: 'primary', url: actionUrl(row.id, 'approve') },
                    { text: '❌ 반려', style: 'danger', url: actionUrl(row.id, 'reject') },
                    { text: '노션에서 열기', url: row.url },
                ]);
                await patch(row.id, {
                    '원장알림함': { checkbox: true },
                    ...(row.제목 ? {} : { '제목': { title: [{ text: { content: `${이름} · ${kstToday()}` } }] } }),
                });
                r.원장알림++;
            } catch (e) { r.실패.push(`원장알림/${row.id}: ${e.message}`); }
        }

        // 2) 승인됨·반려 → 담당쌤에게
        for (const row of await queryFee({
            and: [
                { or: [{ property: '진행상태', select: { equals: '승인됨' } }, { property: '진행상태', select: { equals: '반려' } }] },
                { property: '교사알림함', checkbox: { equals: false } },
            ],
        })) {
            try {
                const 이름 = await studentName(row.학생Id);
                const map = await teacherMap();
                const 승인 = row.진행상태 === '승인됨';
                const title = 승인 ? '교재 변경 승인됨' : '교재 변경 반려';
                const body = summary(row, 이름) + (승인 ? '' : `\n\n반려 사유\n${row.반려사유 || '(사유 없음)'}`);

                const 못보냄 = [];
                for (const t of row.담당쌤) {
                    const uid = map.get(t);
                    if (!uid) { 못보냄.push(t); continue; }
                    await sendCard(await openDm(uid), title, body, [{ text: '노션에서 열기', url: row.url }]);
                }
                // 알림이 안 간 걸 아무도 모르는 게 제일 나쁘다. 원장에게 알린다.
                if (못보냄.length) {
                    await notifyOwner('교사 알림 실패',
                        `${이름} 건 — ${못보냄.join(', ')} 의 카카오워크 ID 가 없어 알림을 못 보냈습니다.\n선생님 명부에서 연결해 주세요.`);
                }
                await patch(row.id, { '교사알림함': { checkbox: true } });
                r.교사알림++;
            } catch (e) { r.실패.push(`교사알림/${row.id}: ${e.message}`); }
        }

        // 3) 승인됨 + 발송예약 → 학부모 알림톡
        for (const row of await queryFee({
            and: [{ property: '진행상태', select: { equals: '승인됨' } }, { property: '발송 예약', checkbox: { equals: true } }],
        })) {
            let 선점 = false;
            try {
                const 이름 = await studentName(row.학생Id);
                const problems = await validate(row);
                if (problems.length) {
                    await patch(row.id, { '진행상태': { select: { name: '보류' } }, '발송 예약': { checkbox: false } });
                    await notifyOwner('발송 보류', `${이름} 건을 보내지 않았습니다.\n\n· ${problems.join('\n· ')}\n\n고친 뒤 진행상태를 '승인됨'으로 되돌리고 발송 예약을 다시 켜 주세요.`,
                        [{ text: '노션에서 열기', url: row.url }]);
                    r.보류++;
                    continue;
                }

                // 🔴 발송 직전 선점. 이 PATCH 가 성공한 행만 실제로 보낸다.
                await patch(row.id, { '진행상태': { select: { name: '발송중' } } });
                선점 = true;

                const 경로 = await sendAlimtalk(row, 이름);
                await patch(row.id, {
                    '진행상태': { select: { name: '발송완료' } },
                    '발송 일시': { date: { start: new Date().toISOString() } },
                    '발송 예약': { checkbox: false },
                });
                await notifyOwner('교재비 안내 발송 완료', `${이름} 학부모님께 ${경로}로 보냈습니다.\n\n${row.교재목록}\n청구 ${won(row.청구금액)}`);
                r.발송++;
            } catch (e) {
                r.실패.push(`발송/${row.id}: ${e.message}`);
                // 선점만 해두고 실패하면 '발송중'에 갇힌다. 4번이 주워서 원장에게 알린다.
                if (선점) console.error(`교재비 발송 실패(발송중 상태로 남음) ${row.id}: ${e.message}`);
            }
        }

        // 4) 발송중에 갇힌 행
        const stuck = await queryFee({
            and: [
                { property: '진행상태', select: { equals: '발송중' } },
                { timestamp: 'last_edited_time', last_edited_time: { before: new Date(Date.now() - STUCK_MINUTES * 60000).toISOString() } },
            ],
        });
        for (const row of stuck) {
            try {
                const 이름 = await studentName(row.학생Id);
                await notifyOwner('발송이 멈춰 있습니다',
                    `${이름} 건이 '발송중'에서 ${STUCK_MINUTES}분 넘게 멈춰 있습니다.\n실제로 나갔는지 확인이 필요합니다.\n\n※ 중복 발송을 막으려고 서버가 자동으로 다시 보내지는 않습니다.`,
                    [{ text: '노션에서 열기', url: row.url }]);
                await patch(row.id, { '진행상태': { select: { name: '보류' } } });
            } catch (e) { r.실패.push(`멈춤알림/${row.id}: ${e.message}`); }
        }

        return r;
    }

    // ── 승인/반려 버튼이 누르는 주소 ───────────────────────────────
    const page = (title, msg, tone = '#2d6cdf') => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f6f7f9;padding:24px}
.c{background:#fff;border-radius:14px;padding:32px 28px;max-width:420px;width:100%;box-shadow:0 2px 16px rgba(0,0,0,.08)}
h1{font-size:19px;margin:0 0 12px;color:${tone}}p{margin:0;color:#444;line-height:1.7;white-space:pre-wrap}
textarea{width:100%;box-sizing:border-box;margin-top:14px;padding:10px;border:1px solid #ccd;border-radius:8px;font:inherit;min-height:80px}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:${tone};color:#fff;font:inherit;font-weight:600;cursor:pointer}</style>
<div class="c"><h1>${title}</h1>${msg}</div>`;

    app.get('/api/textbook/act', async (req, res) => {
        const id = String(req.query.id || '');
        const action = String(req.query.a || '');
        const token = String(req.query.t || '');

        if (!['approve', 'reject'].includes(action)) return res.status(400).send(page('잘못된 요청', '<p>알 수 없는 동작입니다.</p>', '#c33'));
        // 타이밍 공격까지 막을 필요는 없지만, 서명이 없으면 id 만 알아도 승인이 된다
        if (token !== sign(id, action)) return res.status(403).send(page('링크가 올바르지 않습니다', '<p>주소가 잘리거나 변형된 것 같습니다.\n카카오워크에서 버튼을 다시 눌러 주세요.</p>', '#c33'));

        try {
            const row = readRow(await fetchNotion(`https://api.notion.com/v1/pages/${id}`));
            const 이름 = await studentName(row.학생Id);

            if (row.진행상태 !== '승인대기') {
                return res.send(page('이미 처리된 건입니다',
                    `<p>${이름} 건은 지금 <b>${row.진행상태 || '알 수 없음'}</b> 상태입니다.\n중복 처리를 막기 위해 아무것도 바꾸지 않았습니다.</p>`, '#888'));
            }

            if (action === 'approve') {
                await patch(id, { '진행상태': { select: { name: '승인됨' } } });
                return res.send(page('승인했습니다',
                    `<p>${이름} 건을 승인했습니다.\n담당 선생님께 곧 알림이 갑니다.\n\n학부모 발송은 노션에서 <b>발송 예약</b>을 켜면 시작됩니다.</p>`));
            }

            // 반려는 사유가 있어야 담당쌤이 뭘 고칠지 안다
            return res.send(page('반려 사유를 적어 주세요', `
<p>${이름} 건을 반려합니다.</p>
<form method="POST" action="/api/textbook/act">
  <input type="hidden" name="id" value="${id}"><input type="hidden" name="t" value="${token}">
  <textarea name="reason" placeholder="예) 이 교재는 다음 학기에 나가요" required></textarea>
  <button type="submit">반려 처리</button>
</form>`, '#c33'));
        } catch (e) {
            console.error('교재비 승인 처리 오류:', e.message);
            res.status(500).send(page('처리하지 못했습니다', `<p>${e.message}</p>`, '#c33'));
        }
    });

    // 폼 파싱은 index.js 가 express.urlencoded 를 전역으로 걸어 둬서 따로 필요 없다
    app.post('/api/textbook/act', async (req, res) => {
        const id = String(req.body?.id || '');
        const reason = String(req.body?.reason || '').trim().slice(0, 500);
        if (String(req.body?.t || '') !== sign(id, 'reject')) return res.status(403).send(page('링크가 올바르지 않습니다', '<p>다시 시도해 주세요.</p>', '#c33'));
        try {
            await patch(id, { '진행상태': { select: { name: '반려' } }, '반려 사유': { rich_text: reason ? [{ text: { content: reason } }] : [] } });
            res.send(page('반려했습니다', '<p>담당 선생님께 사유와 함께 알림이 갑니다.</p>', '#c33'));
        } catch (e) {
            res.status(500).send(page('처리하지 못했습니다', `<p>${e.message}</p>`, '#c33'));
        }
    });

    // 크론이 못 돌았을 때 손으로 한 바퀴 돌리는 용도
    app.post('/api/textbook/tick', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await tick()) }); }
        catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    cron.schedule('*/5 * * * *', async () => {
        try {
            const r = await tick();
            if (r.원장알림 || r.교사알림 || r.발송 || r.보류 || r.실패.length) {
                console.log(`📚 교재비: 원장알림 ${r.원장알림} / 교사알림 ${r.교사알림} / 발송 ${r.발송} / 보류 ${r.보류} / 실패 ${r.실패.length}`);
                if (r.실패.length) console.error('교재비 실패 목록:', r.실패);
            }
        } catch (e) { console.error('교재비 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    console.log('✅ 교재비 관리 모듈 로드됨 (5분 크론)');
}
