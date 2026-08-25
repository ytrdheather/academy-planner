// ------------------------------------------------------------------
// 학생 프로필 — 이름을 클릭하면 그 학생의 모든 것이 한 화면에 뜬다.
//
// 지금까지 선생님이 한 학생을 파악하려면 노션 명부 · 교재비 DB · 월간 리포트를
// 따로 열어야 했다. 상담 전화를 받는 30초 안에는 못 하는 일이다.
// 이 모듈은 그 세 곳을 한 번에 읽어 하나로 합쳐 준다.
//
// 쓰기는 딱 두 가지만 연다 — 요일별 등원시각과 상담 기록.
// 나머지는 전부 읽기 전용이다. 프로필 화면에서 학생 명부를 마음대로 고치게 하면
// 숙제 자동 생성·미도착 알림이 조용히 어긋난다.
// ------------------------------------------------------------------

const DAYS = ['월', '화', '수', '목', '금', '토'];

/** 노션 rich_text/title 조각을 이어 붙인다. 서식이 걸리면 여러 조각으로 쪼개져 온다. */
const plain = (prop) => ((prop?.rich_text || prop?.title || []).map(t => t.plain_text).join(''));

export function initializeStudentProfile({
    app, requireAuth, fetchNotion, dbIds, loadTextbooks,
}) {
    const {
        STUDENT_DATABASE_ID,
        GRAMMAR_DB_ID,
        TEXTBOOK_FEE_DB_ID,
        MONTHLY_REPORT_DB_ID,
        COUNSEL_LOG_DB_ID,
    } = dbIds || {};

    if (!STUDENT_DATABASE_ID) {
        console.warn('[학생 프로필] STUDENT_DATABASE_ID 가 없어 모듈을 띄우지 않습니다.');
        return;
    }
    // 상담기록 DB 는 없어도 프로필은 뜬다. 그 칸만 "설정 필요" 로 표시된다.
    if (!COUNSEL_LOG_DB_ID) {
        console.warn('[학생 프로필] COUNSEL_LOG_DB_ID 가 없습니다. 상담 기록 칸만 비활성화됩니다.');
    }

    // ── 등원시각 드롭다운 후보 ───────────────────────────────────────
    // 노션에 이미 있는 선택지를 그대로 쓴다. 코드에 시각을 박아 두면
    // 원장님이 노션에서 선택지를 늘려도 화면에 안 나온다.
    //
    // 🔴 요일 6개를 합집합으로 합치지 마라 (2026-08-22 결정). 노션 선택 옵션은 속성마다 따로고,
    //    월수금 칸엔 14~17시만, 화목 칸엔 15~19시만 일부러 등록해 뒀다. 합치면 월요일에 19:00 을
    //    고를 수 있게 되고, 고르는 순간 노션에 없던 옵션이 새로 생겨 좁혀 놓은 게 도로 넓어진다.
    //    → wiki/systems/arrival-alert.md
    let timeOptionCache = { byDay: null, at: 0 };
    async function attendTimeOptions() {
        if (timeOptionCache.byDay && Date.now() - timeOptionCache.at < 30 * 60 * 1000) return timeOptionCache.byDay;
        const db = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}`);
        const byDay = {};
        for (const d of DAYS) {
            byDay[d] = (db.properties?.[`${d}등원`]?.select?.options || []).map(o => o.name).sort();
        }
        timeOptionCache = { byDay, at: Date.now() };
        return byDay;
    }

    /** 이름 또는 pageId 로 학생 명부 페이지 하나를 가져온다. */
    async function findStudentPage({ pageId, name }) {
        if (pageId) {
            // 화면 쪽에서 진도 DB 의 pageId 를 넘겨오는 자리가 있다. 없는 id 면 노션이 404 를 던지므로
            // 여기서 삼키고 이름 조회로 넘긴다 — 500 을 띄우는 대신.
            let page = null;
            try { page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`); } catch { /* 아래에서 이름으로 재시도 */ }
            const parentDb = page?.parent?.database_id?.replace(/-/g, '');
            if (parentDb && parentDb === STUDENT_DATABASE_ID.replace(/-/g, '')) return page;
            if (!name) return null;
        }
        if (!name) return null;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: { property: '이름', title: { equals: name } }, page_size: 2 }),
        });
        // 동명이인이면 재원생을 우선한다. 그래도 둘이면 첫 번째.
        const rows = data.results || [];
        return rows.find(r => r.properties['재원상태']?.select?.name === '재원') || rows[0] || null;
    }

    /** 노션 DB 를 끝까지 훑는다. fetchNotion 은 페이지네이션을 안 해준다. */
    async function queryAll(dbId, body = {}, cap = 300) {
        const out = [];
        let cursor;
        do {
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbId}/query`, {
                method: 'POST',
                body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
            });
            out.push(...(data.results || []));
            cursor = data.has_more && out.length < cap ? data.next_cursor : null;
        } while (cursor);
        return out;
    }

    // ── 조각별 조회 ─────────────────────────────────────────────────
    // 하나가 실패해도 나머지는 보여야 한다. 상담 전화를 받는 중에 화면이
    // 통째로 비면 아무 쓸모가 없다. 그래서 전부 allSettled 로 묶는다.

    /**
     * 반별 문법은 학생 명부에 교재 자리가 없다. 문법반 + 최근 진도로 대신한다.
     *
     * 🔴 `반이름`(select)이 아니라 제목으로 찾는다. 반 이름이 바뀌면 옛 이름만 옵션 목록에 남아
     *    노션이 쿼리를 거부한다(2026-08-25 M12B → M1B). 제목은 `{반}-{날짜}` 라 `"반-"` 로 시작을
     *    보면 된다 — 하이픈이 있어서 `M1B-` 가 `M12B-` 를 물지 않는다.
     *    대신 이름을 바꾸기 전에 쌓인 옛 이름 행은 안 잡힌다. 최근 3건만 보는 자리라 감수한다.
     */
    async function recentGrammar(className) {
        if (!GRAMMAR_DB_ID || !className) return null;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${GRAMMAR_DB_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: { property: '이름', title: { starts_with: `${className}-` } },
                sorts: [{ property: '날짜', direction: 'descending' }],
                page_size: 3,
            }),
        });
        return (data.results || []).map(p => ({
            date: p.properties['날짜']?.date?.start || '',
            progress: plain(p.properties['오늘 문법 진도']),
            homework: plain(p.properties['문법 과제 내용']),
        })).filter(r => r.date || r.progress);
    }

    /** 교재비 DB 에서 이 학생 앞으로 청구된 교재들. 관계가 안 걸린 옛 건은 제목으로 줍는다. */
    async function feeHistory(studentPageId, studentName) {
        if (!TEXTBOOK_FEE_DB_ID) return [];
        let rows = await queryAll(TEXTBOOK_FEE_DB_ID, {
            filter: { property: '학생', relation: { contains: studentPageId } },
            sorts: [{ property: '생성 일시', direction: 'descending' }],
        }, 100);
        if (!rows.length && studentName) {
            rows = await queryAll(TEXTBOOK_FEE_DB_ID, {
                filter: { property: '제목', title: { contains: studentName } },
                sorts: [{ property: '생성 일시', direction: 'descending' }],
            }, 100);
        }
        return rows.map(p => {
            const x = p.properties;
            return {
                title: plain(x['제목']),
                books: x['교재 목록']?.formula?.string || '',
                status: x['진행상태']?.select?.name || '',
                amount: x['청구 금액']?.formula?.number ?? null,
                sentAt: x['발송 일시']?.date?.start || '',
                createdAt: (x['생성 일시']?.created_time || '').slice(0, 10),
                paid: !!x['입금 확인']?.checkbox,
            };
        }).filter(r => r.books || r.title);
    }

    /** 월간 리포트. 최근 것부터. 수행율·과목 평균·AI 요약이 전부 여기 있다. */
    async function monthlyReports(studentPageId, studentName) {
        if (!MONTHLY_REPORT_DB_ID) return [];
        let rows = await queryAll(MONTHLY_REPORT_DB_ID, {
            filter: { property: '학생', relation: { contains: studentPageId } },
        }, 100);
        if (!rows.length && studentName) {
            rows = await queryAll(MONTHLY_REPORT_DB_ID, {
                filter: { property: '이름', title: { contains: studentName } },
            }, 100);
        }
        return rows.map(p => {
            const x = p.properties;
            return {
                month: plain(x['리포트 월']),
                homeworkRate: x['숙제수행율(평균)']?.number ?? null,
                vocab: x['어휘점수(평균)']?.number ?? null,
                grammar: x['문법점수(평균)']?.number ?? null,
                reading: x['독해 통과율(%)']?.number ?? null,
                bookCount: x['총 읽은 권수']?.number ?? null,
                bookList: plain(x['읽은 책 목록']),
                summary: plain(x['AI 요약']),
                url: x['월간리포트URL']?.url || '',
            };
        })
            // '리포트 월' 은 "2026-08" 형태의 텍스트라 문자열 내림차순이 곧 최신순이다
            .sort((a, b) => String(b.month).localeCompare(String(a.month)))
            .slice(0, 12);
    }

    /** 상담 기록. 날짜 내림차순. */
    async function counselLog(studentPageId, studentName) {
        if (!COUNSEL_LOG_DB_ID) return null; // null = DB 미설정 (빈 배열과 구분한다)
        // 관계가 끊긴 기록(노션에서 손으로 쓴 것)도 이름으로 줍는다.
        const or = [{ property: '학생', relation: { contains: studentPageId } }];
        if (studentName) or.push({ property: '학생명', rich_text: { equals: studentName } });
        const rows = await queryAll(COUNSEL_LOG_DB_ID, {
            filter: { or },
            sorts: [{ property: '날짜', direction: 'descending' }],
        }, 200);
        return rows.map(p => ({
            id: p.id,
            date: p.properties['날짜']?.date?.start || '',
            comment: plain(p.properties['코멘트']),
            author: plain(p.properties['작성자']),
        }));
    }

    // ── GET /api/student-profile ────────────────────────────────────
    app.get('/api/student-profile', requireAuth, async (req, res) => {
        const name = String(req.query.name || '').trim();
        const pageId = String(req.query.pageId || '').trim();
        if (!name && !pageId) return res.status(400).json({ success: false, message: '학생을 지정해 주세요' });

        try {
            const page = await findStudentPage({ pageId, name });
            if (!page) return res.status(404).json({ success: false, message: '학생 명부에서 찾지 못했습니다' });

            const p = page.properties;
            const studentName = plain(p['이름']);
            const studentPageId = page.id;
            // 🔴 학부모·학생 연락처는 원장 계정 하나에서만 내려보낸다 (2026-08-23 원장).
            //
            // 🔴 여기서 `role === 'manager'` 를 쓰면 안 된다. 이 저장소의 role 은 "원장"이 아니라
            //    "관리 권한"이라 조이쌤·주디쌤·앨리스쌤·매니져조교까지 5명이 걸린다
            //    (`api/index.js` 의 userAccounts). 원장 한 명만 거르는 기준은 loginId 다 —
            //    teacher.html 의 `owner-only-link` 도 같은 기준을 쓴다.
            const isOwner = req.user?.loginId === 'manager';

            let byId = {};
            try { byId = (await loadTextbooks()).byId || {}; } catch { /* 교재 못 읽어도 프로필은 뜬다 */ }
            const book = (key) => (p[key]?.relation || [])
                .map(r => byId[r.id])
                .filter(Boolean)
                .map(b => ({ name: b.name, subject: b.subject, totalUnits: b.totalUnits }));

            const className = p['문법반']?.select?.name || '';

            const [grammarR, feeR, monthlyR, logR, optsR] = await Promise.allSettled([
                recentGrammar(className),
                feeHistory(studentPageId, studentName),
                monthlyReports(studentPageId, studentName),
                counselLog(studentPageId, studentName),
                attendTimeOptions(),
            ]);
            const val = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);
            const failed = [];
            if (grammarR.status === 'rejected') failed.push('문법 진도');
            if (feeR.status === 'rejected') failed.push('교재비 내역');
            if (monthlyR.status === 'rejected') failed.push('월간 리포트');
            if (logR.status === 'rejected') failed.push('상담 기록');

            res.set('Cache-Control', 'no-store');
            res.json({
                success: true,
                failed,                                  // 일부만 실패했을 때 화면에 표시
                profile: {
                    pageId: studentPageId,
                    name: studentName,
                    school: p['학교']?.select?.name || '',
                    grade: p['학년']?.formula?.string || '',
                    age: p['나이']?.formula?.number ?? null,
                    enroll: p['재원상태']?.select?.name || '',
                    studyStatus: p['학습상태']?.select?.name || '',
                    subject: p['수강과목']?.select?.name || '',
                    grammarClass: className,
                    teachers: (p['담당쌤']?.multi_select || []).map(t => t.name),
                    notionUrl: page.url || '',

                    canSeeContact: isOwner,
                    parentPhone: isOwner ? (p['전화번호']?.phone_number || '') : '',
                    studentPhone: isOwner ? (p['학생 전화번호']?.phone_number || '') : '',

                    attend: {
                        days: (p['수강요일']?.multi_select || []).map(d => d.name),
                        times: Object.fromEntries(DAYS.map(d => [d, p[`${d}등원`]?.select?.name || ''])),
                        options: val(optsR, {}),      // 요일별로 다르다 — 합치지 말 것
                    },

                    books: {
                        vocab: book('어휘교재'),
                        mainReading: book('주독해교재'),
                        subReading: book('부독해교재'),
                        listening: book('영어 더빙 OR 듣기 교재'),
                        // 문법은 학생별 교재 자리가 없다 → 반 + 최근 진도로 대신한다
                        grammar: { className, recent: val(grammarR, []) || [] },
                        done: book('완료한 교재 리스트'),
                    },
                    units: {
                        vocab: p['어휘현재유닛']?.number ?? null,
                        mainReading: p['주독해현재유닛']?.number ?? null,
                        subReading: p['부독해현재유닛']?.number ?? null,
                    },

                    fees: val(feeR, []),
                    monthly: val(monthlyR, []),
                    counselLog: val(logR, []),           // null 이면 DB 미설정
                },
            });
        } catch (e) {
            console.error('[학생 프로필] 조회 실패:', e.message);
            res.status(500).json({ success: false, message: '프로필을 불러오지 못했습니다' });
        }
    });

    // ── POST /api/student-profile/attend-time ───────────────────────
    // 요일별 등원시각. 미도착 알림이 이 값을 읽으므로 프로필에서 채울 수 있게 열어 둔다.
    app.post('/api/student-profile/attend-time', requireAuth, async (req, res) => {
        const { pageId, day, time } = req.body || {};
        if (!pageId || !DAYS.includes(day)) return res.status(400).json({ success: false, message: '요일이 올바르지 않습니다' });
        const value = String(time || '').trim();
        try {
            // 🔴 그 요일에 등록된 옵션만 받는다. 노션 선택 속성은 없는 이름을 PATCH 하면 옵션을
            //    새로 만들어 버린다 — 요일별로 좁혀 놓은 드롭다운이 그렇게 다시 넓어진다.
            //    "2시" 같은 값이 들어가면 미도착 알림이 그 아이를 조용히 빼먹는다.
            if (value) {
                const allowed = (await attendTimeOptions())[day] || [];
                if (!allowed.includes(value)) {
                    return res.status(400).json({ success: false, message: `${day}요일에 없는 시각입니다 (노션에서 먼저 옵션을 추가해 주세요)` });
                }
            }
            await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties: { [`${day}등원`]: { select: value ? { name: value } : null } } }),
            });
            res.json({ success: true });
        } catch (e) {
            console.error('[학생 프로필] 등원시각 저장 실패:', e.message);
            res.status(500).json({ success: false, message: '저장하지 못했습니다' });
        }
    });

    // ── POST /api/student-profile/counsel-log ───────────────────────
    app.post('/api/student-profile/counsel-log', requireAuth, async (req, res) => {
        if (!COUNSEL_LOG_DB_ID) return res.status(503).json({ success: false, message: '상담기록 DB가 설정되지 않았습니다 (COUNSEL_LOG_DB_ID)' });
        const { pageId, studentName, date, comment } = req.body || {};
        const text = String(comment || '').trim();
        if (!pageId || !text) return res.status(400).json({ success: false, message: '상담 내용을 입력해 주세요' });

        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
        const author = req.user?.name || '';
        try {
            const created = await fetchNotion('https://api.notion.com/v1/pages', {
                method: 'POST',
                body: JSON.stringify({
                    parent: { database_id: COUNSEL_LOG_DB_ID },
                    properties: {
                        '기록': { title: [{ text: { content: `${studentName || ''} · ${day}`.trim() } }] },
                        '학생': { relation: [{ id: pageId }] },
                        '학생명': { rich_text: [{ text: { content: String(studentName || '').slice(0, 200) } }] },
                        '날짜': { date: { start: day } },
                        // 노션 rich_text 조각 하나는 2000자가 상한이다
                        '코멘트': { rich_text: [{ text: { content: text.slice(0, 2000) } }] },
                        '작성자': { rich_text: [{ text: { content: author.slice(0, 100) } }] },
                    },
                }),
            });
            console.log(`[학생 프로필] 상담 기록 추가 — ${studentName} / ${day} / ${author}`);
            res.json({ success: true, entry: { id: created.id, date: day, comment: text, author } });
        } catch (e) {
            console.error('[학생 프로필] 상담 기록 저장 실패:', e.message);
            res.status(500).json({ success: false, message: '저장하지 못했습니다' });
        }
    });

    console.log('[학생 프로필] 라우트 등록 완료' + (COUNSEL_LOG_DB_ID ? '' : ' (상담기록 DB 미설정)'));
}
