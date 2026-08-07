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
    jwtSecret, domainUrl, dbIds, approvalConv, assistantConv, cron, publicPath, path,
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
            입금확인: !!p['입금 확인']?.checkbox,
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

        // 이름을 여기서 같이 모은다. `교재 목록` 수식 문자열을 ", " 로 쪼개면
        // 교재명 자체에 쉼표가 든 경우 엉뚱하게 잘린다. relation 에서 직접 읽는 게 안전하다.
        const names = [], 무가격 = [];
        for (const id of row.변경교재Ids) {
            try {
                const book = await fetchNotion(`https://api.notion.com/v1/pages/${id}`);
                const 이름 = plain(book.properties?.['교재이름']) || '(이름없음)';
                const 가격 = book.properties?.['가격']?.number;
                names.push(이름);
                if (가격 == null || 가격 === 0) 무가격.push(이름);
            } catch { problems.push('교재 정보를 읽지 못함'); }
        }
        if (무가격.length) problems.push(`가격 미입력: ${무가격.join(', ')}`);

        // 알림톡은 변수 자리에 빈 문자열이 들어가면 카카오가 거부한다 (설계 §5)
        if (!row.교재목록) problems.push('교재 목록이 비어 있음');
        if (!row.청구금액) problems.push('청구 금액이 0이거나 비어 있음');
        return { problems, names };
    }

    // ── 알림톡 ─────────────────────────────────────────────────────
    /**
     * 승인된 템플릿으로 보낸다. 변수 3개뿐이고 교재는 몇 권이든 #{교재정보} 하나에 들어간다.
     * 알림톡이 거부되면 같은 내용을 문자로 보낸다 — 안 나가는 것보다는 문자가 낫다.
     * (다만 솔라피가 접수한 뒤 비동기로 실패하는 경우는 여기서 못 잡는다.)
     */
    async function sendAlimtalk(row, 이름, 교재이름들) {
        const key = process.env.SOLAPI_API_KEY;
        const secret = process.env.SOLAPI_API_SECRET;
        const from = process.env.SOLAPI_SENDER;
        if (!key || !secret || !from) throw new Error('솔라피 설정 없음');

        const date = new Date().toISOString();
        const salt = crypto.randomBytes(16).toString('hex');
        const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');

        // 한 줄에 한 권. 쉼표로 이어붙이면 5권부터 문단처럼 뭉쳐서 못 읽는다(실측).
        // 설계 §5 는 "줄바꿈 든 변수는 심사에서 거절 사례가 있다"고 적었지만 그건 신규 심사 얘기고,
        // 이미 승인된 템플릿의 변수 값에 개행을 넣는 것은 발송 단계 문제다. 실발송으로 확인했다.
        const 교재정보 = (교재이름들?.length ? 교재이름들 : [row.교재목록]).join('\n');

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
                            '#{교재정보}': 교재정보,
                            '#{교재비}': won(row.청구금액),
                        },
                    },
                },
            }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && !body?.failedMessageList?.length) return '알림톡으로';

        // 폴백: 문자. 계좌는 템플릿에만 있으므로 문자용 문구를 여기서 만든다.
        console.warn('알림톡 실패 → 문자 폴백:', JSON.stringify(body).slice(0, 300));
        const ok = await sendSms(row.연락처,
            `[리디튜드] 교재 입금 안내\n${이름} 학생의 새 교재입니다.\n\n${교재정보}\n\n교재비 ${won(row.청구금액)}\n국민 4266 02 01415 043 (예금주 : 이명수)`,
            '교재 입금 안내');
        if (!ok) throw new Error('알림톡·문자 모두 실패');
        return '문자로';
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
        // 정가는 싣지 않는다. 어떤 항목이든 결국 10% 할인된 금액으로 나가므로
        // 승인 판단에 필요한 것은 청구액뿐이다(2026-08-05 원장 확정).
        lines.push('', `청구    ${won(row.청구금액)}`);
        if (row.요청메모) lines.push('', `메모    ${row.요청메모}`);
        return lines.join('\n');
    }

    // ── 발송 한 건 ─────────────────────────────────────────────────
    /**
     * 🔴 중복 발송 방지가 여기 전부 걸려 있다. 학부모가 같은 입금 요청을 두 번 받으면 안 된다.
     * 5분 크론(즉시 발송)과 월·목 배치가 같은 시각에 겹칠 수 있어서 세 겹으로 막는다.
     *   1) 같은 프로세스 안에서 같은 행을 동시에 집지 않도록 잠금
     *   2) 보내기 직전에 노션을 다시 읽어 아직 '승인됨' 인지 확인 (다른 크론이 이미 가져갔을 수 있다)
     *   3) '발송중' 으로 먼저 PATCH 해서 선점
     */
    const sending = new Set();

    async function sendOne(row, { 개별알림 }) {
        if (sending.has(row.id)) return { skipped: true };
        sending.add(row.id);
        let 선점 = false;
        try {
            const 이름 = await studentName(row.학생Id);
            const { problems, names } = await validate(row);
            if (problems.length) {
                await patch(row.id, { '진행상태': { select: { name: '보류' } }, '발송 예약': { checkbox: false } });
                await notifyOwner('발송 보류', `${이름} 건을 보내지 않았습니다.\n\n· ${problems.join('\n· ')}\n\n고친 뒤 진행상태를 '승인됨'으로 되돌려 주세요.`,
                    [{ text: '노션에서 열기', url: row.url }]);
                return { held: true, 이름, problems };
            }

            // 다시 읽어서 확인. 그사이 다른 크론이 가져갔으면 여기서 멈춘다.
            const 지금 = readRow(await fetchNotion(`https://api.notion.com/v1/pages/${row.id}`));
            if (지금.진행상태 !== '승인됨') return { skipped: true };

            await patch(row.id, { '진행상태': { select: { name: '발송중' } } });
            선점 = true;

            const 경로 = await sendAlimtalk(row, 이름, names);
            await patch(row.id, {
                '진행상태': { select: { name: '발송완료' } },
                '발송 일시': { date: { start: new Date().toISOString() } },
                '발송 예약': { checkbox: false },
                // 승인대기를 안 거치고 바로 승인됨으로 올린 행은 제목이 비어 있다.
                // 이력이 쌓이는 원장인데 제목 없는 행이 섞이면 나중에 못 알아본다.
                ...(row.제목 ? {} : { '제목': { title: [{ text: { content: `${이름} · ${kstToday()}` } }] } }),
            });
            if (개별알림) {
                await notifyOwner('교재비 안내 발송 완료', `${이름} 학부모님께 ${경로} 보냈습니다.\n\n${row.교재목록}\n청구 ${won(row.청구금액)}`);
            }
            return { sent: true, 이름, 경로, 금액: row.청구금액 };
        } catch (e) {
            // 선점만 해두고 실패하면 '발송중'에 갇힌다. tick 4번이 주워서 원장에게 알린다.
            if (선점) console.error(`교재비 발송 실패(발송중 상태로 남음) ${row.id}: ${e.message}`);
            return { error: e.message };
        } finally {
            sending.delete(row.id);
        }
    }

    // ── 월·목 묶음 발송 ────────────────────────────────────────────
    /**
     * 원장이 승인해 둔 것을 모아서 한 번에 보낸다. 행마다 발송 예약을 켜는 수고를 없앤다.
     * 알림톡 자체는 학부모별로 각각 나간다 — 묶는 것은 발송 작업이지 메시지가 아니다.
     * 완료 알림도 건별로 보내면 열 통씩 쌓이므로 요약 한 통만 보낸다.
     */
    async function sendBatch() {
        const rows = await queryFee({ property: '진행상태', select: { equals: '승인됨' } });
        const 보냄 = [], 보류 = [], 실패 = [];

        for (const row of rows) {
            const res = await sendOne(row, { 개별알림: false });
            if (res.sent) 보냄.push(`· ${res.이름}  ${won(res.금액)}`);
            else if (res.held) 보류.push(`· ${res.이름} — ${res.problems.join(', ')}`);
            else if (res.error) 실패.push(`· ${row.제목 || row.id}: ${res.error}`);
        }

        const 합계 = 보냄.length;
        const lines = [`승인된 ${rows.length}건 중 ${합계}건을 보냈습니다.`];
        if (보냄.length) lines.push('', '보낸 건', ...보냄);
        if (보류.length) lines.push('', '⚠️ 보류 — 고친 뒤 진행상태를 승인됨으로 되돌려 주세요', ...보류);
        if (실패.length) lines.push('', '🔴 실패 — 확인이 필요합니다', ...실패);
        if (!rows.length) lines[0] = '오늘 나갈 교재비 안내가 없습니다.';

        // 0건이어도 보낸다. 배치가 조용히 안 도는 것을 아무도 모르는 게 제일 나쁘다.
        await notifyOwner('교재비 묶음 발송', lines.join('\n'));
        return { 대상: rows.length, 발송: 합계, 보류: 보류.length, 실패: 실패.length };
    }

    // ── 조교 장보기 목록 (설계 §7) ─────────────────────────────────
    /**
     * 학부모는 학생별로 받지만 조교는 교재별로 산다.
     * 한 행에 5권이 묶여 있으면 노션에서는 "이번 주에 Reading Sense 3 을 몇 권 사야 하나"가 안 나온다.
     * DB 를 쪼개지 않고 서버가 교재별로 합산해서 한 장으로 뽑아 준다.
     *
     * 대상: 진행상태가 승인됨·발송중·발송완료 이고 구매상태가 구매완료가 아닌 행.
     *   - 승인됨: 아직 학부모에게 안 나갔지만 원장이 승인했으니 미리 사도 된다
     *   - 보류·반려·작성중은 제외 — 나갈지 안 나갈지 모르는 것을 미리 사면 재고가 된다
     */
    async function shoppingList() {
        const rows = await queryFee({
            and: [
                {
                    or: ['승인됨', '발송중', '발송완료'].map(s => ({ property: '진행상태', select: { equals: s } })),
                },
                { property: '구매 상태', select: { does_not_equal: '구매완료' } },
            ],
        });

        // 교재 이름 → [{ 학생, 입금확인 }]
        // 입금 안 된 건을 빼지 않고 표시만 한다. 빼면 교재가 필요한데 입금이 늦는 학생이
        // 목록에서 사라져 아무도 모르게 된다 — 수업에 책 없이 앉아 있는 게 더 나쁘다.
        const 교재별 = new Map();
        const 교재이름캐시 = new Map();
        for (const row of rows) {
            const 이름 = await studentName(row.학생Id);
            for (const id of row.변경교재Ids) {
                if (!교재이름캐시.has(id)) {
                    const b = await fetchNotion(`https://api.notion.com/v1/pages/${id}`);
                    교재이름캐시.set(id, plain(b.properties?.['교재이름']) || '(이름없음)');
                }
                const 교재이름 = 교재이름캐시.get(id);
                if (!교재별.has(교재이름)) 교재별.set(교재이름, []);
                교재별.get(교재이름).push({ 학생: 이름 || '(이름없음)', 입금확인: row.입금확인 });
            }
        }

        const items = [...교재별.entries()]
            .map(([교재, 목록]) => ({
                교재,
                권수: 목록.length,
                학생들: 목록.map(x => x.학생),
                미입금: 목록.filter(x => !x.입금확인).map(x => x.학생),
            }))
            .sort((a, b) => b.권수 - a.권수 || a.교재.localeCompare(b.교재, 'ko'));

        return {
            건수: rows.length,
            총권수: items.reduce((s, i) => s + i.권수, 0),
            미입금건수: rows.filter(r => !r.입금확인).length,
            items,
        };
    }

    function shoppingText(list) {
        if (!list.items.length) return '지금 사야 할 교재가 없습니다.';
        const head = `교재 ${list.총권수}권 (신청 ${list.건수}건)`
            + (list.미입금건수 ? `\n※ 입금 확인 안 된 건 ${list.미입금건수}건 — 이름 뒤 (미입금)` : '');
        const lines = [head, ''];
        for (const i of list.items) {
            const 미 = new Set(i.미입금);
            lines.push(`${i.교재}  ${i.권수}권`,
                `   ${i.학생들.map(s => 미.has(s) ? `${s}(미입금)` : s).join(' ')}`);
        }
        return lines.join('\n');
    }

    // ── 크론 한 바퀴 ───────────────────────────────────────────────
    async function tick() {
        const r = { 원장알림: 0, 교사알림: 0, 발송: 0, 보류: 0, 정리: 0, 실패: [] };

        // 0) 알림함 플래그 정리 — 이게 없으면 재신청이 조용히 묻힌다.
        //
        // 알림함은 "지금 상태에 대해 알렸는가"를 뜻한다. 그런데 상태가 바뀌어도 켜진 채로 남아서,
        // 승인된 건에 교재를 더 넣고 다시 '승인대기'로 돌리면 원장에게 알림이 가지 않았다.
        // 상태가 바뀐 행의 플래그를 먼저 내려서, 사람이 노션에서 손으로 상태를 바꿔도 자가 복구되게 한다.
        for (const [플래그, filter] of [
            // 승인대기가 아닌데 원장알림함이 켜져 있다 → 그 알림은 지난 상태의 것이다
            ['원장알림함', {
                and: [
                    { property: '원장알림함', checkbox: { equals: true } },
                    { property: '진행상태', select: { does_not_equal: '승인대기' } },
                ],
            }],
            // 승인됨·반려가 아닌데 교사알림함이 켜져 있다 → 마찬가지
            ['교사알림함', {
                and: [
                    { property: '교사알림함', checkbox: { equals: true } },
                    { property: '진행상태', select: { does_not_equal: '승인됨' } },
                    { property: '진행상태', select: { does_not_equal: '반려' } },
                ],
            }],
        ]) {
            for (const row of await queryFee(filter)) {
                try {
                    await patch(row.id, { [플래그]: { checkbox: false } });
                    r.정리++;
                } catch (e) { r.실패.push(`플래그정리/${row.id}: ${e.message}`); }
            }
        }

        // 1) 승인대기 → 원장에게
        for (const row of await queryFee({
            and: [{ property: '진행상태', select: { equals: '승인대기' } }, { property: '원장알림함', checkbox: { equals: false } }],
        })) {
            try {
                const 이름 = await studentName(row.학생Id);
                const { problems } = await validate(row);
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

        // 3) 승인됨 + 발송예약 → 즉시 발송 (월·목 배치를 못 기다리는 급한 건)
        for (const row of await queryFee({
            and: [{ property: '진행상태', select: { equals: '승인됨' } }, { property: '발송 예약', checkbox: { equals: true } }],
        })) {
            const res = await sendOne(row, { 개별알림: true });
            if (res.sent) r.발송++;
            else if (res.held) r.보류++;
            else if (res.error) r.실패.push(`발송/${row.id}: ${res.error}`);
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

    // 월·목을 못 기다릴 때 묶음 발송을 손으로 돌린다
    app.post('/api/textbook/send-batch', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await sendBatch()) }); }
        catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // 조교 장보기 목록
    app.get('/shopping', (req, res) => res.sendFile(path.join(publicPath, 'views', 'shopping.html')));
    app.get('/api/textbook/shopping-list', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await shoppingList()) }); }
        catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });
    // 조교 채널로 지금 목록을 밀어넣는다
    app.post('/api/textbook/shopping-push', requireAuth, async (req, res) => {
        try {
            if (!assistantConv) return res.status(400).json({ success: false, message: 'KAKAOWORK_ASSISTANT_CONV 가 없습니다' });
            const list = await shoppingList();
            await sendCard(assistantConv, '교재 장보기 목록', shoppingText(list), [{ text: '목록 열기', url: `${domainUrl}/shopping` }]);
            res.json({ success: true, ...list });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    cron.schedule('*/5 * * * *', async () => {
        try {
            const r = await tick();
            if (r.원장알림 || r.교사알림 || r.발송 || r.보류 || r.실패.length) {
                console.log(`📚 교재비: 원장알림 ${r.원장알림} / 교사알림 ${r.교사알림} / 발송 ${r.발송} / 보류 ${r.보류} / 플래그정리 ${r.정리} / 실패 ${r.실패.length}`);
                if (r.실패.length) console.error('교재비 실패 목록:', r.실패);
            }
        } catch (e) { console.error('교재비 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    // 월·목 오후 2시 묶음 발송. 은행 업무시간 안이고, 데일리 리포트(10:20)·숙제 알림(11:00)과 안 겹친다.
    cron.schedule('0 14 * * 1,4', async () => {
        try {
            const r = await sendBatch();
            console.log(`📚 교재비 묶음 발송: 대상 ${r.대상} / 발송 ${r.발송} / 보류 ${r.보류} / 실패 ${r.실패}`);
        } catch (e) { console.error('교재비 묶음 발송 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    // 화·금 오전 10시 장보기 목록. 학부모 발송(월·목 14시) **다음 날 아침**이다.
    // 하루를 두면 그사이 입금이 들어와서, 조교가 입금 상태까지 보고 사러 갈 수 있다.
    cron.schedule('0 10 * * 2,5', async () => {
        if (!assistantConv) return;
        try {
            const list = await shoppingList();
            await sendCard(assistantConv, '교재 장보기 목록', shoppingText(list), [{ text: '목록 열기', url: `${domainUrl}/shopping` }]);
            console.log(`🛒 장보기 목록 발송: 교재 ${list.총권수}권 / 신청 ${list.건수}건 / 미입금 ${list.미입금건수}건`);
        } catch (e) { console.error('장보기 목록 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    console.log('✅ 교재비 관리 모듈 로드됨 (5분 크론 + 월·목 14시 발송 + 화·금 10시 장보기)');
}
