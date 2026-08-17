// ==================================================================
// [학사일정 달력] 원장이 휴강·이벤트·보강일을 찍고, 학부모 안내 페이지와
// 결석·보강 폼이 그것을 읽어 간다.
//
// 이 모듈이 지키는 계약 (wiki/systems/absence-notice.md 참고)
//  - 🔴 저장은 "그 달을 통째로" 맞춘다. 화면에 없는 표시는 archived 된다.
//    기간 일정이 생기면서 이 "그 달"의 기준이 필요해졌다 → 시작일이 있는 달이 주인이다.
//    12월 28일~1월 3일 방학은 12월 것이고, 1월을 저장해도 지워지지 않는다.
//  - 🔴 보강일은 결석 신청 폼의 선택지다. 하루 단위·시간 메모를 그대로 둔다.
//    기간은 휴강·이벤트에만 허용한다.
//  - 🔴 시간을 '날짜' 속성에 넣지 않는다. 별도 '보강시간' rich_text.
// ==================================================================

const CALENDAR_TYPES = ['휴강', '이벤트', '보강일'];
const RANGE_TYPES = ['휴강', '이벤트'];   // 기간을 쓸 수 있는 유형

const isYm = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const monthOf = (ymd) => String(ymd || '').slice(0, 7);

function firstOfNextMonth(month) {
    const [y, m] = month.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

// 기간이 이 달에 걸치는지. 달력을 그릴 때 넘어온 일정도 보여줘야 한다.
function overlapsMonth(start, end, month) {
    const from = month + '-01';
    const to = firstOfNextMonth(month);
    return start < to && (end || start) >= from;
}

export function initializeCalendarRoutes({ app, requireAuth, fetchNotion, plainText, dbIds, invalidateNoticeCache }) {
    const NOTICE_DB_ID = dbIds?.NOTICE_DB_ID || '';

    // 공지 DB는 건수가 적다. 노션 날짜 필터가 기간 속성의 시작·종료 중 무엇을 보는지
    // 애매해서, 전부 읽어 와 JS에서 정확히 거른다. loadNotices() 도 같은 방식이다.
    async function readAllMarks() {
        const out = [];
        let cursor;
        do {
            const body = { page_size: 100 };
            if (cursor) body.start_cursor = cursor;
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${NOTICE_DB_ID}/query`, {
                method: 'POST', body: JSON.stringify(body),
            });
            (data.results || []).forEach(page => {
                const p = page.properties || {};
                const type = p['유형']?.select?.name || '';
                const start = p['날짜']?.date?.start || '';
                if (!CALENDAR_TYPES.includes(type) || !isYmd(start)) return;
                out.push({
                    id: page.id,
                    type,
                    start,
                    // 하루짜리는 노션이 end 를 비워 둔다. 화면에서는 start 와 같게 다룬다.
                    end: p['날짜']?.date?.end || start,
                    title: plainText(p['제목']),
                    time: plainText(p['보강시간']),
                });
            });
            cursor = data.has_more ? data.next_cursor : null;
        } while (cursor);
        return out;
    }

    // 한 건을 무엇으로 "같다"고 볼지. 이름이 생겼으므로 이름까지 본다.
    // 같은 날 이름이 다른 행사 두 개를 넣을 수 있어야 한다.
    const keyOf = (m) => [m.start, m.end || m.start, m.type, m.title || ''].join('|');

    app.get('/calendar', (req, res) => res.sendFile(dbIds.calendarHtmlPath));

    // 달력을 그리는 데만 쓰므로 인증을 걸지 않는다(기존과 동일).
    app.get('/api/calendar', async (req, res) => {
        const month = String(req.query.m || '');
        if (!isYm(month)) return res.status(400).json({ error: '월 형식은 YYYY-MM' });
        if (!NOTICE_DB_ID) return res.json({ marks: [], configured: false });

        try {
            const all = await readAllMarks();
            const marks = all
                .filter(m => overlapsMonth(m.start, m.end, month))
                .map(m => ({
                    ...m,
                    // 이 달이 주인인지. 아니면 화면에서 읽기 전용으로 보여 준다 —
                    // 넘어온 방학을 안 보여주면 원장이 또 찍어서 두 건이 된다.
                    owner: monthOf(m.start),
                    editable: monthOf(m.start) === month,
                }));
            res.json({ marks, configured: true });
        } catch (e) {
            console.error('달력 조회 실패:', e.message);
            res.status(502).json({ error: '노션에서 읽지 못했습니다' });
        }
    });

    // 그 달이 주인인 표시만 통째로 맞춘다. 다른 달에서 넘어온 것은 손대지 않는다.
    app.post('/api/calendar', requireAuth, async (req, res) => {
        const { month, marks } = req.body || {};
        if (!isYm(String(month || ''))) return res.status(400).json({ error: '월 형식은 YYYY-MM' });
        if (!Array.isArray(marks)) return res.status(400).json({ error: 'marks 배열이 필요합니다' });
        if (!NOTICE_DB_ID) return res.status(500).json({ error: 'NOTICE_DB_ID 미설정' });

        const wanted = [];
        for (const raw of marks) {
            const type = String(raw?.type || '');
            const start = String(raw?.start || '');
            if (!CALENDAR_TYPES.includes(type) || !isYmd(start)) continue;
            // 시작일이 이 달인 것만 이 달이 저장한다
            if (monthOf(start) !== month) continue;

            let end = String(raw?.end || start);
            if (!isYmd(end) || end < start) end = start;
            // 보강일은 결석 폼 선택지라 하루 단위를 유지한다
            if (!RANGE_TYPES.includes(type)) end = start;

            wanted.push({
                type,
                start,
                end,
                title: String(raw?.title || '').trim().slice(0, 60) || type,
                time: type === '보강일' ? String(raw?.time || '').trim().slice(0, 40) : '',
            });
        }

        try {
            const all = await readAllMarks();
            const existing = all.filter(m => monthOf(m.start) === month);

            const wantedKeys = new Set(wanted.map(keyOf));
            const byKey = new Map(existing.map(m => [keyOf(m), m]));

            // 빠진 것 지우기 (아카이브라 노션 휴지통에서 되살릴 수 있다)
            let removed = 0;
            for (const m of existing) {
                if (wantedKeys.has(keyOf(m))) continue;
                await fetchNotion(`https://api.notion.com/v1/pages/${m.id}`, {
                    method: 'PATCH', body: JSON.stringify({ archived: true }),
                });
                removed++;
            }

            // 새로 생긴 것 만들기
            let added = 0;
            for (const m of wanted) {
                if (byKey.has(keyOf(m))) continue;
                await fetchNotion('https://api.notion.com/v1/pages', {
                    method: 'POST',
                    body: JSON.stringify({
                        parent: { database_id: NOTICE_DB_ID },
                        properties: {
                            '제목': { title: [{ text: { content: m.title } }] },
                            '유형': { select: { name: m.type } },
                            // 하루짜리는 end 를 넣지 않는다. 노션에서 기간으로 보이면 헷갈린다.
                            '날짜': { date: m.end > m.start ? { start: m.start, end: m.end } : { start: m.start } },
                            '보강시간': { rich_text: m.time ? [{ text: { content: m.time } }] : [] },
                            // 세 유형 모두 학부모 안내 페이지에 보인다.
                            '게시': { checkbox: true },
                        },
                    }),
                });
                added++;
            }

            // 날짜·이름은 그대로인데 시간만 바뀐 보강일을 갱신한다.
            let retimed = 0;
            for (const m of wanted) {
                if (m.type !== '보강일') continue;
                const old = byKey.get(keyOf(m));
                if (!old || old.time === m.time) continue;
                await fetchNotion(`https://api.notion.com/v1/pages/${old.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties: { '보강시간': { rich_text: m.time ? [{ text: { content: m.time } }] : [] } } }),
                });
                retimed++;
            }

            invalidateNoticeCache?.();   // 학부모 페이지가 바로 반영되도록
            res.json({ success: true, added, removed, retimed });
        } catch (e) {
            console.error('달력 저장 실패:', e.message);
            res.status(502).json({ error: '노션에 저장하지 못했습니다' });
        }
    });
}
