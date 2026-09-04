/**
 * 데일리 리포트 — 그날 진도 행 생성 · 리포트 HTML · 학생 본인 조회 · URL 채우기.
 *
 * api/index.js 에서 통째로 옮겼다(3,821 → 3,49x줄). 코드는 한 줄도 바꾸지 않았고
 * 바깥에서 쓰던 것 15개만 주입으로 받는다. → wiki/patterns/module-di.md
 *
 * 크론 둘:
 *   10:20  그날 수강요일인 재원생의 진도 행 생성 (정지 기간이면 건너뜀)
 *   22:00  그날 진도 행에 데일리리포트URL 채우기
 */
export function initializeDailyReportRoutes(dependencies) {
    const {
        app, cron, requireAuth, fetchNotion, fs, path, publicPath,
        DOMAIN_URL, PROGRESS_DATABASE_ID,
        getKSTTodayRange, getKoreanDate, getSimpleText,
        getActivePause, readStudentConfigs, dashboardCache, parseDailyReportData,
    } = dependencies;

    let reportTemplate = '';
    try { reportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'dailyreport.html'), 'utf-8'); } 
    catch (e) { console.error('Template load error', e); }

    function getReportColor(value, type) {
        const GREEN = '#10b981'; const RED = '#ef4444'; const GRAY = '#9ca3af';
        if (value === 'N/A' || value === '없음' || value === '시험 보지 않음' || value === null || value === undefined || value === '') return GRAY;
        if (type === 'score') { const num = parseInt(value); if (isNaN(num)) return GRAY; return (num >= 80) ? GREEN : RED; }
        if (type === 'test_score') { const num = parseInt(value); if (isNaN(num)) return GRAY; if (num === 0) return GRAY; return (num >= 80) ? GREEN : RED; }
        if (type === 'result') { if (value === 'PASS') return GREEN; if (value === 'FAIL') return RED; return GRAY; }
        if (type === 'status') { if (value === '완료' || value === '완료함') return GREEN; if (value === '미완료' || value === '못함' || value === '안 해옴') return RED; return GRAY; }
        if (type === 'hw_detail') { if (value === '숙제 함') return GREEN; if (value === '안 해옴') return RED; return GRAY; }
        return GRAY;
    }

    // 어휘/주독해/부독해 숙제를 학부모 리포트·학생앱에 노출할지 스위치.
    // 2026-07-28부터 기본 켬. 교재 업데이트 검증이 끝났고, 무엇보다 이 필드는 자동 생성분만이 아니라
    // 선생님이 출결·숙제 탭에서 직접 쓴 숙제도 담기 때문에 꺼두면 수기 입력분까지 학부모에게 안 나갔다.
    // 끄려면 Render 환경변수 SHOW_GENERATED_HOMEWORK=false (코드 배포 불필요, 재시작만).
    // ※ 문법 숙제는 이 스위치와 무관하게 항상 노출됨. 생성 엔진/저장/출결탭도 스위치와 무관하게 그대로 동작.
    const SHOW_GENERATED_HOMEWORK = process.env.SHOW_GENERATED_HOMEWORK !== 'false';

    // [신규] 진도 자동화로 설정된 "다음 숙제"(문법/어휘/주독해/부독해) 섹션 행 HTML을 조립.
    // 데이터는 parseDailyReportData가 이미 읽어둠(comment.grammarTopic/grammarHomework, assignedHw.*).
    // 교재가 없거나 내용이 비면 그 과목은 자동 생략. 전부 비면 안내 문구 한 줄.
    function buildHomeworkRows(parsed) {
        const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const PLACEHOLDERS = ['없음', '숙제 내용 없음', '진도 해당 없음', '해당 없음', 'N/A'];
        const meaningful = (v) => {
            const c = (v || '').trim();
            return c && !PLACEHOLDERS.includes(c);
        };

        const rowShell = (icon, label, inner) => `
                    <div class="hw-row">
                        <span class="hw-k">${icon} ${label}</span>
                        <div class="hw-v">${inner}</div>
                    </div>`;

        const rows = [];

        // 문법: 진도(오늘 문법 진도) + 숙제 내용 두 줄
        const gTopic = parsed.comment.grammarTopic;
        const gDetail = parsed.comment.grammarHomework;
        if (meaningful(gTopic) || meaningful(gDetail)) {
            const line = (labelTxt, val) =>
                `<div class="hw-line"><span class="hw-sub">${labelTxt}</span><span>${escHtml(val.trim())}</span></div>`;
            let inner = '';
            if (meaningful(gTopic)) inner += line('진도', gTopic);
            if (meaningful(gDetail)) inner += line('숙제', gDetail);
            rows.push(rowShell('📑', '문법', inner));
        }

        // 어휘 / 주독해 / 부독해: 자동생성 숙제 내용 한 줄 (스위치가 켜졌을 때만 노출)
        if (SHOW_GENERATED_HOMEWORK) {
            const subjectRows = [
                ['📘', '어휘', parsed.assignedHw.vocab],
                ['📗', '주독해', parsed.assignedHw.mainR],
                ['📙', '부독해', parsed.assignedHw.subR],
            ];
            subjectRows.forEach(([icon, label, detail]) => {
                if (meaningful(detail)) rows.push(rowShell(icon, label, escHtml(detail.trim())));
            });
        }

        if (rows.length === 0) {
            return `<div class="hw-empty">설정된 다음 숙제가 없습니다.</div>`;
        }
        return rows.join('\n');
    }

    // 리포트 HTML 조립. forStudent=true면 dailyreport.html의 STUDENT_HIDE 마커 구간(선생님 코멘트)을 잘라냄.
    // 학부모용 /report 와 학생용 /api/my-report 가 같은 템플릿·같은 계산식을 쓰도록 하나로 뽑아둔 함수.
    function buildReportHtml(parsed, forStudent = false) {
            let html = reportTemplate;
            if (forStudent) {
                html = html.replace(/<!--\s*STUDENT_HIDE_START[\s\S]*?STUDENT_HIDE_END\s*-->/g, '');
            }
            const bookTitleStr = parsed.reading.englishBooks && parsed.reading.englishBooks.length > 0 ? parsed.reading.englishBooks.map(b => b.title).join(', ') : (parsed.reading.bookTitle || '읽은 책 없음');
        
            const formatTestScore = (val) => {
                if (val === '시험 보지 않음') return val;
                if (val === 0 || val === null) return '없음';
                const num = Number(val);
                if (!isNaN(num)) return Math.round(num) + '점'; // 공식값이 58.333… 같은 소수로 와도 정수로 반올림
                return val + '점';
            };

            // [신규] 담당 선생님 이름 추출 로직
            const teacherNameStr = parsed.teachers && parsed.teachers.length > 0 ? parsed.teachers.join(', ') : '미배정';

            const replacements = {
                '{{STUDENT_NAME}}': parsed.studentName, 
                '{{REPORT_DATE}}': getKoreanDate(parsed.date),
                '{{TEACHER_NAME}}': teacherNameStr, // [신규] 리포트 HTML에 들어갈 데이터 연동
                '{{TEACHER_COMMENT}}': parsed.comment.teacherComment.replace(/\n/g, '<br>'),
                '{{HW_SCORE}}': parsed.completionRate === null ? '없음' : parsed.completionRate + '%', '{{HW_SCORE_COLOR}}': getReportColor(parsed.completionRate, 'score'),
                '{{GRAMMAR_SCORE}}': formatTestScore(parsed.tests.grammarScore), '{{GRAMMAR_SCORE_COLOR}}': getReportColor(parsed.tests.grammarScore, 'test_score'),
                '{{VOCAB_SCORE}}': formatTestScore(parsed.tests.vocabScore), '{{VOCAB_SCORE_COLOR}}': getReportColor(parsed.tests.vocabScore, 'test_score'),
                '{{READING_TEST_STATUS}}': parsed.tests.readingResult, '{{READING_TEST_COLOR}}': getReportColor(parsed.tests.readingResult, 'result'),
                '{{LISTENING_STATUS}}': parsed.listening.study, '{{LISTENING_COLOR}}': getReportColor(parsed.listening.study, 'status'),
                '{{LISTENING_FONT_CLASS}}': (parsed.listening.study && parsed.listening.study.length > 5) ? 'text-lg' : 'text-4xl',
                '{{READING_BOOK_STATUS}}': parsed.reading.readingStatus, '{{READING_BOOK_COLOR}}': getReportColor(parsed.reading.readingStatus, 'status'),
                '{{HW_GRAMMAR_STATUS}}': parsed.homework.grammar, '{{HW_GRAMMAR_COLOR}}': getReportColor(parsed.homework.grammar, 'hw_detail'),
                '{{HW_VOCAB_STATUS}}': parsed.homework.vocabCards, '{{HW_VOCAB_COLOR}}': getReportColor(parsed.homework.vocabCards, 'hw_detail'),
                '{{HW_READING_CARD_STATUS}}': parsed.homework.readingCards, '{{HW_READING_CARD_COLOR}}': getReportColor(parsed.homework.readingCards, 'hw_detail'),
                '{{HW_SUMMARY_STATUS}}': parsed.homework.summary, '{{HW_SUMMARY_COLOR}}': getReportColor(parsed.homework.summary, 'hw_detail'),
                '{{HW_DAILY_READING_STATUS}}': parsed.homework.dailyReading, '{{HW_DAILY_READING_COLOR}}': getReportColor(parsed.homework.dailyReading, 'hw_detail'),
                '{{HW_DIARY_STATUS}}': parsed.homework.diary, '{{HW_DIARY_COLOR}}': getReportColor(parsed.homework.diary, 'hw_detail'),
                '{{HOMEWORK_ROWS}}': buildHomeworkRows(parsed),
                '{{BOOK_TITLE}}': bookTitleStr, '{{BOOK_LEVEL}}': (parsed.reading.bookAR || parsed.reading.bookLexile) ? `${parsed.reading.bookAR || 'N/A'} / ${parsed.reading.bookLexile || 'N/A'}` : 'N/A',
                '{{WRITING_STATUS}}': parsed.reading.writingStatus, '{{RD_CHECK_POINT_SCORE}}': parsed.completionRate !== null ? parsed.completionRate : '없음'
            };
        
            for (const [key, val] of Object.entries(replacements)) {
                const displayVal = (val === null || val === undefined || val === '') ? '없음' : val;
                html = html.split(key).join(displayVal);
            }
            return html;
    }

    app.get('/report', async (req, res) => {
        const { pageId } = req.query;
        if (!pageId) return res.status(400).send('Missing info');
        try {
            const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
            const parsed = await parseDailyReportData(page);
            res.send(buildReportHtml(parsed, false));
        } catch (e) { res.status(500).send('Report Error'); }
    });

    // ==================================================================
    // [학생용] 내 리포트 / 내 숙제
    // 학부모용 /report 는 pageId만 알면 누구나 열리는 공개 링크라서 학생용으로 재사용하면 안 됨.
    // 아래 API들은 전부 로그인 토큰의 이름(req.user.name)으로만 노션을 조회한다 → 남의 것 조회 불가.
    // ==================================================================

    function requireStudent(req, res, next) {
        if (req.user.role !== 'student') return res.status(403).json({ success: false, message: '학생 전용입니다' });
        next();
    }

    // 학생 본인의 진도 DB 행을 날짜 내림차순으로 가져오는 공통 조회
    async function queryMyProgressRows(studentName, { limit = 30, onOrBefore = null } = {}) {
        const conditions = [{ property: '이름', title: { equals: studentName } }];
        if (onOrBefore) conditions.push({ property: '🕐 날짜', date: { on_or_before: onOrBefore } });

        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: { and: conditions },
                sorts: [{ property: '🕐 날짜', direction: 'descending' }],
                page_size: limit
            })
        });
        return data.results;
    }

    app.get('/my-report', (req, res) => res.sendFile(path.join(publicPath, 'views', 'my-report.html')));

    // 리포트가 있는 날짜 목록 (최근 30일치) — 학생이 셀렉트박스에서 고를 수 있게
    app.get('/api/my-report-dates', requireAuth, requireStudent, async (req, res) => {
        try {
            const rows = await queryMyProgressRows(req.user.name, { limit: 30 });
            const dates = rows
                .map(p => p.properties['🕐 날짜']?.date?.start)
                .filter(Boolean);
            res.json({ success: true, studentName: req.user.name, dates });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // 학생 본인의 데일리 리포트 HTML (선생님 코멘트 섹션 제거된 버전)
    app.get('/api/my-report', requireAuth, requireStudent, async (req, res) => {
        const { date } = req.query;
        try {
            const rows = await queryMyProgressRows(req.user.name, { limit: 1, onOrBefore: date || null });
            if (rows.length === 0) return res.status(404).send('리포트가 없습니다.');

            // 날짜를 지정했는데 그 날 행이 없으면(=그 이전 행이 잡히면) 없는 걸로 처리. 엉뚱한 날짜 리포트 방지.
            const rowDate = rows[0].properties['🕐 날짜']?.date?.start;
            if (date && rowDate !== date) return res.status(404).send('그 날짜의 리포트가 없습니다.');

            const parsed = await parseDailyReportData(rows[0]);
            res.set('Cache-Control', 'no-store');
            res.send(buildReportHtml(parsed, true));
        } catch (e) { res.status(500).send('Report Error'); }
    });

    // 학생 본인에게 부여된 "다음 숙제". 오늘 수업 행이 아직 없을 수 있으므로
    // 최근 행부터 훑어서 숙제 내용이 실제로 채워진 가장 마지막 수업을 찾아 돌려준다.
    app.get('/api/my-homework', requireAuth, requireStudent, async (req, res) => {
        const PLACEHOLDERS = ['없음', '숙제 내용 없음', '진도 해당 없음', '해당 없음', 'N/A'];
        const meaningful = (v) => {
            const c = (v || '').trim();
            return !!c && !PLACEHOLDERS.includes(c);
        };

        try {
            const rows = await queryMyProgressRows(req.user.name, { limit: 10 });

            for (const row of rows) {
                const props = row.properties;
                const hw = {
                    date: props['🕐 날짜']?.date?.start || '',
                    grammarTopic: getSimpleText(props['오늘 문법 진도']),
                    grammar: getSimpleText(props['문법 숙제 내용']) || getSimpleText(props['문법 과제 내용']),
                    vocab: getSimpleText(props['어휘숙제']),
                    mainR: getSimpleText(props['주독해숙제']),
                    subR: getSimpleText(props['부독해숙제'])
                };

                // 자동생성 숙제(어휘/주독해/부독해)는 학부모 리포트와 동일한 스위치를 따른다.
                if (!SHOW_GENERATED_HOMEWORK) { hw.vocab = ''; hw.mainR = ''; hw.subR = ''; }

                const items = [];
                if (meaningful(hw.grammarTopic) || meaningful(hw.grammar)) {
                    items.push({
                        icon: '📑', subject: '문법',
                        lines: [
                            meaningful(hw.grammarTopic) ? { label: '진도', text: hw.grammarTopic.trim() } : null,
                            meaningful(hw.grammar) ? { label: '숙제', text: hw.grammar.trim() } : null
                        ].filter(Boolean)
                    });
                }
                [['📘', '어휘', hw.vocab], ['📗', '주독해', hw.mainR], ['📙', '부독해', hw.subR]].forEach(([icon, subject, detail]) => {
                    if (meaningful(detail)) items.push({ icon, subject, lines: [{ label: '숙제', text: detail.trim() }] });
                });

                if (items.length > 0) return res.json({ success: true, date: hw.date, items });
            }

            res.json({ success: true, date: null, items: [] });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    app.get('/api/admin/regenerate-urls', requireAuth, async (req, res) => {
        if (req.user.role !== 'manager') return res.status(403).json({ success: false, message: '관리자 권한이 필요합니다.' });
        const { date } = req.query; 
        if (!date) return res.status(400).json({ success: false, message: '날짜가 필요합니다.' });

        try {
            const filter = { "and": [ { property: '🕐 날짜', date: { equals: date } } ] };
            let hasMore = true; let startCursor = undefined; let processedCount = 0;

            while (hasMore) {
                const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { 
                    method: 'POST', body: JSON.stringify({ filter: filter, page_size: 100, start_cursor: startCursor }) 
                });

                for (const page of data.results) {
                    const cleanDomain = DOMAIN_URL.replace(/^https?:\/\//, '');
                    const url = `${cleanDomain}/report?pageId=${page.id}&date=${date}`;
                    if (page.properties['데일리리포트URL']?.url === url) continue;
                    await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) });
                    processedCount++;
                }
                hasMore = data.has_more; startCursor = data.next_cursor;
            }
            res.json({ success: true, message: `${date} 리포트 URL ${processedCount}개 업데이트 완료` });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    cron.schedule('0 22 * * *', async () => {
        try {
            const { start, end, dateString } = getKSTTodayRange();
            const filter = { "and": [ { property: '🕐 날짜', date: { equals: dateString } } ] };
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter }) });
            for (const page of data.results) {
                const cleanDomain = DOMAIN_URL.replace(/^https?:\/\//, '');
                const url = `${cleanDomain}/report?pageId=${page.id}&date=${dateString}`;
                if (page.properties['데일리리포트URL']?.url === url) continue;
                await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) });
            }
        } catch (e) { console.error('Cron Error', e); }
    }, { timezone: "Asia/Seoul" });

    // ------------------------------------------------------------------
    // [신규] 데일리 리포트 자동 생성 (Make 시나리오 대체)
    // 학생 명부에서 오늘 수강요일인 재원생을 골라, 학습진도 DB에
    // 이름·날짜·학생 relation만 채운 페이지를 만든다 (나머지는 롤업/수식/기본값).
    // 같은 날짜에 이미 페이지가 있는 학생은 건너뛰므로 몇 번을 실행해도 안전(멱등).
    // ------------------------------------------------------------------
    // force=true 면 정지 기간이어도 만든다(사람이 수동으로 부를 때만).
    async function generateDailyReports({ force = false } = {}) {
        const { dateString } = getKSTTodayRange();
        const todayChar = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' }).format(new Date());

        // 공휴일·학원 휴무면 진도 행을 만들지 않는다. 행이 생기면 그날 리포트가 나가고
        // 선생님 화면에도 등원한 것처럼 뜬다. 숙제 자동 생성(11시)과 같은 스위치를 본다.
        if (!force) {
            const pause = await getActivePause(dateString);
            if (pause) return { date: dateString, day: todayChar, created: [], skipped: [], paused: true, pause };
        }

        const students = (await readStudentConfigs()).filter(s => s.days.includes(todayChar));

        // 오늘 날짜로 이미 생성된 페이지의 학생 relation 수집 → 중복 생성 방지
        const existing = new Set();
        let cursor, hasMore = true;
        while (hasMore) {
            const body = { filter: { property: '🕐 날짜', date: { equals: dateString } }, page_size: 100 };
            if (cursor) body.start_cursor = cursor;
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
            for (const page of data.results) {
                (page.properties['학생 명부 관리']?.relation || []).forEach(r => existing.add(r.id));
            }
            hasMore = data.has_more; cursor = data.next_cursor;
        }

        const created = [], skipped = [];
        for (const st of students) {
            if (existing.has(st.pageId)) { skipped.push(st.name); continue; }
            await fetchNotion('https://api.notion.com/v1/pages', {
                method: 'POST',
                body: JSON.stringify({
                    parent: { database_id: PROGRESS_DATABASE_ID },
                    properties: {
                        '이름': { title: [{ text: { content: st.name } }] },
                        '🕐 날짜': { date: { start: dateString } },
                        '학생 명부 관리': { relation: [{ id: st.pageId }] }
                    }
                })
            });
            created.push(st.name);
            await new Promise(r => setTimeout(r, 350)); // Notion 초당 3요청 제한 대응
        }
        dashboardCache.dailyReport.lastFetch = 0;
        return { date: dateString, day: todayChar, created, skipped };
    }

    // 수동 실행용 (크론이 못 돌았을 때 복구 등)
    // 정지 기간이어도 사람이 직접 부르면 만든다 — 휴무를 잘못 걸어 둔 날을 복구해야 할 때가 있다.
    app.post('/api/generate-daily-reports', requireAuth, async (req, res) => {
        try {
            const result = await generateDailyReports({ force: req.body?.force === true });
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    cron.schedule('20 10 * * *', async () => {
        try {
            const r = await generateDailyReports();
            if (r.paused) { console.log(`⏸️ 데일리 리포트 생성 건너뜀(정지 기간): ${r.pause?.reason || ''}`); return; }
            console.log(`✅ 데일리 리포트 자동 생성: ${r.date}(${r.day}) 신규 ${r.created.length}명, 기존 ${r.skipped.length}명`);
        } catch (e) { console.error('데일리 리포트 생성 Cron Error', e); }
    }, { timezone: "Asia/Seoul" });
}
