/**
 * 보강 확정 안내 · 보강 전날 리마인더 알림톡.
 *
 * 흐름
 *   담임이 노션에서 `보강 확정일`·`보강 시간`을 채우고 상태를 `확정`으로 바꾼 뒤
 *   `확정발송`을 체크한다
 *      → 5분 크론이 잡아 학부모께 확정 알림톡 → `확정발송일시` 기록
 *      → 보강 전날 20시 크론이 리마인더 → `리마인드발송일시` 기록
 *
 * 🔴 문자를 병행하지 않는다(2026-08-10 원장 확정).
 *    알림톡이 실패해도 문자로 다시 보내지 않는다 — 학부모가 같은 얘기를 두 번 받는 게 더 나쁘다.
 *    대신 실패는 원장 카카오워크로 올려서 사람이 전화하게 한다.
 *
 * 🔴 발송 여부는 `확정발송` 체크가 아니라 `확정발송일시`로 판단한다.
 *    체크박스는 사람이 실수로 껐다 켤 수 있고, 그때마다 다시 나가면 안 된다.
 */

import crypto from 'crypto';
import cron from 'node-cron';

const PF_ID = process.env.ALIMTALK_PF_ID || 'KA01PF250113084507284jSE3GEmbOOw';
/** 카카오 심사를 통과한 뒤 렌더 환경변수에 넣는다. 없으면 발송을 건너뛴다(서버는 정상 기동). */
const TPL_확정 = process.env.ALIMTALK_TPL_MAKEUP_CONFIRM || '';
const TPL_리마인드 = process.env.ALIMTALK_TPL_MAKEUP_REMIND || '';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** KST 기준 오늘. toISOString() 은 UTC 라 새벽에 전날로 찍힌다. */
function kstDate(offsetDays = 0) {
    const now = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
    return now.toISOString().slice(0, 10);
}

/** "2026-08-22" + "오전 10시" → "8월 22일 (토) 오전 10시" */
function 보강일시(dateStr, timeStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return timeStr || '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const wd = WEEKDAY_KO[new Date(y, m - 1, d).getDay()];
    return `${m}월 ${d}일 (${wd})` + (timeStr ? ` ${timeStr}` : '');
}

