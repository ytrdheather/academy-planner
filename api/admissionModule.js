/**
 * 입학(신입생) 상담 — 예약 확인 알림톡 발송.
 *
 * 원래는 노션 버튼 → Make 웹훅 → 솔라피였다. 2026-08-06 에 Make 를 끄면서 그 버튼이 죽었다.
 * 노션 버튼은 우리 서버를 직접 부를 수 없어서, 교재비에서 검증된 방식(체크박스 + 5분 크론)을 그대로 쓴다.
 *
 *   원장이 '상담 예약일'·'💌 상담 코멘트'를 쓰고 '상담예약함'을 체크
 *     → 5분 안에 알림톡 발송 → '알림톡 발송완료' 체크 → 결과를 채널에 알림
 *
 * 대상 DB 는 `신입생 상담 관리 데이터베이스`. 속성을 새로 만들지 않고 이미 있는 칸을 그대로 쓴다.
 * (비슷한 이름의 `상담신청서 관리`(18609320…)는 7/21 에서 멈춘 옛 폼이다. 쓰지 말 것.)
 */
import crypto from 'crypto';

// 승인된 템플릿 '상담예약 안내확인'. 변수 3개 + 버튼 링크 변수 1개.
const TEMPLATE_ID = 'KA01TP250223163830368xwWO2Ze1CcQ';
const PF_ID = 'KA01PF250113084507284jSE3GEmbOOw';
// 템플릿 버튼이 'https://#{homepage}' 라서 앞의 https:// 를 빼고 넣어야 한다.
const HOMEPAGE = process.env.ACADEMY_HOMEPAGE || 'blog.naver.com/readitude';

const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

