/**
 * 입학(신입생) 상담 — 예약 확인 알림톡 발송.
 *
 * 원래는 노션 버튼 → Make 웹훅 → 솔라피였다. 2026-08-06 에 Make 를 끄면서 그 버튼이 죽었다.
 * 노션 버튼은 우리 서버를 직접 부를 수 없어서, 교재비에서 검증된 방식(체크박스 + 5분 크론)을 그대로 쓴다.
 *
 *   원장이 '상담 확정일'·'안내 문구'를 쓰고 '발송'을 체크
 *     → 5분 안에 알림톡 발송 → '발송 일시' 기록 → '발송' 자동 해제 → '상태'=예약확정
 *
 * 신청서가 노션에 쌓이는 것은 구글폼 응답 시트의 Apps Script 가 한다(이 파일 소관이 아니다).
 */
import crypto from 'crypto';

// 승인된 템플릿 '상담예약 안내확인'. 변수 3개 + 버튼 링크 변수 1개.
const TEMPLATE_ID = 'KA01TP250223163830368xwWO2Ze1CcQ';
const PF_ID = 'KA01PF250113084507284jSE3GEmbOOw';
// 템플릿 버튼이 'https://#{homepage}' 라서 앞의 https:// 를 빼고 넣어야 한다.
const HOMEPAGE = process.env.ACADEMY_HOMEPAGE || 'blog.naver.com/readitude';

const WD = ['일', '월', '화', '수', '목', '금', '토'];
const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

/** 노션 날짜(시간 포함 가능)를 "8월 12일 (수) 오후 3시 30분" 으로 바꾼다. */
function formatKst(iso) {
    if (!iso) return '';
    const hasTime = iso.length > 10;
    const d = new Date(hasTime ? iso : `${iso}T00:00:00+09:00`);
    const k = new Date(d.getTime() + 9 * 3600 * 1000);
    const [m, day, wd] = [k.getUTCMonth() + 1, k.getUTCDate(), WD[k.getUTCDay()]];
    let s = `${m}월 ${day}일 (${wd})`;
    if (hasTime) {
        const h = k.getUTCHours(), mi = k.getUTCMinutes();
        const ampm = h < 12 ? '오전' : '오후';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        s += ` ${ampm} ${h12}시` + (mi ? ` ${mi}분` : '');
    }
    return s;
}

export function initializeAdmissionRoutes({ app, requireAuth, fetchNotion, sendSms, cron, dbId, alertConv }) {
    const DB = dbId;
    if (!DB) { console.warn('⚠️ ADMISSION_DB_ID 없음 — 입학 상담 발송 비활성화'); return; }

    /**
     * 솔라피 알림톡. textbookFeeModule 에도 거의 같은 함수가 있다.
     * 지금 그쪽이 라이브로 나가는 중이라 건드리지 않으려고 일부러 복제했다.
     * 나중에 한 곳으로 합칠 것.
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
        if (url) blocks.push({ type: 'button', text: '노션에서 고치기', style: 'default', action_type: 'open_system_browser', value: url });

        const res = await fetch('https://api.kakaowork.com/v1/messages.send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.KAKAOWORK_APP_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: alertConv, text: `${title}\n\n${body}${url ? '\n' + url : ''}`, blocks }),
        });
        const b = await res.json().catch(() => ({}));
        if (!b?.success) throw new Error(`카카오워크: ${JSON.stringify(b).slice(0, 200)}`);
        return true;
    }

    async function tick() {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${DB}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: { property: '발송', checkbox: { equals: true } }, page_size: 50 }),
        });

        const r = { 발송: 0, 보류: 0, 실패: [] };
        for (const page of (data.results || [])) {
            const p = page.properties;
            const 이름 = plain(p['이름']);
            const 연락처 = p['학부모님 연락처']?.phone_number || '';
            const 확정일 = formatKst(p['상담 확정일']?.date?.start || '');
            const 문구 = plain(p['안내 문구']);

            // 알림톡은 변수가 비면 카카오가 거부한다. 무엇이 비었는지 알려주고 체크는 꺼 준다.
            const 빠짐 = [];
            if (!이름) 빠짐.push('이름');
            if (!연락처) 빠짐.push('학부모님 연락처');
            if (!확정일) 빠짐.push('상담 확정일');
            if (!문구) 빠짐.push('안내 문구');

            if (빠짐.length) {
                try {
                    await patch(page.id, { '발송': { checkbox: false } });
                    // 무엇이 비었는지만 알려주면 결국 노션에서 그 행을 다시 찾아야 한다. 링크를 같이 준다.
                    await notify('상담 안내 발송 보류',
                        `${이름 || '(이름없음)'}\n\n${빠짐.join(', ')}이(가) 비어 있습니다.\n채우고 '발송'을 다시 켜 주세요.`,
                        page.url);
                    r.보류++;
                } catch (e) { r.실패.push(`보류처리/${page.id}: ${e.message}`); }
                continue;
            }

            try {
                // 발송 직전에 체크를 먼저 끈다. 크론이 겹쳐도 두 번 나가지 않게.
                await patch(page.id, { '발송': { checkbox: false } });
                const 경로 = await sendAlimtalk(연락처,
                    {
                        '#{학생이름}': 이름,
                        '#{상담예약일}': 확정일,
                        '#{상담메세지}': 문구,
                        '#{homepage}': HOMEPAGE,
                    },
                    `[리디튜드] ${이름} 학부모님, 상담 예약 안내드립니다.\n\n상담 일시: ${확정일}\n${문구}\n\n${'https://' + HOMEPAGE}`);

                await patch(page.id, {
                    '발송 일시': { date: { start: new Date().toISOString() } },
                    '상태': { select: { name: '예약확정' } },
                });
                console.log(`📩 상담 예약 안내 ${경로} 발송: ${이름} (${확정일})`);
                await notify('상담 예약 안내 발송 완료', `${이름} 학부모님께 ${경로} 보냈습니다.\n\n상담 일시: ${확정일}`, page.url);
                r.발송++;
            } catch (e) {
                r.실패.push(`발송/${이름}: ${e.message}`);
                // 안 나간 것을 아무도 모르는 게 제일 나쁘다. 체크는 이미 꺼졌으니 다시 켜야 한다고 알린다.
                try {
                    await notify('🔴 상담 안내 발송 실패', `${이름} 학부모님께 보내지 못했습니다.\n\n${e.message}\n\n확인 후 '발송'을 다시 켜 주세요.`, page.url);
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
