/**
 * 교재비 관리 — 신청 → 승인 → 알림톡 발송까지.
 * 설계 문서: docs/교재비관리-설계.md
 *
 * 주간 흐름 (2026-08-07 확정)
 *   월~목 밤 10시  선생이 노션에 신청 (진행상태=승인대기)
 *   금요일         원장이 모아서 승인
 *   금요일 21:00   학부모께 일괄 알림톡
 *   월요일 10:00   조교에게 장보기 목록
 *   월·화          조교가 서점에서 사 와 배부하고 구매완료 체크
 *
 * 5분 크론이 하는 일
 *   0) 상태와 안 맞는 알림함 플래그 정리 (없으면 재신청이 조용히 묻힌다)
 *   1) 진행상태=승인대기 & 원장알림함=false  → 원장 DM(승인/반려 버튼) → 원장알림함=true
 *   2) 진행상태=승인됨 & 발송예약=true       → 즉시 발송 (금요일을 못 기다리는 급한 건만)
 *   3) 발송중인데 30분 넘게 멈춘 행          → 원장에게 알림 (조용히 안 나가는 게 제일 나쁘다)
 *
 * 담당쌤 알림은 **평일 14시에 묶어서** 보낸다(notifyTeachers). 건별로 보내면 한 선생이
 * 하루에 대여섯 통을 받고, 그러면 알림을 닫아 버려서 정작 봐야 할 것도 안 본다.
 *
 * 중복 발송 방지가 이 모듈에서 제일 중요하다. 학부모가 입금 요청을 두 번 받으면 안 된다.
 * 그래서 발송 직전에 진행상태를 '발송중'으로 먼저 PATCH 하고, 그 PATCH 가 성공한 행만 보낸다.
 */
import crypto from 'crypto';

// 알림톡 — 이미 승인된 템플릿을 쓴다. 새로 심사받지 않는다. (설계 §5)
// 계좌번호가 템플릿 본문에 하드코딩돼 있어서 계좌가 바뀌면 재심사가 필요하다.
const ALIMTALK_PF_ID = 'KA01PF250113084507284jSE3GEmbOOw';
const ALIMTALK_TEMPLATE_ID = 'KA01TP2512261533265840etUCdm2j2f';
// 미입금 안내 템플릿. 심사를 새로 받아야 해서 ID 를 박지 않고 환경변수로 받는다.
// 없으면 학부모 발송만 건너뛰고 내부 알림(미수금 채널)은 그대로 나간다.
// 모듈 로드 시점에 상수로 굳히지 않고 보낼 때 읽는다 — 굳혀 두면 값을 넣어도 테스트·재기동 전까지 못 본다.
const unpaidTemplateId = () => process.env.ALIMTALK_TPL_TEXTBOOK_UNPAID || '';

const STUCK_MINUTES = 30;          // 발송중에서 이만큼 멈춰 있으면 사고로 본다
const TEACHER_CACHE_MS = 5 * 60 * 1000;

const won = n => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

// 제목에 박히는 날짜. toISOString() 은 UTC 라 새벽 0~9시에 전날로 찍힌다.
// (실제로 8월 5일 새벽에 "· 2026-08-04" 가 찍히는 걸 확인했다)
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * 미입금 안내를 보낼 기준(일). 안내가 나간 지 이만큼 지났는데 입금 확인이 안 되면 한 번 더 알린다.
 *
 * 🔴 이 숫자는 크론 시각과 짝이다. 따로 고치지 마라.
 *    독촉은 **월요일 11:10 주 1회**만 돈다(2026-09-04 원장 확정). 학부모 발송은 금요일 21시이므로
 *    두 번째 월요일 11시에 정확히 **9.6일**이 지난다. 여기에 10을 넣으면 그 월요일이 조용히
 *    건너뛰어지고 다음 월요일(16.6일)까지 밀린다 — 주 1회라 한 번 놓치면 일주일이 통째로 밀린다.
 *    그래서 9다. 뜻은 "발송 후 두 번째 월요일".
 *    크론을 매일로 바꾸거나 시각을 옮기면 이 숫자를 다시 계산할 것.
 */
const UNPAID_AFTER_DAYS = 9;
// 담당쌤 주간 알림이 거슬러 올라가는 범위. 주 1회 도는 알림이라 2주면 한 번 걸러도 따라잡는다.
// 이보다 오래된 건은 이미 지나간 일이라 지금 알려도 선생이 할 게 없다.
const TEACHER_LOOKBACK_DAYS = 14;