export function initializeMakeupNotify({ app, fetchNotion, absenceDbId, requireAuth, notifyOwner, publicPath, path }) {
    app.get('/messages', (req, res) => res.sendFile(path.join(publicPath, 'views', 'messages.html')));

    if (!absenceDbId) { console.warn('⚠️ ABSENCE_DB_ID 없음 — 보강 확정 알림 비활성화'); return; }

    const plain = p => ((p?.rich_text || p?.title || []).map(t => t.plain_text).join('') || '').trim();

    const query = filter => fetchNotion(`https://api.notion.com/v1/databases/${absenceDbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ filter, page_size: 50 }),
    }).then(d => (d.results || []).map(page => {
        const p = page.properties || {};
        return {
            id: page.id,
            url: page.url || '',
            이름: plain(p['학생명']),
            담임: p['담임']?.select?.name || '',
            유형: p['유형']?.select?.name || '결석',
            확정일: p['보강 확정일']?.date?.start || '',
            시간: plain(p['보강 시간']),
            연락처: p['학부모 연락처']?.phone_number || '',
        };
    }));

    const patch = (id, properties) =>
        fetchNotion(`https://api.notion.com/v1/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });

    /**
     * 승인된 템플릿으로 보낸다. 변수는 #{학생명}·#{보강일시} 둘뿐이다.
     * disableSms:true — 문자 병행 금지. 실패는 던져서 호출부가 원장에게 알리게 한다.
     */
    async function sendAlimtalk(templateId, to, variables) {
        const key = process.env.SOLAPI_API_KEY, secret = process.env.SOLAPI_API_SECRET, from = process.env.SOLAPI_SENDER;
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
                message: { to: String(to).replace(/[^0-9]/g, ''), from, kakaoOptions: { pfId: PF_ID, templateId, disableSms: true, variables } },
            }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.failedMessageList?.length) {
            throw new Error(JSON.stringify(body?.failedMessageList || body).slice(0, 200));
        }
    }

    /** 보낼 수 있는 상태인지 본다. 사람이 칸을 덜 채운 채 체크만 누르는 일이 반드시 생긴다. */
    function 부족한것(row) {
        const 빈칸 = [];
        if (!row.확정일) 빈칸.push('보강 확정일');
        if (!row.시간) 빈칸.push('보강 시간');
        if (!row.연락처) 빈칸.push('학부모 연락처');
        return 빈칸;
    }

    // ── 1) 확정 알림톡 ────────────────────────────────────────────
    async function sendConfirms() {
        const r = { 보냄: 0, 막힘: [], 실패: [] };
        if (!TPL_확정) return r;

        const rows = await query({
            and: [
                { property: '상태', select: { equals: '확정' } },
                { property: '확정발송', checkbox: { equals: true } },
                { property: '확정발송일시', date: { is_empty: true } },
            ],
        });

        for (const row of rows) {
            const 빈칸 = 부족한것(row);
            if (빈칸.length) { r.막힘.push(`${row.이름}: ${빈칸.join('·')} 비어 있음`); continue; }
            try {
                await sendAlimtalk(TPL_확정, row.연락처, {
                    '#{학생명}': row.이름,
                    '#{보강일시}': 보강일시(row.확정일, row.시간),
                });
                await patch(row.id, { '확정발송일시': { date: { start: new Date().toISOString() } } });
                r.보냄++;
                console.log(`📨 보강 확정 안내: ${row.이름} → ${보강일시(row.확정일, row.시간)}`);
            } catch (e) {
                r.실패.push(`${row.이름}: ${e.message}`);
            }
        }
        return r;
    }

    // ── 2) 보강 전날 리마인더 ──────────────────────────────────────
    async function sendReminders() {
        const r = { 보냄: 0, 실패: [] };
        if (!TPL_리마인드) return r;

        const 내일 = kstDate(1);
        // 확정 안내를 받은 사람에게만 보낸다. 확정 통보도 못 받았는데 리마인더부터 오면 이상하다.
        const rows = await query({
            and: [
                { property: '보강 확정일', date: { equals: 내일 } },
                { property: '확정발송일시', date: { is_not_empty: true } },
                { property: '리마인드발송일시', date: { is_empty: true } },
            ],
        });

        for (const row of rows) {
            if (!row.연락처) { r.실패.push(`${row.이름}: 연락처 없음`); continue; }
            try {
                await sendAlimtalk(TPL_리마인드, row.연락처, {
                    '#{학생명}': row.이름,
                    '#{보강일시}': 보강일시(row.확정일, row.시간),
                });
                await patch(row.id, { '리마인드발송일시': { date: { start: new Date().toISOString() } } });
                r.보냄++;
            } catch (e) {
                r.실패.push(`${row.이름}: ${e.message}`);
            }
        }
        return r;
    }

    // ── 크론 ──────────────────────────────────────────────────────
    // 확정은 담임이 누르는 즉시 나가야 하므로 5분마다 본다.
    cron.schedule('*/5 * * * *', async () => {
        try {
            const r = await sendConfirms();
            if (r.보냄 || r.막힘.length || r.실패.length) {
                console.log(`📮 보강 확정: 보냄 ${r.보냄} / 막힘 ${r.막힘.length} / 실패 ${r.실패.length}`);
            }
            if (r.막힘.length) {
                await notifyOwner('보강 확정 발송이 막혔습니다',
                    `아래 건은 칸이 비어 있어 보내지 못했습니다.\n채우시면 5분 안에 자동으로 나갑니다.\n\n${r.막힘.join('\n')}`);
            }
            if (r.실패.length) {
                await notifyOwner('보강 확정 알림톡 실패',
                    `${r.실패.join('\n')}\n\n문자로 다시 보내지 않습니다. 직접 연락해 주세요.`);
            }
        } catch (e) { console.error('보강 확정 크론 오류:', e.message); }
    }, { timezone: 'Asia/Seoul' });

    // 전날 20시. 학부모가 퇴근 후 확인하기 좋고, 기존 크론(10:20·11:00·14:00·21:00)과 안 겹친다.
    cron.schedule('0 20 * * *', async () => {
        try {
            const r = await sendReminders();
            console.log(`⏰ 보강 전날 리마인더: 보냄 ${r.보냄} / 실패 ${r.실패.length}`);
            if (r.실패.length) await notifyOwner('보강 리마인더 실패', r.실패.join('\n'));
        } catch (e) { console.error('보강 리마인더 크론 오류:', e.message); }
    }, { timezone: 'Asia/Seoul' });

    // 수동 실행. 크론을 기다리지 않고 확인할 때 쓴다.
    app.post('/api/makeup/send-confirms', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await sendConfirms()) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/makeup/send-reminders', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await sendReminders()) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── 3) 발송함 — 실제로 나간 문구를 되읽는다 ────────────────────
    //
    // 솔라피는 변수가 치환된 최종 본문을 `text` 에 그대로 보관한다(2026-08-10 확인).
    // "우리 애한테 뭐라고 갔어요?" 라는 문의에 바로 답하려고 만들었다.
    // 🔴 학부모 연락처가 그대로 보이므로 반드시 로그인 뒤에만 연다.
    app.get('/api/messages/sent', requireAuth, async (req, res) => {
        const key = process.env.SOLAPI_API_KEY, secret = process.env.SOLAPI_API_SECRET;
        if (!key || !secret) return res.status(500).json({ error: '솔라피 설정 없음' });

        const q = String(req.query.q || '').trim();
        const 숫자만 = q.replace(/[^0-9]/g, '');
        try {
            const date = new Date().toISOString();
            const salt = crypto.randomBytes(16).toString('hex');
            const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');
            // 번호로 찾을 때는 솔라피가 걸러 주고, 이름으로 찾을 때는 최근 500건에서 본문을 뒤진다.
            const params = 숫자만.length >= 8 ? `limit=500&to=${숫자만}` : 'limit=500';
            const r = await fetch(`https://api.solapi.com/messages/v4/list?${params}`, {
                headers: { Authorization: `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}` },
            });
            if (!r.ok) throw new Error(`솔라피 ${r.status}: ${(await r.text()).slice(0, 200)}`);

            let list = Object.values((await r.json()).messageList || {}).map(m => ({
                일시: m.dateCreated,
                받는사람: m.to,
                종류: m.type === 'ATA' ? '알림톡' : '문자',
                본문: m.text || '',
                // 4000 만 실제로 도착한 것이다. 나머지는 접수는 됐어도 안 갔다.
                성공: m.statusCode === '4000',
                상태코드: m.statusCode,
                실패사유: m.statusCode === '4000' ? '' : ((m.log || []).slice(-1)[0]?.message || ''),
            }));
            if (q && 숫자만.length < 8) list = list.filter(m => m.본문.includes(q));

            res.json({ success: true, 건수: list.length, 목록: list.slice(0, 200) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    const 준비 = [TPL_확정 ? null : 'ALIMTALK_TPL_MAKEUP_CONFIRM', TPL_리마인드 ? null : 'ALIMTALK_TPL_MAKEUP_REMIND'].filter(Boolean);
    console.log(준비.length
        ? `⚠️ 보강 알림 모듈 로드됨 — ${준비.join(', ')} 없음. 템플릿 승인 후 넣으면 발송이 켜집니다`
        : '✅ 보강 알림 모듈 로드됨 (5분 확정 발송 + 전날 20시 리마인더)');
}
