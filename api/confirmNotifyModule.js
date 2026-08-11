/**
 * 확정 안내 알림톡 두 가지 + 보강 당일 명단 + 알림톡 발송함(`/messages`).
 *
 *   보강 확정   결석·보강 신청 DB  상태=확정      → "○월 ○일 ○시에 보강입니다"
 *   통화 확정   재원생 상담 신청 DB 상태=통화예정  → "○월 ○일 ○시에 전화드리겠습니다"
 *
 * 흐름은 둘이 같다. 담당자가 노션에서 날짜·시간을 채우고 상태를 바꾼 뒤 `확정발송`을 체크하면
 * 5분 크론이 잡아 학부모께 보내고 `확정발송일시`를 찍는다. 보강은 당일 08시에 명단도 나간다.
 *
 * 🔴 담임에게 "아직 접수 상태인 건" 같은 알림을 보내지 않는다(2026-08-10 원장 확정).
 *    보강 확정은 원장·부원장이 하는 일이라 담임이 볼 이유가 없다. 담임에게 필요한 것은
 *    ① 신청이 들어왔다는 사실(신청 즉시 채널 알림, index.js) ② 당일 누가 오는지 이 두 가지뿐이다.
 *
 * 🔴 학부모에게 나가는 것은 건마다 이 한 통뿐이다(2026-08-10 원장 확정).
 *    접수 확인과 전날 리마인더는 만들었다가 폐기했다 — 한 건으로 여러 통을 받는 것이 싫다는 판단.
 *    되살릴 일이 있으면 리마인더는 `보강 확정일 == 내일`인 행을 훑는 일간 크론이면 된다.
 *
 * 🔴 문자를 병행하지 않는다(2026-08-10 원장 확정).
 *    알림톡이 실패해도 문자로 다시 보내지 않는다 — 학부모가 같은 얘기를 두 번 받는 게 더 나쁘다.
 *    대신 실패는 카카오워크로 올려서 사람이 전화하게 한다.
 *
 * 🔴 발송 여부는 `확정발송` 체크가 아니라 `확정발송일시`로 판단한다.
 *    체크박스는 사람이 실수로 껐다 켤 수 있고, 그때마다 다시 나가면 안 된다.
 */

import crypto from 'crypto';
import cron from 'node-cron';