export function initializeTextbookFeeRoutes({
    app, requireAuth, fetchNotion, sendKakaoWork, sendSms,
    jwtSecret, domainUrl, dbIds, approvalConv, assistantConv, cron, publicPath, path,
    textbookConv, unpaidConv, unpaidDmUserId,
}) {
    const FEE_DB = dbIds?.TEXTBOOK_FEE_DB_ID;
    const TEACHER_DB = dbIds?.TEACHER_DB_ID;
    // 묶음 알림은 여러 건이라 특정 행이 아니라 DB 를 연다
    const FEE_DB_URL = `https://www.notion.so/${String(FEE_DB || '').replace(/-/g, '')}`;

    if (!FEE_DB) {
        console.warn('⚠️ TEXTBOOK_FEE_DB_ID 없음 — 교재비 기능 비활성화');
        return;
    }
    // 교재비 알림이 갈 자리. 원장 DM(approvalConv)에 온갖 알림이 다 모여 파묻히는 문제가 있어서
    // 교재비 전용 채널로 옮긴다(2026-09-04 원장 요청). 채널 ID 가 없으면 예전처럼 원장 DM 으로 간다 —
    // 조용히 안 나가는 것보다 낫다.
    const OWNER_CONV = textbookConv || approvalConv;
    if (!OWNER_CONV) {
        console.warn('⚠️ KAKAOWORK_TEXTBOOK_CONV / KAKAOWORK_APPROVAL_CONV 둘 다 없음 — 원장 승인 알림이 나가지 않는다');
    } else if (!textbookConv) {
        console.log('ℹ️ KAKAOWORK_TEXTBOOK_CONV 없음 — 교재비 알림은 원장 DM 으로 갑니다');
    }
    if (!unpaidConv && !unpaidDmUserId) {
        console.warn('⚠️ KAKAOWORK_UNPAID_CONV / KAKAOWORK_UNPAID_DM_USER 둘 다 없음 — 미입금 내부 알림은 교재비 자리로 갑니다');
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
        // 🔴 노션에서 이 롤업 이름이 `담당쌤` → `담임쌤` 으로 바뀐 적이 있다(2026-08-13 사고).
        //    이름이 안 맞으면 undefined 인데 예전 코드가 그걸 "담임이 지정 안 됨"과 똑같이 취급해서,
        //    담임이 멀쩡히 있는 14건의 알림이 통째로 안 나갔다. 둘 다 받아 주고,
        //    아예 없으면 `담임속성없음` 으로 구분해 "설정이 잘못됐다"고 알린다.
        const 담임롤업 = p['담임쌤'] ?? p['담당쌤'];
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
            담당쌤: (담임롤업?.rollup?.array?.[0]?.multi_select || []).map(o => o.name),
            담임속성없음: !담임롤업,
            진행상태: p['진행상태']?.select?.name || '',
            요청메모: plain(p['요청 메모']),
            반려사유: plain(p['반려 사유']),
            발송예약: !!p['발송 예약']?.checkbox,
            발송일시: p['발송 일시']?.date?.start || '',
            입금확인: !!p['입금 확인']?.checkbox,
            // 미입금 안내를 보낸 시각. 있으면 다시 안 보낸다 — 독촉을 두 번 하는 건 발송 사고에 가깝다.
            미입금안내일시: p['미입금 안내일시']?.date?.start || '',
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

    /**
     * 미입금 안내. 입금 안내가 나간 지 UNPAID_AFTER_DAYS 일이 지났는데 입금 확인이 안 된 건에 한 번만 보낸다.
     *
     * 🔴 문자 폴백을 두지 않는다. 입금 안내(위)는 안 나가는 것보다 문자가 낫지만, 독촉은 다르다 —
     *    이미 입금하신 분께 두 번 나가는 쪽이 더 나쁘고, 실패하면 사람이 보고 판단할 일이다.
     *    실패는 미수금 채널로 올라가고 다음 날 다시 시도한다(안내일시를 안 찍으므로).
     * 🔴 템플릿 ID 는 환경변수. 카카오 심사를 새로 통과한 것이어야 한다.
     */
    async function sendUnpaidAlimtalk({ 연락처, 이름, 교재이름들, 금액 }) {
        const key = process.env.SOLAPI_API_KEY;
        const secret = process.env.SOLAPI_API_SECRET;
        const from = process.env.SOLAPI_SENDER;
        if (!key || !secret || !from) throw new Error('솔라피 설정 없음');
        const templateId = unpaidTemplateId();
        if (!templateId) throw new Error('미입금 템플릿 ID 없음');

        const date = new Date().toISOString();
        const salt = crypto.randomBytes(16).toString('hex');
        const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');
        const 교재정보 = 교재이름들.join('\n');
        if (!교재정보 || !이름 || !금액) throw new Error('알림톡 변수가 비었다');

        const res = await fetch('https://api.solapi.com/messages/v4/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`,
            },
            body: JSON.stringify({
                message: {
                    to: String(연락처).replace(/[^0-9]/g, ''),
                    from,
                    kakaoOptions: {
                        pfId: ALIMTALK_PF_ID,
                        templateId,
                        disableSms: true,
                        variables: {
                            '#{학생이름}': 이름,
                            '#{교재정보}': 교재정보,
                            '#{교재비}': won(금액),
                        },
                    },
                },
            }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.failedMessageList?.length) {
            throw new Error(`미입금 알림톡 거부: ${JSON.stringify(body).slice(0, 200)}`);
        }
        return true;
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

    /**
     * 버튼 달린 메시지. 블록에 description 은 안 먹으므로 text + button 만 쓴다.
     *
     * 🔴 카카오워크 블록 한계 (2026-09-04 실측): header 20자 · button 20자 · text 500자.
     *    하나라도 넘기면 `invalid_parameter` 로 **메시지 전체가 거부된다.** 제목 한 글자 때문에
     *    알림이 통째로 안 나가는 건 이 저장소에서 제일 나쁜 실패라, 자르고서라도 내보낸다.
     *    (본문은 자르면 내용이 사라지므로 500자마다 블록을 나눈다.)
     */
    const 자르기 = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

    async function sendCard(conversationId, title, body, buttons = []) {
        const blocks = [{ type: 'header', text: 자르기(title, 20), style: 'blue' }];
        for (let i = 0; i < String(body).length; i += 500) {
            blocks.push({ type: 'text', text: String(body).slice(i, i + 500), markdown: false });
        }
        for (const b of buttons) {
            blocks.push({ type: 'button', text: 자르기(b.text, 20), style: b.style || 'default', action_type: 'open_system_browser', value: b.url });
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
        OWNER_CONV ? sendCard(OWNER_CONV, title, body, buttons) : Promise.resolve(false);

    /**
     * 미수금 알림. 채널과 이명수님 DM 두 곳에 같은 내용을 넣는다.
     * 한 곳이 실패해도 다른 곳은 나가야 한다 — 돈 얘기라 조용히 묻히면 안 된다.
     * 둘 다 설정이 없으면 교재비 자리로라도 보낸다.
     */
    async function notifyUnpaidChannels(title, body, buttons) {
        const 자리 = [];
        if (unpaidConv) 자리.push(['채널', unpaidConv]);
        if (unpaidDmUserId) {
            try { 자리.push(['DM', await openDm(unpaidDmUserId)]); }
            catch (e) { console.error('미수금 DM 열기 실패:', e.message); }
        }
        if (!자리.length) 자리.push(['교재비', OWNER_CONV]);

        const 실패 = [];
        for (const [어디, conv] of 자리) {
            if (!conv) continue;
            try { await sendCard(conv, title, body, buttons); }
            catch (e) { 실패.push(`${어디}: ${e.message}`); }
        }
        if (실패.length) console.error('미수금 알림 실패:', 실패);
        return 실패;
    }

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
     * 5분 크론(즉시 발송)과 금요일 배치가 같은 시각에 겹칠 수 있어서 세 겹으로 막는다.
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

    // ── 금요일 묶음 발송 ────────────────────────────────────────────
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

    // ── 담당쌤 알림 (평일 14시 묶음) ───────────────────────────────
    /**
     * 승인·반려 결과를 담당쌤별로 묶어 하루 한 번 보낸다.
     *
     * 건별로 보내던 것을 묶었다(2026-08-10). 한 선생이 하루에 대여섯 통씩 받으면
     * 알림을 닫아 버리고, 그러면 정작 봐야 할 것도 안 본다.
     * 승인과 반려를 한 통에 나눠 담아서 "내가 올린 것들이 어떻게 됐나"를 한눈에 본다.
     */
    /**
     * `mode` 두 가지 (2026-09-04 원장 확정 — 선생이 주 2통 넘게 받지 않게).
     *   '반려'  평일 14시. 반려는 빨리 알려야 그 주 안에 고쳐서 다시 올린다.
     *   '주간'  금요일 학부모 발송 직후. 승인된 건의 결과를 한 통에 몰아 보낸다.
     *
     * 🔴 '주간' 이 `발송완료` 까지 대상으로 잡는 이유: 예전에는 `승인됨` 만 봤는데,
     *    원장이 금요일 오후에 몰아 승인하면 14시 알림은 이미 지났고 21시에 `발송완료` 로 바뀌어
     *    그 뒤로는 영영 대상이 아니었다. 실제로 이번 주 담당쌤 알림이 통째로 안 나갔다.
     */
    async function notifyTeachers(mode = '주간') {
        const 상태 = mode === '반려' ? ['반려'] : ['승인됨', '발송중', '발송완료'];
        const 조건 = [
            { or: 상태.map(s => ({ property: '진행상태', select: { equals: s } })) },
            { property: '교사알림함', checkbox: { equals: false } },
        ];
        // 🔴 최근 것만 본다. 플래그 규칙을 바꾼 첫 회차에 **과거 행이 통째로 쓸려 나오는 것**을 막는다 —
        //    예전 규칙은 발송완료가 되는 순간 교사알림함을 내렸으므로, 지난 몇 달 치가 전부 미알림 상태다.
        //    아직 안 나간 승인 건(발송 일시가 빈 행)은 날짜로 거르면 안 되니 같이 받아 준다.
        if (mode !== '반려') {
            조건.push({
                or: [
                    { property: '발송 일시', date: { is_empty: true } },
                    { property: '발송 일시', date: { on_or_after: new Date(Date.now() - TEACHER_LOOKBACK_DAYS * 86400000).toISOString() } },
                ],
            });
        }
        const rows = await queryFee({ and: 조건 });
        const r = { mode, 선생: 0, 건수: rows.length, 실패: [] };
        if (!rows.length) return r;

        // 담당쌤 이름 → 그 선생의 건들
        const 묶음 = new Map();
        const 담임없음 = [];
        const 설정오류 = [];   // 롤업 속성 자체를 못 읽은 건. 사람 잘못이 아니라 설정 문제다.
        for (const row of rows) {
            row._이름 = await studentName(row.학생Id);
            if (row.담임속성없음) { 설정오류.push(row); continue; }
            if (!row.담당쌤.length) { 담임없음.push(row); continue; }
            for (const t of row.담당쌤) {
                if (!묶음.has(t)) 묶음.set(t, []);
                묶음.get(t).push(row);
            }
        }

        const map = await teacherMap();
        const 못보냄 = [];

        for (const [teacher, list] of 묶음) {
            const uid = map.get(teacher);
            if (!uid) { 못보냄.push(`${teacher}: ${list.map(x => x._이름).join(', ')}`); continue; }

            const 반려 = list.filter(x => x.진행상태 === '반려');
            const 승인 = list.filter(x => x.진행상태 !== '반려');
            const 나감 = 승인.filter(x => x.진행상태 === '발송완료');
            const lines = [];
            if (승인.length) {
                lines.push(`✅ 승인 ${승인.length}건`);
                for (const x of 승인) lines.push(`· ${x._이름}  ${won(x.청구금액)}\n   ${x.교재목록}`);
            }
            if (반려.length) {
                if (lines.length) lines.push('');
                lines.push(`❌ 반려 ${반려.length}건`);
                for (const x of 반려) lines.push(`· ${x._이름}\n   사유: ${x.반려사유 || '(사유 없음)'}`);
            }
            lines.push('', mode === '반려'
                ? '반려된 건은 고쳐서 다시 올려 주세요. 금요일 승인분까지 그 주에 나갑니다.'
                : 나감.length === 승인.length
                    ? '승인된 건은 방금 학부모님께 안내가 나갔습니다.'
                    : '승인된 건 중 안내가 나간 것은 학부모님께 전달됐고, 나머지는 곧 나갑니다.');

            try {
                await sendCard(await openDm(uid), `교재 변경 결과 ${list.length}건`, lines.join('\n'),
                    [{ text: '노션에서 열기', url: FEE_DB_URL }]);
                r.선생++;
            } catch (e) { r.실패.push(`${teacher}: ${e.message}`); }
        }

        // 알림이 안 간 걸 아무도 모르는 게 제일 나쁘다. 원장에게 알린다.
        if (못보냄.length || 담임없음.length || 설정오류.length) {
            const lines = [];
            if (설정오류.length) {
                lines.push('🔴 담임쌤 롤업을 읽지 못했습니다 (노션 설정 문제)',
                    '   교재비 DB 에 `담임쌤` 롤업이 있는지, 이름이 바뀌지 않았는지 확인해 주세요.',
                    '   고치면 다음 회차에 자동으로 다시 나갑니다(반려는 평일 14시, 승인은 금요일 발송 뒤).',
                    ...설정오류.map(x => `· ${x._이름}`));
            }
            if (못보냄.length) {
                if (lines.length) lines.push('');
                lines.push('카카오워크 ID 가 없어 못 보냈습니다', ...못보냄.map(s => `· ${s}`));
            }
            if (담임없음.length) {
                if (lines.length) lines.push('');
                lines.push('담당쌤이 지정돼 있지 않습니다', ...담임없음.map(x => `· ${x._이름}`));
            }
            try { await notifyOwner('교사 알림 못 보낸 건', lines.join('\n')); } catch (_) { }
        }

        // 플래그를 올린다 — 안 올리면 내일도 모레도 같은 알림이 반복된다.
        //
        // 🔴 단, 설정 오류 건은 올리지 않는다(2026-08-13). 사람이 노션 설정을 고치면 나가야 하는데,
        //    플래그가 올라가 있으면 고쳐도 영영 안 나간다. 실제로 그래서 14건이 묻혔다.
        //    "고치면 해결되는 실패"와 "사람이 손대야 끝나는 실패"를 구분해야 한다.
        const 오류Id = new Set(설정오류.map(x => x.id));
        for (const row of rows) {
            if (오류Id.has(row.id)) continue;
            try { await patch(row.id, { '교사알림함': { checkbox: true } }); }
            catch (e) { r.실패.push(`플래그/${row.id}: ${e.message}`); }
        }
        return r;
    }

    // ── 미입금 ─────────────────────────────────────────────────────
    /** 교재 이름만 따로 읽는다. `교재 목록` 수식을 쉼표로 쪼개면 이름에 쉼표가 든 교재가 잘린다. */
    async function bookNames(row) {
        const names = [];
        for (const id of row.변경교재Ids) {
            try {
                const book = await fetchNotion(`https://api.notion.com/v1/pages/${id}`);
                names.push(plain(book.properties?.['교재이름']) || '(이름없음)');
            } catch { /* 이름 하나 못 읽었다고 발송을 막지는 않는다. 아래에서 교재목록으로 폴백한다 */ }
        }
        return names;
    }

    let 템플릿경고함 = false;   // 같은 경고를 매일 도배하지 않으려고 기동당 한 번만 올린다

    /**
     * 입금 안내가 나간 지 UNPAID_AFTER_DAYS 일이 지났는데 `입금 확인` 이 안 된 건.
     * 학부모께 한 번 더 안내하고, 미수금 채널과 이명수님께 명단을 올린다.
     *
     * 🔴 한 건당 딱 한 번이다. 판정은 체크박스가 아니라 `미입금 안내일시` 타임스탬프로 한다 —
     *    체크를 껐다 켜도, 크론이 하루 두 번 돌아도 두 번 나가지 않는다.
     * 🔴 실패한 건에는 타임스탬프를 찍지 않는다. 고치면 다음 회차에 나가야 한다
     *    → wiki/pitfalls/teacher-rollup-name.md
     */
    async function notifyUnpaid() {
        const r = { 대상: 0, 발송: 0, 실패: [] };
        const 기준 = new Date(Date.now() - UNPAID_AFTER_DAYS * 86400000).toISOString();
        const rows = await queryFee({
            and: [
                { property: '진행상태', select: { equals: '발송완료' } },
                { property: '입금 확인', checkbox: { equals: false } },
                { property: '미입금 안내일시', date: { is_empty: true } },
                { property: '발송 일시', date: { on_or_before: 기준 } },
            ],
        });
        r.대상 = rows.length;
        if (!rows.length) return r;

        // 템플릿이 아직 없으면 아무것도 찍지 않고 물러난다. 심사가 끝나면 그대로 나간다.
        if (!unpaidTemplateId()) {
            r.실패.push('ALIMTALK_TPL_TEXTBOOK_UNPAID 없음 — 미입금 안내가 나가지 못했습니다');
            if (!템플릿경고함) {
                템플릿경고함 = true;
                await notifyOwner('미입금 안내가 안 나갑니다',
                    `미입금 ${rows.length}건이 기준(${UNPAID_AFTER_DAYS}일)을 넘겼는데 알림톡 템플릿 ID 가 없습니다.\n\n`
                    + 'Render 환경변수 ALIMTALK_TPL_TEXTBOOK_UNPAID 에 심사 통과한 템플릿 ID 를 넣어 주세요.\n'
                    + '넣으면 이 건들은 다음 회차에 자동으로 나갑니다(지금은 아무것도 기록하지 않았습니다).',
                    [{ text: '노션에서 열기', url: FEE_DB_URL }]).catch(() => { });
            }
            return r;
        }

        // 🔴 한 학생에 미입금 행이 둘이면 학부모는 독촉을 두 통 받는다. 실제로 첫 회차 10건 중
        //    유준서 학생이 2건이었다. "한 건으로 여러 통 받지 않는다"가 이 학원의 원칙이라
        //    학생 단위로 묶어서 한 통만 보내고, 묶인 행 전부에 안내일시를 찍는다.
        const 묶음 = new Map();
        for (const row of rows) {
            const 키 = row.학생Id || row.연락처 || row.id;
            if (!묶음.has(키)) 묶음.set(키, []);
            묶음.get(키).push(row);
        }

        const 보냄 = [], 못보냄 = [];
        for (const list of 묶음.values()) {
            const 이름 = await studentName(list[0].학생Id) || '(이름없음)';
            const 금액 = list.reduce((s, x) => s + Number(x.청구금액 || 0), 0);
            const 꼬리 = list.length > 1 ? `  (${list.length}건 합산)` : '';
            try {
                // 변수가 비면 자리표시자가 그대로 학부모 폰에 찍힌다. 번호가 없으면 아예 안 보낸다.
                const 연락처 = list.find(x => x.연락처)?.연락처;
                if (!연락처) throw new Error('학부모 연락처 없음');

                const 교재이름들 = [];
                for (const row of list) {
                    const 이름들 = await bookNames(row);
                    교재이름들.push(...(이름들.length ? 이름들 : [row.교재목록]));
                }

                await sendUnpaidAlimtalk({ 연락처, 이름, 교재이름들, 금액 });
                // 한 통으로 알렸으니 묶인 행 전부에 찍는다. 안 찍으면 내일 또 나간다.
                for (const row of list) {
                    await patch(row.id, { '미입금 안내일시': { date: { start: new Date().toISOString() } } });
                }
                보냄.push(`· ${이름}  ${won(금액)}${꼬리}`);
                r.발송++;
            } catch (e) {
                못보냄.push(`· ${이름}  ${won(금액)}${꼬리} — ${e.message}`);
                r.실패.push(`미입금/${list.map(x => x.id).join(',')}: ${e.message}`);
            }
        }

        const 합계 = rows.reduce((s, x) => s + Number(x.청구금액 || 0), 0);
        const lines = [];
        if (보냄.length) lines.push(`학부모님께 안내를 보냈습니다 ${보냄.length}건`, ...보냄);
        if (못보냄.length) {
            if (lines.length) lines.push('');
            lines.push(`🔴 못 보낸 건 ${못보냄.length}건 — 고치면 다음 회차에 다시 나갑니다`, ...못보냄);
        }
        lines.push('', `미수금 합계 ${won(합계)}`,
            `기준: 안내 발송 후 ${UNPAID_AFTER_DAYS}일이 지났는데 입금 확인이 안 된 건`,
            '입금이 확인되면 노션에서 `입금 확인` 을 체크해 주세요.');

        await notifyUnpaidChannels(`교재비 미입금 ${rows.length}건`, lines.join('\n'),
            [{ text: '노션에서 열기', url: FEE_DB_URL }]);
        return r;
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
            // 교사알림함은 "결과를 담당쌤에게 알렸는가"다. 결과가 난 뒤의 상태
            // (승인됨 → 발송중 → 발송완료, 보류 포함)에서는 **켜진 채로 둔다.**
            // 🔴 예전에는 `승인됨·반려가 아니면` 내렸는데, 금요일 21시에 발송완료로 바뀌는 순간
            //    플래그가 내려가고 상태도 대상 밖이 돼서 담당쌤 알림이 영영 안 나갔다(2026-09-04).
            //    되돌아간 상태(다시 승인이 필요한 상태)일 때만 내린다.
            ['교사알림함', {
                and: [
                    { property: '교사알림함', checkbox: { equals: true } },
                    { or: [
                        { property: '진행상태', select: { equals: '승인대기' } },
                        { property: '진행상태', select: { equals: '작성중' } },
                    ] },
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

        // 2) 담당쌤 알림은 여기서 하지 않는다. 평일 14시에 묶어서 보낸다 → notifyTeachers()
        //    건별로 보내면 선생 한 명이 하루에 대여섯 통을 받는다.

        // 3) 승인됨 + 발송예약 → 즉시 발송 (금요일 배치를 못 기다리는 급한 건)
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

    // 금요일을 못 기다릴 때 묶음 발송을 손으로 돌린다
    app.post('/api/textbook/send-batch', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await sendBatch()) }); }
        catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // 담당쌤 알림을 손으로 돌린다. ?mode=반려 면 반려 건만, 기본은 주간(승인·발송완료).
    app.post('/api/textbook/notify-teachers', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await notifyTeachers(req.query.mode === '반려' ? '반려' : '주간')) }); }
        catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // 미입금 안내를 손으로 돌린다. 크론과 같은 조건이라 두 번 눌러도 두 번 나가지 않는다.
    app.post('/api/textbook/notify-unpaid', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await notifyUnpaid()) }); }
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
            if (r.원장알림 || r.발송 || r.보류 || r.정리 || r.실패.length) {
                console.log(`📚 교재비: 원장알림 ${r.원장알림} / 발송 ${r.발송} / 보류 ${r.보류} / 플래그정리 ${r.정리} / 실패 ${r.실패.length}`);
                if (r.실패.length) console.error('교재비 실패 목록:', r.실패);
            }
        } catch (e) { console.error('교재비 Cron Error', e); }

        // 일회성 예약 발송. 5분 크론에 얹었다 — 이것 때문에 크론을 하나 더 늘리지 않는다.
        try { await runOneShot(); } catch (e) { console.error('교재비 일회성 발송 오류:', e.message); }
    }, { timezone: 'Asia/Seoul' });

    // ── 일회성 예약 발송 ───────────────────────────────────────────
    //
    // 금요일 21시를 놓쳤을 때 쓴다. 두 번 겪었다 —
    //   2026-08-07 선생 신청이 늦어 원장이 22:45 에 승인 → 배치는 이미 지나간 뒤
    //   2026-08-21 21시에 전부 `승인대기` 라 0건으로 끝남
    // 그때마다 코드를 고치는 대신 환경변수 하나로 걸 수 있게 했다.
    //
    //   TEXTBOOK_ONESHOT_AT=2026-08-23T11:05   (KST 벽시계, 분까지)
    //
    // 지정 시각부터 30분 안에 5분 크론이 잡아서 sendBatch() 를 한 번 돌린다.
    // 30분 창을 두는 이유: 배포·재시작으로 한두 틱을 놓쳐도 그날 안에 나가야 하기 때문이다.
    // 다 쓰면 환경변수를 지운다. 안 지워도 시각이 지나면 다시 안 돈다.
    const ONESHOT_AT = process.env.TEXTBOOK_ONESHOT_AT || '';
    const ONESHOT_WINDOW_MS = 30 * 60 * 1000;
    let oneshotDone = false;

    /**
     * 'YYYY-MM-DDTHH:mm' 을 **KST 벽시계**로 읽어 절대시각(ms)으로 바꾼다.
     * 🔴 맨 `new Date(문자열)` 을 쓰면 서버 시간대로 해석된다(Render 는 UTC).
     */
    function kstStampToMs(stamp) {
        const m = String(stamp).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
        if (!m) return null;
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600 * 1000;
    }

    async function runOneShot() {
        if (!ONESHOT_AT || oneshotDone) return;
        const at = kstStampToMs(ONESHOT_AT);
        if (at == null) return;   // 형식이 틀리면 조용히 넘어간다(기동 로그에서 이미 경고했다)

        const now = Date.now();
        if (now < at || now >= at + ONESHOT_WINDOW_MS) return;

        // 먼저 막아 둔다. sendBatch 가 오래 걸리면 다음 틱이 겹쳐 들어올 수 있다.
        oneshotDone = true;
        console.log(`📚 교재비 일회성 발송 시작 (예약 ${ONESHOT_AT} KST)`);
        try {
            const r = await sendBatch();
            console.log(`📚 교재비 일회성 발송: 대상 ${r.대상} / 발송 ${r.발송} / 보류 ${r.보류} / 실패 ${r.실패}`);
            // 금요일 21시 배치를 대신하는 자리다. 담당쌤 알림도 같이 따라가야 짝이 맞는다.
            await runTeacherWeekly();
        } catch (e) {
            // 실패해도 다시 시도하지 않는다. 반쯤 나간 상태에서 또 돌면 학부모가 두 번 받을 수 있다.
            console.error('교재비 일회성 발송 Cron Error', e);
            try {
                await notifyOwner('교재비 일회성 발송 실패',
                    `${e.message}\n\n자동으로 다시 시도하지 않습니다.\n노션을 확인하시고 필요하면 발송을 다시 걸어 주세요.`);
            } catch (_) { }
        }
    }

    // 금요일 밤 9시 묶음 발송.
    // 선생이 월~목 밤 10시까지 신청 → 원장이 금요일에 승인 → 금요일 밤에 학부모께 일괄 →
    // 월·화에 조교가 사 와서 배부. 주 1회로 줄이니 각자 할 일이 요일로 딱 갈린다.
    cron.schedule('0 21 * * 5', async () => {
        try {
            const r = await sendBatch();
            console.log(`📚 교재비 묶음 발송: 대상 ${r.대상} / 발송 ${r.발송} / 보류 ${r.보류} / 실패 ${r.실패}`);
        } catch (e) { console.error('교재비 묶음 발송 Cron Error', e); }

        // 학부모 발송이 끝난 뒤에 담당쌤 알림을 몰아서 보낸다(2026-09-04 원장 확정).
        // 같은 콜백 안에서 이어서 도는 이유: 크론을 하나 더 늘리지 않으면서 "발송 뒤"를 보장한다.
        // 발송이 실패해도 알림은 나가야 한다 — 선생이 결과를 모르는 게 더 나쁘다.
        try { await runTeacherWeekly(); } catch (e) { console.error('교재비 주간 교사 알림 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    async function runTeacherWeekly() {
        const r = await notifyTeachers('주간');
        if (r.건수) console.log(`📚 교재비 주간 교사 알림: ${r.건수}건 → 선생 ${r.선생}명 / 실패 ${r.실패.length}`);
        if (r.실패.length) console.error('교사 알림 실패:', r.실패);
    }

    // 평일 오후 2시 — **반려된 건만.** 반려는 빨리 알려야 선생이 그 주 안에 고쳐서 다시 올린다.
    // 승인된 건은 여기서 보내지 않는다. 금요일 학부모 발송 뒤에 한 통으로 몰아 나간다.
    cron.schedule('0 14 * * 1-5', async () => {
        try {
            const r = await notifyTeachers('반려');
            if (r.건수) console.log(`📚 교재비 반려 알림: ${r.건수}건 → 선생 ${r.선생}명 / 실패 ${r.실패.length}`);
            if (r.실패.length) console.error('교사 알림 실패:', r.실패);
        } catch (e) { console.error('교재비 반려 알림 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    // 월요일 오전 11시 10분, 1차 미입금 독촉 (2026-09-04 원장 확정).
    // 주 1회인 이유: 매일 돌면 같은 학부모에게 나가는 날만 달라질 뿐 독촉이 흩어져 관리가 안 된다.
    // 월요일인 이유: 주말을 온전히 넘기고 은행 일을 볼 수 있는 첫 평일이다.
    // 🔴 11:00 정각이 아니라 11:10 인 이유: 11:00 에 숙제 자동 생성이 95명치를 돌린다(`api/index.js`).
    //    겹치면 노션 요청이 몰린다 → wiki/entities/cron-jobs.md
    // 🔴 기준일(UNPAID_AFTER_DAYS)과 짝이다. 시각을 옮기면 그 숫자를 다시 계산할 것.
    cron.schedule('10 11 * * 1', async () => {
        try {
            const r = await notifyUnpaid();
            if (r.대상) console.log(`💸 교재비 미입금: 대상 ${r.대상} / 발송 ${r.발송} / 실패 ${r.실패.length}`);
            if (r.실패.length) console.error('미입금 안내 실패:', r.실패);
        } catch (e) { console.error('교재비 미입금 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    // 월요일 오전 10시 장보기 목록. 금요일 밤 발송 뒤 주말이 지나 입금이 들어온 상태다.
    // 조교는 월·화에 서점에서 사 오므로 월요일 아침에 목록이 손에 있어야 한다.
    cron.schedule('0 10 * * 1', async () => {
        if (!assistantConv) return;
        try {
            const list = await shoppingList();
            await sendCard(assistantConv, '교재 장보기 목록', shoppingText(list), [{ text: '목록 열기', url: `${domainUrl}/shopping` }]);
            console.log(`🛒 장보기 목록 발송: 교재 ${list.총권수}권 / 신청 ${list.건수}건 / 미입금 ${list.미입금건수}건`);
        } catch (e) { console.error('장보기 목록 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    console.log('✅ 교재비 관리 모듈 로드됨 (5분 크론 + 평일 14시 반려알림 + 평일 15시 미입금 + 금 21시 발송·교사알림 + 월 10시 장보기)');
    if (!unpaidTemplateId()) console.log('ℹ️ ALIMTALK_TPL_TEXTBOOK_UNPAID 없음 — 미입금 학부모 안내는 건너뜁니다(심사 통과 후 환경변수에 넣으면 자동으로 나갑니다)');
    // 예약을 걸어 뒀는데 조용히 안 나가는 것이 제일 나쁘다. 기동할 때 확실히 찍어 준다.
    if (ONESHOT_AT) {
        const at = kstStampToMs(ONESHOT_AT);
        if (at == null) console.error(`🔴 TEXTBOOK_ONESHOT_AT 형식이 틀렸습니다: "${ONESHOT_AT}" — 2026-08-23T11:05 처럼 적어 주세요. 일회성 발송은 돌지 않습니다`);
        else if (Date.now() >= at + ONESHOT_WINDOW_MS) console.warn(`⚠️ TEXTBOOK_ONESHOT_AT(${ONESHOT_AT} KST) 가 이미 지났습니다 — 일회성 발송은 돌지 않습니다`);
        else console.log(`⏰ 교재비 일회성 발송 예약됨: ${ONESHOT_AT} KST (이후 30분 안에 한 번)`);
    }
}