export function initializeAdmissionRoutes({ app, requireAuth, fetchNotion, sendSms, cron, dbId, alertConv }) {
    const DB = dbId;
    if (!DB) { console.warn('⚠️ ADMISSION_DB_ID 없음 — 입학 상담 발송 비활성화'); return; }

    /**
     * 솔라피 알림톡. textbookFeeModule 에도 거의 같은 함수가 있다.
     * 그쪽이 라이브로 나가는 중이라 건드리지 않으려고 일부러 복제했다. 나중에 한 곳으로 합칠 것.
     */
    async function sendAlimtalk(to, variables, fallbackText) {
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
                message: {
                    to: String(to).replace(/[^0-9]/g, ''),
                    from,
                    kakaoOptions: { pfId: PF_ID, templateId: TEMPLATE_ID, disableSms: true, variables },
                },
            }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && !body?.failedMessageList?.length) return '알림톡으로';

        console.warn('상담 알림톡 실패 → 문자 폴백:', JSON.stringify(body).slice(0, 300));
        const ok = await sendSms(to, fallbackText, '상담 예약 안내');
        if (!ok) throw new Error('알림톡·문자 모두 실패');
        return '문자로';
    }

    const patch = (id, properties) =>
        fetchNotion(`https://api.notion.com/v1/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });

    /** 카카오워크 알림. 고칠 대상이 있으면 노션 링크 버튼을 같이 달아 준다. */
    async function notify(title, body, url) {
        if (!alertConv) return false;
        const blocks = [
            { type: 'header', text: title, style: 'blue' },
            { type: 'text', text: body, markdown: false },
        ];
        if (url) blocks.push({ type: 'button', text: '노션에서 열기', style: 'default', action_type: 'open_system_browser', value: url });

        const res = await fetch('https://api.kakaowork.com/v1/messages.send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.KAKAOWORK_APP_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: alertConv, text: `${title}\n\n${body}${url ? '\n' + url : ''}`, blocks }),
        });
        const b = await res.json().catch(() => ({}));
        if (!b?.success) throw new Error(`카카오워크: ${JSON.stringify(b).slice(0, 200)}`);
        return true;
    }

    /** 폼이 채우는 칸은 `전화번호`(텍스트)다. `전화번호 1`(phone_number)은 손으로 넣는 자리라 비어 있을 때가 많다. */
    const 연락처of = p =>
        (plain(p['전화번호']) || p['전화번호 1']?.phone_number || p['전화번호 2']?.phone_number || '').trim();

    async function tick() {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${DB}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: '상담예약함', checkbox: { equals: true } },
                        // 이미 나간 건을 다시 보내지 않는다. 체크를 되돌리지 않아도 안전하도록.
                        { property: '알림톡 발송완료', checkbox: { equals: false } },
                    ],
                },
                page_size: 50,
            }),
        });

        const r = { 발송: 0, 보류: 0, 실패: [] };
        for (const page of (data.results || [])) {
            const p = page.properties;
            const 이름 = plain(p['이름']);
            const 연락처 = 연락처of(p);
            const 예약일 = plain(p['상담 예약일']);
            const 코멘트 = plain(p['💌 상담 코멘트']);

            // 알림톡은 변수가 비면 카카오가 거부한다. 무엇이 비었는지 알려주고 체크는 꺼 준다.
            const 빠짐 = [];
            if (!이름) 빠짐.push('이름');
            if (!연락처) 빠짐.push('전화번호');
            if (!예약일) 빠짐.push('상담 예약일');
            if (!코멘트) 빠짐.push('💌 상담 코멘트');

            if (빠짐.length) {
                try {
                    await patch(page.id, { '상담예약함': { checkbox: false } });
                    await notify('상담 안내 발송 보류',
                        `${이름 || '(이름없음)'}\n\n${빠짐.join(', ')}이(가) 비어 있습니다.\n채우고 '상담예약함'을 다시 켜 주세요.`,
                        page.url);
                    r.보류++;
                } catch (e) { r.실패.push(`보류처리/${page.id}: ${e.message}`); }
                continue;
            }

            try {
                // 발송 직전에 '발송완료'를 먼저 켠다. 크론이 겹쳐도 두 번 나가지 않게.
                await patch(page.id, { '알림톡 발송완료': { checkbox: true } });

                const 경로 = await sendAlimtalk(연락처,
                    {
                        '#{학생이름}': 이름,
                        '#{상담예약일}': 예약일,
                        '#{상담메세지}': 코멘트,
                        '#{homepage}': HOMEPAGE,
                    },
                    `[리디튜드] ${이름} 학부모님, 상담 예약 안내드립니다.\n\n상담 일시: ${예약일}\n${코멘트}\n\nhttps://${HOMEPAGE}`);

                console.log(`📩 상담 예약 안내 ${경로} 발송: ${이름} (${예약일})`);
                await notify('상담 예약 안내 발송 완료', `${이름} 학부모님께 ${경로} 보냈습니다.\n\n상담 일시: ${예약일}`, page.url);
                r.발송++;
            } catch (e) {
                r.실패.push(`발송/${이름}: ${e.message}`);
                // 안 나갔는데 '발송완료'가 켜져 있으면 영영 안 나간다. 되돌려 놓는다.
                try { await patch(page.id, { '알림톡 발송완료': { checkbox: false } }); } catch (_) { }
                try {
                    await notify('🔴 상담 안내 발송 실패', `${이름} 학부모님께 보내지 못했습니다.\n\n${e.message}\n\n확인 후 다시 시도해 주세요.`, page.url);
                } catch (_) { /* 실패 알림까지 실패하면 로그만 남는다 */ }
            }
        }
        return r;
    }

    app.post('/api/admission/tick', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await tick()) }); }
        catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    cron.schedule('*/5 * * * *', async () => {
        try {
            const r = await tick();
            if (r.발송 || r.보류 || r.실패.length) {
                console.log(`📩 입학 상담: 발송 ${r.발송} / 보류 ${r.보류} / 실패 ${r.실패.length}`);
                if (r.실패.length) console.error('입학 상담 실패:', r.실패);
            }
        } catch (e) { console.error('입학 상담 Cron Error', e); }
    }, { timezone: 'Asia/Seoul' });

    console.log('✅ 입학 상담 알림톡 모듈 로드됨 (5분 크론)');
}