const PF_ID = process.env.ALIMTALK_PF_ID || 'KA01PF250113084507284jSE3GEmbOOw';
/** 카카오 심사를 통과한 뒤 렌더 환경변수에 넣는다. 없으면 그 종류만 발송을 건너뛴다(서버는 정상 기동). */
const TPL_확정 = process.env.ALIMTALK_TPL_MAKEUP_CONFIRM || '';
const TPL_통화 = process.env.ALIMTALK_TPL_COUNSEL_CONFIRM || '';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** KST 기준 오늘. toISOString() 은 UTC 라 새벽에 전날로 찍힌다. */
function kstToday() {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * `보강 희망` 텍스트에서 날짜를 뽑는다. `보강 확정일`이 비어 있는 옛 건을 위한 보조 수단이다.
 *
 * 실제로 섞여 있는 형식(2026-08-10 확인):
 *   "토요 보강 — 8월 22일 (토) 오전 10시"
 *   "8월 29일 (토) 오전 10시까지 등원해주세요."
 *   "평일 보강 (30분~1시간씩 나눠서)"        ← 날짜가 없다. null 을 준다
 *
 * 연도가 안 적혀 있으므로 오늘을 기준으로 고른다. 12월 건을 1월에 읽으면 내년으로 넘어가는데,
 * 지난 보강을 다시 띄우는 것보다 낫다(명단은 "오늘" 만 보므로 어차피 안 걸린다).
 */
function 희망에서날짜(texts) {
    const 오늘 = kstToday();
    const [ty, tm] = 오늘.split('-').map(Number);
    for (const t of texts) {
        const m = String(t).match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
        if (!m) continue;
        const mo = Number(m[1]), d = Number(m[2]);
        const y = mo < tm - 6 ? ty + 1 : ty;   // 반년 넘게 과거면 내년 것으로 본다
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return '';
}

/** "오전 10시", "오후 4시 30분" 만 뽑아낸다. 없으면 빈 문자열. */
function 희망에서시간(texts) {
    for (const t of texts) {
        const m = String(t).match(/(오전|오후)\s*\d{1,2}\s*시(\s*\d{1,2}\s*분)?/);
        if (m) return m[0].replace(/\s+/g, ' ').trim();
    }
    return '';
}

/** "2026-08-22" + "오전 10시" → "8월 22일 (토) 오전 10시" */
function 보강일시(dateStr, timeStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return timeStr || '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const wd = WEEKDAY_KO[new Date(y, m - 1, d).getDay()];
    return `${m}월 ${d}일 (${wd})` + (timeStr ? ` ${timeStr}` : '');
}

export function initializeConfirmNotify({ app, fetchNotion, absenceDbId, counselDbId, requireAuth, notifyChannel, notifyCounsel, publicPath, path }) {
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
            희망: (p['보강 희망']?.multi_select || []).map(o => o.name),
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

    // ── 1-b) 재원생 상담 통화 확정 알림톡 ──────────────────────────
    //
    // 보강 확정과 구조가 같다. 담임이 학부모와 통화 시간을 맞춘 뒤 노션에서
    // `통화 예정일`·`통화 시간`을 채우고 상태를 `통화예정`으로 바꾸고 `확정발송`을 체크한다.
    // 학부모는 "언제 전화 오나" 를 몰라 계속 기다리게 되는데, 그걸 없애는 것이 목적이다.
    async function sendCounselConfirms() {
        const r = { 보냄: 0, 막힘: [], 실패: [] };
        if (!TPL_통화 || !counselDbId) return r;

        const d = await fetchNotion(`https://api.notion.com/v1/databases/${counselDbId}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: '상태', select: { equals: '통화예정' } },
                        { property: '확정발송', checkbox: { equals: true } },
                        { property: '확정발송일시', date: { is_empty: true } },
                    ],
                },
                page_size: 50,
            }),
        });

        for (const page of d.results || []) {
            const p = page.properties || {};
            const row = {
                id: page.id,
                이름: plain(p['학생명']),
                담임: p['담임']?.select?.name || '',
                예정일: p['통화 예정일']?.date?.start || '',
                시간: plain(p['통화 시간']),
                연락처: p['학부모 연락처']?.phone_number || '',
            };

            const 빈칸 = [];
            if (!row.예정일) 빈칸.push('통화 예정일');
            if (!row.시간) 빈칸.push('통화 시간');
            if (!row.연락처) 빈칸.push('학부모 연락처');
            if (빈칸.length) { r.막힘.push(`${row.이름}: ${빈칸.join('·')} 비어 있음`); continue; }

            const 일시 = 보강일시(row.예정일, row.시간);
            try {
                await sendAlimtalk(TPL_통화, row.연락처, {
                    '#{학생명}': row.이름,
                    '#{담당쌤}': row.담임 && row.담임 !== '미지정' ? row.담임 : '담임 선생님',
                    '#{통화일시}': 일시,
                });
                await fetchNotion(`https://api.notion.com/v1/pages/${row.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties: { '확정발송일시': { date: { start: new Date().toISOString() } } } }),
                });
                r.보냄++;
                console.log(`📞 통화 확정 안내: ${row.이름} → ${일시}`);
            } catch (e) {
                r.실패.push(`${row.이름}: ${e.message}`);
            }
        }
        return r;
    }

    // ── 2) 보강 당일 아침 명단 ─────────────────────────────────────
    //
    // 담임이 그날 출근해서 "누가 오나"만 알면 되는 자리다. 신청 알림은 신청 순간 한 번 울리고
    // 끝이라 그때 못 보면 다시 알려 주는 게 없다. 그래서 당일 아침에 한 번 더 모아 준다.
    //
    // 🔴 0명이면 보내지 않는다. 매일 아침 "0명"이 오면 그 채널을 통째로 무시하게 된다.
    async function roster(dateStr) {
        const 오늘 = dateStr || kstToday();
        // 확정된 것만. 접수·조율중은 아직 날짜가 안 정해진 것이고, 완료는 이미 끝난 것이다.
        const rows = await query({ property: '상태', select: { equals: '확정' } });

        const 대상 = [];
        for (const row of rows) {
            // `보강 확정일`이 정답이다. 비어 있는 옛 건만 `보강 희망` 텍스트에서 날짜를 읽는다.
            const 날짜 = row.확정일 || 희망에서날짜(row.희망);
            if (날짜 !== 오늘) continue;
            대상.push({ ...row, 시간: row.시간 || 희망에서시간(row.희망), 추정: !row.확정일 });
        }
        return { 날짜: 오늘, 명단: 대상 };
    }

    async function sendRoster(dateStr) {
        const { 날짜, 명단 } = await roster(dateStr);
        if (!명단.length) return { 날짜, 인원: 0, 보냄: false };

        // 시간이 다 같으면 제목에 한 번만 쓴다. 다르면 사람마다 붙인다.
        const 시간들 = [...new Set(명단.map(x => x.시간).filter(Boolean))];
        const 공통시간 = 시간들.length === 1 ? 시간들[0] : '';

        const lines = [];
        for (const x of 명단) {
            const 꼬리 = !공통시간 && x.시간 ? `  ${x.시간}` : '';
            lines.push(`· ${x.이름} (${x.담임 || '담임 미지정'})${꼬리}`);
        }
        lines.push('', `총 ${명단.length}명`);
        // 날짜를 텍스트에서 읽어 온 건은 담임이 노션에서 확인할 수 있게 표시해 둔다.
        const 추정 = 명단.filter(x => x.추정).length;
        if (추정) lines.push(`※ ${추정}명은 보강 확정일 칸이 비어 있어 신청 내용에서 읽었습니다.`);

        await notifyChannel(`${보강일시(날짜, 공통시간)} 보강 명단`, lines.join('\n'));
        return { 날짜, 인원: 명단.length, 보냄: true };
    }

    // ── 크론 ──────────────────────────────────────────────────────
    /** 막힘·실패를 해당 채널에 알린다. 둘 다 사람이 손대야 끝나는 일이라 조용히 넘기지 않는다. */
    async function 보고(알림, 무엇, r) {
        if (r.보냄 || r.막힘.length || r.실패.length) {
            console.log(`📮 ${무엇}: 보냄 ${r.보냄} / 막힘 ${r.막힘.length} / 실패 ${r.실패.length}`);
        }
        if (r.막힘.length) {
            await 알림(`${무엇} 발송이 막혔습니다`,
                `아래 건은 칸이 비어 있어 보내지 못했습니다.\n채우시면 5분 안에 자동으로 나갑니다.\n\n${r.막힘.join('\n')}`);
        }
        if (r.실패.length) {
            await 알림(`${무엇} 알림톡 실패`,
                `${r.실패.join('\n')}\n\n문자로 다시 보내지 않습니다. 직접 연락해 주세요.`);
        }
    }

    // 확정은 담당자가 누르는 즉시 나가야 하므로 5분마다 본다.
    // 두 종류를 한 크론에서 돌린다 — 노션 호출 몇 개 차이라 따로 돌릴 이유가 없다.
    cron.schedule('*/5 * * * *', async () => {
        try { await 보고(notifyChannel, '보강 확정', await sendConfirms()); }
        catch (e) { console.error('보강 확정 크론 오류:', e.message); }
        try { await 보고(notifyCounsel || notifyChannel, '통화 확정', await sendCounselConfirms()); }
        catch (e) { console.error('통화 확정 크론 오류:', e.message); }
    }, { timezone: 'Asia/Seoul' });

    // 보강 당일 아침 8시. 보강은 보통 오전 10시라 출근 전에 손에 들어온다.
    // 매일 돌지만 그날 보강이 없으면 아무것도 안 보내므로 조용하다.
    cron.schedule('0 8 * * *', async () => {
        try {
            const r = await sendRoster();
            if (r.보냄) console.log(`📋 보강 명단 발송: ${r.날짜} ${r.인원}명`);
        } catch (e) { console.error('보강 명단 크론 오류:', e.message); }
    }, { timezone: 'Asia/Seoul' });

    // 수동 실행. 크론을 기다리지 않고 확인할 때 쓴다.
    app.post('/api/makeup/send-confirms', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await sendConfirms()) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/counsel/send-confirms', requireAuth, async (req, res) => {
        try { res.json({ success: true, ...(await sendCounselConfirms()) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    // ?date=2026-08-22 로 특정 날짜를 볼 수 있다. ?dry=1 이면 보내지 않고 명단만 돌려준다.
    app.post('/api/makeup/roster', requireAuth, async (req, res) => {
        try {
            const date = String(req.query.date || '').trim() || undefined;
            if (req.query.dry) return res.json({ success: true, ...(await roster(date)) });
            res.json({ success: true, ...(await sendRoster(date)) });
        } catch (e) { res.status(500).json({ error: e.message }); }
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

    const 없는템플릿 = [
        TPL_확정 ? null : 'ALIMTALK_TPL_MAKEUP_CONFIRM',
        TPL_통화 ? null : 'ALIMTALK_TPL_COUNSEL_CONFIRM',
    ].filter(Boolean);
    console.log(없는템플릿.length
        ? `⚠️ 확정 알림 모듈 로드됨 — ${없는템플릿.join(', ')} 없음. 그 발송만 꺼져 있고 08시 보강 명단·발송함은 됩니다`
        : '✅ 확정 알림 모듈 로드됨 (5분 확정 발송 2종 + 08시 보강 명단 + 발송함 /messages)');
}
