import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

// ----------------------------------------------------------------------
// [ 헬퍼 함수 ]
// 이 모듈은 독립적으로 작동하며, 필요한 헬퍼 함수를 주입(injection)받습니다.
// ----------------------------------------------------------------------
let fetchNotion;
let geminiModel;
let dbIds;
let domainUrl;
let publicPath;
let getRollupValue;
let getSimpleText;
let getKSTTodayRange;
let getKoreanDate;

/**
 * 월간 리포트 통계 전용 파서
 * (index.js에서 이동)
 */
async function parseMonthlyStatsData(page) {
    const props = page.properties;

    // 1. 숙제 수행율 (0점 포함)
    const performanceRateString = props['수행율']?.formula?.string || '0%';
    const completionRate = parseFloat(performanceRateString.replace('%', '')) || 0; // 0%도 0으로 포함

    // 2. 시험 점수 (0점 제외 로직은 API 호출부에서 .filter()로 처리)
    const vocabScoreString = props['📰 단어 테스트 점수']?.formula?.string || 'N/A';
    const vocabScore = (vocabScoreString === 'N/A') ? 'N/A' : (parseFloat(vocabScoreString) || 0); // 0점은 0으로. N/A는 N/A로.

    const grammarScoreString = props['📑 문법 시험 점수']?.formula?.string || 'N/A';
    const grammarScore = (grammarScoreString === 'N/A') ? 'N/A' : (parseFloat(grammarScoreString) || 0);

    const readingResult = props['📚 독해 해석 시험 결과']?.formula?.string || 'N/A'; // 'PASS', 'FAIL', 'N/A'

    // 3. 총 읽은 권수
    const bookTitle = getRollupValue(props['📖 책제목 (롤업)']) || '읽은 책 없음';

    // 4. 일일 코멘트 (AI 요약용)
    const teacherComment = getSimpleText(props['❤ Today\'s Notice!']) || '';

    // 5. 날짜
    const pageDate = props['🕐 날짜']?.date?.start || '';

    return {
        completionRate: (completionRate === null) ? null : Math.round(completionRate),
        vocabScore: vocabScore,
        grammarScore: grammarScore,
        readingResult: readingResult,
        bookTitle: bookTitle,
        teacherComment: teacherComment,
        date: pageDate
    };
}

/**
 * 월간 리포트 HTML 렌더링 헬퍼
 * (index.js에서 이동)
 */
function renderMonthlyReportHTML(res, template, studentName, month, stats, monthPages, attendanceDays) {
    const [year, monthNum] = month.split('-').map(Number);
    const firstDay = new Date(year, monthNum - 1, 1).toISOString().split('T')[0];
    const lastDay = new Date(year, monthNum, 0).toISOString().split('T')[0];
    const totalDaysInMonth = new Date(year, monthNum, 0).getDate(); // 해당 월의 총 일수

    // 독서 목록 (중복 제거)
    const bookSet = new Set();
    const bookListHtml = monthPages
        .map(p => p.bookTitle)
        .filter(title => title && title !== '읽은 책 없음')
        .map(title => {
            const bookKey = title;
            return { key: bookKey, title: title };
        })
        .filter(book => {
            if (bookSet.has(book.key)) return false;
            bookSet.add(book.key);
            return true;
        })
        .map(book => {
            return `<li>${book.title}</li>`;
        })
        .join('\n') || '<li class="text-gray-500 font-normal">이번 달에 읽은 원서가 없습니다.</li>';

    // RT-Check Point (숙제 점수) 및 경고/칭찬 메시지
    const hwScore = Math.round(stats.hwAvg);
    const rtNotice = {};
    if (hwScore < 70) {
        rtNotice.bgColor = 'bg-red-50'; // 빨간색 배경
        rtNotice.borderColor = 'border-red-400';
        rtNotice.titleColor = 'text-red-900';
        rtNotice.textColor = 'text-red-800';
        rtNotice.title = ' RT-Check Point 경고';
    } else {
        rtNotice.bgColor = 'bg-green-50'; // 초록색 배경
        rtNotice.borderColor = 'border-green-400';
        rtNotice.titleColor = 'text-green-900';
        rtNotice.textColor = 'text-green-800';
        rtNotice.title = ' RT-Check Point 칭찬';
    }

    // 테스트 점수 색상
    const vocabScoreColor = (stats.vocabAvg < 80) ? 'text-red-600' : 'text-teal-600';
    const grammarScoreColor = (stats.grammarAvg < 80) ? 'text-red-600' : 'text-teal-600';
    const readingPassRateColor = (stats.readingPassRate < 80) ? 'text-red-600' : 'text-teal-600';

    const replacements = {
        '{{STUDENT_NAME}}': studentName,
        '{{REPORT_MONTH}}': `${year}년 ${monthNum}월`,
        '{{START_DATE}}': firstDay,
        '{{END_DATE}}': lastDay,

        // RT-Check Point (숙제)
        '{{HW_AVG_SCORE}}': hwScore,
        '{{HW_SCORE_COLOR}}': (hwScore < 70) ? 'text-red-600' : 'text-teal-600',
        '{{RT_NOTICE_BG_COLOR}}': rtNotice.bgColor,
        '{{RT_NOTICE_BORDER_COLOR}}': rtNotice.borderColor,
        '{{RT_NOTICE_TITLE_COLOR}}': rtNotice.titleColor,
        '{{RT_NOTICE_TEXT_COLOR}}': rtNotice.textColor,
        '{{RT_NOTICE_TITLE}}': rtNotice.title,

        // AI 요약
        '{{AI_SUMMARY}}': stats.aiSummary.replace(/\n/g, '<br>'),

        // 월간 통계
        '{{ATTENDANCE_DAYS}}': attendanceDays,
        '{{TOTAL_DAYS_IN_MONTH}}': totalDaysInMonth,
        '{{VOCAB_AVG_SCORE}}': Math.round(stats.vocabAvg),
        '{{VOCAB_SCORE_COLOR}}': vocabScoreColor,
        '{{GRAMMAR_AVG_SCORE}}': Math.round(stats.grammarAvg),
        '{{GRAMMAR_SCORE_COLOR}}': grammarScoreColor,
        '{{READING_PASS_RATE}}': Math.round(stats.readingPassRate),
        '{{READING_PASS_RATE_COLOR}}': readingPassRateColor,
        '{{TOTAL_BOOKS_READ}}': stats.totalBooks,

        // 독서 목록
        '{{BOOK_LIST_HTML}}': bookListHtml,
    };

    let html = template.replace(new RegExp(Object.keys(replacements).join('|'), 'g'), (match) => {
        return replacements[match];
    });

    // --- [수정] 10월 리포트 수동 생성용 임시 API ---
    // 이제 URL 쿼리 파라미터로 학생 이름과 월을 받습니다.
    // 예: /api/manual-monthly-report-gen?studentName=유환호&month=2025-10
    app.get('/api/manual-monthly-report-gen', async (req, res) => {
        console.log('--- [수동 월간 리포트] 생성 요청 받음 ---');
        
        const { studentName, month } = req.query;

        if (!studentName || !month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ 
                success: false, 
                message: "오류: 'studentName'과 'month' (YYYY-MM 형식) 쿼리 파라미터가 필요합니다. (예: ?studentName=유환호&month=2025-10)" 
            });
        }
        
        const targetStudentName = studentName; // 동적
        const monthString = month; // 동적

        console.log(`[수동 월간 리포트] 타겟 학생: ${targetStudentName}`);
        console.log(`[수동 월간 리포트] ${monthString}월 리포트 생성을 시작합니다.`);

        if (!fetchNotion || !dbIds.STUDENT_DATABASE_ID || !dbIds.PROGRESS_DATABASE_ID || !dbIds.MONTHLY_REPORT_DB_ID || !geminiModel) {
            console.error('[수동 월간 리포트] DB ID 또는 Gemini AI가 설정되지 않아 스케줄을 중단합니다.');
            return res.status(500).json({ success: false, message: '서버 환경변수(DB, AI)가 설정되지 않았습니다.' });
        }

        try {
            const studentQueryFilter = {
                property: '이름',
                title: { equals: targetStudentName }
            };

            const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter: studentQueryFilter })
            });

            const students = studentData.results;
            console.log(`[수동 월간 리포트] 총 ${students.length}명의 학생을 대상으로 통계를 시작합니다.`);

            // [수정] 날짜 로직을 쿼리에서 가져옴
            const [currentYear, currentMonthNum] = monthString.split('-').map(Number);
            const currentMonth = currentMonthNum - 1; // (JS month는 0부터 시작)

            const firstDayOfMonth = new Date(currentYear, currentMonth, 1).toISOString().split('T')[0];
            const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).toISOString().split('T')[0];

            let successCount = 0;
            let failCount = 0;

            for (const student of students) {
                const studentPageId = student.id;
                const studentName = student.properties['이름']?.title?.[0]?.plain_text;
                if (!studentName) continue;

                try {
                    console.log(`[수동 월간 리포트] ${studentName} 학생 통계 계산 중...`);

                    const progressData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.PROGRESS_DATABASE_ID}/query`, {
                        method: 'POST',
                        body: JSON.stringify({
                            filter: {
                                and: [
                                    { property: '이름', title: { equals: studentName } },
                                    { property: '🕐 날짜', date: { on_or_after: firstDayOfMonth } },
                                    { property: '🕐 날짜', date: { on_or_before: lastDayOfMonth } }
                                ]
                            }
                        })
                    });

                    // [기능 분리] 월간 리포트는 '데일리' 파서가 아닌 '통계' 파서를 사용합니다.
                    const monthPages = await Promise.all(progressData.results.map(parseMonthlyStatsData));

                    if (monthPages.length === 0) {
                        console.log(`[수동 월간 리포트] ${studentName} 학생은 ${monthString}월 데이터가 없습니다. (스킵)`);
                        continue;
                    }

                    // [최종 통계 로직] 헤더님 요청 로직 적용 (숙제 0점 포함, 시험 0점 제외)
                    const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
                    const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
                    const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
                    const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');

                    const bookTitles = [...new Set(monthPages.map(p => p.bookTitle).filter(t => t && t !== '읽은 책 없음'))];
                    const comments = monthPages.map((p, i) => `[${p.date}] ${p.teacherComment}`).filter(c => c.trim() !== '[]').join('\n');

                    const stats = {
                        hwAvg: hwRates.length > 0 ? Math.round(hwRates.reduce((a, b) => a + b, 0) / hwRates.length) : 0,
                        vocabAvg: vocabScores.length > 0 ? Math.round(vocabScores.reduce((a, b) => a + b, 0) / vocabScores.length) : 0,
                        grammarAvg: grammarScores.length > 0 ? Math.round(grammarScores.reduce((a, b) => a + b, 0) / grammarScores.length) : 0,
                        readingPassRate: readingResults.length > 0 ? Math.round(readingResults.filter(r => r === 'PASS').length / readingResults.length * 100) : 0,
                        totalBooks: bookTitles.length,
                        bookList: bookTitles.join(', ') || '읽은 책 없음'
                    };

                    let aiSummary = 'AI 요약 기능을 사용할 수 없습니다.';
                    if (geminiModel) {
                        try {
                            let shortName = studentName;
                            if (studentName.startsWith('Test ')) {
                                shortName = studentName.substring(5);
                            } else if (studentName.length === 3 && !studentName.includes(' ')) {
                                shortName = studentName.substring(1); // "유환호" -> "환호"
                            }

                            // [AI 가이드라인 수정] 헤더님 최신 가이드라인 반영 (조사 수정)
                            let studentNameParticle = '이는';
                            let studentNameParticle2 = '이가';

                            try {
                                // 한글 이름의 마지막 글자 받침 여부 확인
                                const lastChar = shortName.charCodeAt(shortName.length - 1);
                                // 한글 범위 (가: 44032, 힣: 55203)
                                if (lastChar >= 44032 && lastChar <= 55203) {
                                    const jongseong = (lastChar - 44032) % 28;
                                    if (jongseong > 0) { // 받침 있음
                                        studentNameParticle = '이는';
                                        studentNameParticle2 = '이가';
                                    } else { // 받침 없음
                                        studentNameParticle = '는';
                                        studentNameParticle2 = '가';
                                    }
                                }
                            } catch (e) { /* 이름이 한글이 아니거나 예외 발생 시 기본값 사용 */ }


                            const prompt = `
너는 '리디튜드' 학원의 선생님이야. 지금부터 너는 학생의 학부모님께 보낼 월간 리포트 총평을 "직접" 작성해야 해.

**[AI의 역할 및 톤]**
1. **가장 중요:** 너는 선생님 본인이기 때문에, **"안녕하세요, OOO 컨설턴트입니다" 혹은 "xxx쌤 입니다"라고 너 자신을 소개하는 문장을 절대로 쓰지 마.**
2. 마치 선생님이 학부모님께 카톡을 보내는 것처럼, "안녕하세요. ${shortName}의 ${currentMonthNum}월 리포트 보내드립니다."처럼 자연스럽고 친근하게 첫인사를 시작해 줘.
3. 전체적인 톤은 **따뜻하고, 친근하며, 학생을 격려**해야 하지만, 동시에 데이터에 기반한 **전문가의 통찰력**이 느껴져야 해.
4. \`~입니다.\`와 \`~요.\`를 적절히 섞어서 부드럽지만 격식 있는 어투를 사용해 줘.
5. **가장 중요:** 학생을 지칭할 때 '${studentName} 학생' 대신 '${shortName}${studentNameParticle}', '${shortName}${studentNameParticle2}'처럼 '${shortName}'(짧은이름)을 자연스럽게 불러주세요.
6. 한국어 이름을 쓸 때 뒤의 조사를 꼭 이름의 발음과 어울리는 것으로 올바르게 사용해 주세요. (EX: 환호이가(X) 환호가(O))

**[내용 작성 지침]**
1. **[데이터]** 아래 제공되는 [월간 통계]와 [일일 코멘트]를 **절대로 나열하지 말고,** 자연스럽게 문장 속에 녹여내 줘.
2. **[정량 평가]** "숙제 수행율 6%"처럼 부정적인 수치도 숨기지 말고 **정확히 언급**하되, "시급합니다" 같은 차가운 표현 대신 "다음 달엔 이 부분을 꼭 함께 챙겨보고 싶어요"처럼 **따뜻한 권유형**으로 표현해 줘.
3. **[정성 평가]** 월간 통계 부분에서 긍정적인 부분이 있다면, **그것을 먼저 칭찬**하면서 코멘트를 시작해 줘. (예: "이번 달에 ${shortName}${studentNameParticle2} 'Dora's Mystery' 원서를 1권 완독했네요! 정말 기특합니다.")
4. **[개선점]** 가장 아쉬웠던 점(예: 숙제 6%)을 명확히 짚어주고, "매일 꾸준히 숙제하는 습관", "어휘는 클래스 카드를 매일 5분 보기 처럼 짬짬히 해라", "문법 점수가 낮은 건 문법은 학원와서 3분 복습 처럼 개념을 빠르게 복습하도록 하겠다." 처럼 **구체적이고 쉬운 개선안**을 제시해 줘.
5. **[마무리]** 마지막은 항상 다음 달을 응원하는 격려의 메시지나, 학부모님께 드리는 감사 인사(예: "한 달간 리디튜드를 믿고 맡겨주셔서 감사합니다.")로 따뜻하게 마무리해 줘.
6. **[강조 금지]** 절대로 마크다운(\`**\` or \`*\`)을 사용하여 텍스트를 강조하지 마세요.

[월간 통계]
- 숙제 수행율(평균): ${stats.hwAvg}%
- 어휘 점수(평균): ${stats.vocabAvg}점
- 문법 점수(평균): ${stats.grammarAvg}점
- 읽은 책: ${stats.totalBooks}권 (${stats.bookList})
- 독해 통과율: ${stats.readingPassRate}%

[일일 코멘트 모음]
${comments}
`;
                            const result = await geminiModel.generateContent(prompt);
                            const response = await result.response;
                            aiSummary = response.text();
                        } catch (aiError) {
                            console.error(`[수동 월간 리포트] ${studentName} 학생 AI 요약 실패:`, aiError);
                            aiSummary = 'AI 요약 중 오류가 발생했습니다.';
                        }
                    }

                    const reportTitle = `${studentName} - ${monthString} 월간 리포트`;
                    const reportUrl = `${domainUrl}/monthly-report?studentId=${studentPageId}&month=${monthString}`;

                    const existingReport = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
                        method: 'POST',
                        body: JSON.stringify({
                            filter: {
                                and: [
                                    { property: '학생', relation: { contains: studentPageId } },
                                    { property: '리포트 월', rich_text: { equals: monthString } }
                                ]
                            },
                            page_size: 1
                        })
                    });

                    if (existingReport.results.length > 0) {
                        const existingPageId = existingReport.results[0].id;
                        await fetchNotion(`https://api.notion.com/v1/pages/${existingPageId}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                                properties: {
                                    '월간리포트URL': { url: reportUrl },
                                    '숙제수행율(평균)': { number: stats.hwAvg },
                                    '어휘점수(평균)': { number: stats.vocabAvg },
                                    '문법점수(평균)': { number: stats.grammarAvg },
                                    '총 읽은 권수': { number: stats.totalBooks },
                                    '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                                    'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                                    '독해 통과율(%)': { number: stats.readingPassRate }
                                }
                            })
                        });
                        console.log(`[수동 월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '업데이트' 성공!`);
                    } else {
                        await fetchNotion('https://api.notion.com/v1/pages', {
                            method: 'POST',
                            body: JSON.stringify({
                                parent: { database_id: dbIds.MONTHLY_REPORT_DB_ID },
                                properties: {
                                    '이름': { title: [{ text: { content: reportTitle } }] },
                                    '학생': { relation: [{ id: studentPageId }] },
                                    '리포트 월': { rich_text: [{ text: { content: monthString } }] },
                                    '월간리포트URL': { url: reportUrl },
                                    '숙제수행율(평균)': { number: stats.hwAvg },
                                    '어휘점수(평균)': { number: stats.vocabAvg },
                                    '문법점수(평균)': { number: stats.grammarAvg },
                                    '총 읽은 권수': { number: stats.totalBooks },
                                    '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                                    'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                                    '독해 통과율(%)': { number: stats.readingPassRate }
                                }
                            })
                        });
                        console.log(`[수동 월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '새로 저장' 성공!`);
                    }
                    successCount++;
                } catch (studentError) {
                    console.error(`[수동 월간 리포트] ${studentName} 학생 처리 중 오류 발생:`, studentError.message);
                    failCount++;
                }
            }

            console.log('--- [수동 월간 리포트] 자동화 스케줄 완료 ---');
            res.json({ success: true, message: `${monthString}월 리포트 생성을 성공적으로 완료했습니다. (성공: ${successCount}건, 실패: ${failCount}건)` });

        } catch (error) {
            console.error('--- [수동 월간 리포트] 자동화 스케줄 중 오류 발생 ---', error);
            res.status(500).json({ success: false, message: `리포트 생성 오류 발생: ${error.message}` });
        }
    });

    // --- 월간 리포트 URL 자동 생성 (매달 마지막 주 금요일 밤 9시) ---
    cron.schedule('0 21 * * 5', async () => {
        console.log('--- [월간 리포트] 자동화 스케줄 실행 (매주 금요일 밤 9시) ---');

        const { dateString } = getKSTTodayRange();
        const today = new Date(dateString); // KST 기준 '오늘' Date 객체

        const nextFriday = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
        if (today.getMonth() === nextFriday.getMonth()) {
            console.log(`[월간 리포트] 오늘은 마지막 주 금요일이 아닙니다. (스킵)`);
            return;
        }

        console.log(' [월간 리포트] 오늘은 마지막 주 금요일입니다! 리포트 생성을 시작합니다.');

        if (!fetchNotion || !dbIds.STUDENT_DATABASE_ID || !dbIds.PROGRESS_DATABASE_ID || !dbIds.MONTHLY_REPORT_DB_ID || !geminiModel) {
            console.error('[월간 리포트] DB ID 또는 Gemini AI가 설정되지 않아 스케줄을 중단합니다.');
            return;
        }

        try {
            const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                method: 'POST'
            });
            const students = studentData.results;
            console.log(`[월간 리포트] 총 ${students.length}명의 학생을 대상으로 통계를 시작합니다.`);

            const currentYear = today.getFullYear();
            const currentMonth = today.getMonth(); // (0 = 1월, 11 = 12월)
            const monthString = `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}`; // "2025-11"
            const firstDayOfMonth = new Date(currentYear, currentMonth, 1).toISOString().split('T')[0];
            const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).toISOString().split('T')[0];

            for (const student of students) {
                const studentPageId = student.id; // '학생 명부 DB'의 학생 ID
                const studentName = student.properties['이름']?.title?.[0]?.plain_text;
                if (!studentName) continue;

                try {
                    console.log(`[월간 리포트] ${studentName} 학생 통계 계산 중...`);
                    const progressData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.PROGRESS_DATABASE_ID}/query`, {
                        method: 'POST',
                        body: JSON.stringify({
                            filter: {
                                and: [
                                    { property: '이름', title: { equals: studentName } },
                                    { property: '🕐 날짜', date: { on_or_after: firstDayOfMonth } },
                                    { property: '🕐 날짜', date: { on_or_before: lastDayOfMonth } }
                                ]
                            }
                        })
                    });

                    // [기능 분리] 월간 리포트는 '데일리' 파서가 아닌 '통계' 파서를 사용합니다.
                    const monthPages = await Promise.all(progressData.results.map(parseMonthlyStatsData));

                    if (monthPages.length === 0) {
                        console.log(`[월간 리포트] ${studentName} 학생은 ${monthString}월 데이터가 없습니다. (스킵)`);
                        continue;
                    }

                    // [최종 통계 로직] 헤더님 요청 로직 적용 (숙제 0점 포함, 시험 0점 제외)
                    const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
                    const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
                    const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
                    const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');

                    const bookTitles = [...new Set(monthPages.map(p => p.bookTitle).filter(t => t && t !== '읽은 책 없음'))];
                    const comments = monthPages.map((p, i) => `[${p.date}] ${p.teacherComment}`).filter(c => c.trim() !== '[]').join('\n');

                    const stats = {
                        hwAvg: hwRates.length > 0 ? Math.round(hwRates.reduce((a, b) => a + b, 0) / hwRates.length) : 0,
                        vocabAvg: vocabScores.length > 0 ? Math.round(vocabScores.reduce((a, b) => a + b, 0) / vocabScores.length) : 0,
                        grammarAvg: grammarScores.length > 0 ? Math.round(grammarScores.reduce((a, b) => a + b, 0) / grammarScores.length) : 0,
                        readingPassRate: readingResults.length > 0 ? Math.round(readingResults.filter(r => r === 'PASS').length / readingResults.length * 100) : 0,
                        totalBooks: bookTitles.length,
                        bookList: bookTitles.join(', ') || '읽은 책 없음'
                    };

                    // Gemini AI로 코멘트 요약
                    let aiSummary = 'AI 요약 기능을 사용할 수 없습니다.';
                    if (geminiModel) {
                        try {
                            let shortName = studentName;
                            if (studentName.startsWith('Test ')) {
                                shortName = studentName.substring(5);
                            } else if (studentName.length === 3 && !studentName.includes(' ')) {
                                shortName = studentName.substring(1);
                            }

                            // [AI 가이드라인 수정] 헤더님 최신 가이드라인 반영 (조사 수정)
                            let studentNameParticle = '이는';
                            let studentNameParticle2 = '이가';

                            try {
                                const lastChar = shortName.charCodeAt(shortName.length - 1);
                                if (lastChar >= 44032 && lastChar <= 55203) {
                                    const jongseong = (lastChar - 44032) % 28;
                                    if (jongseong > 0) {
                                        studentNameParticle = '이는';
                                        studentNameParticle2 = '이가';
                                    } else {
                                        studentNameParticle = '는';
                                        studentNameParticle2 = '가';
                                    }
                                }
                            } catch (e) { /* 이름이 한글이 아니거나 예외 발생 시 기본값 사용 */ }


                            const prompt = `
너는 '리디튜드' 학원의 선생님이야. 지금부터 너는 학생의 학부모님께 보낼 월간 리포트 총평을 "직접" 작성해야 해.

**[AI의 역할 및 톤]**
1. **가장 중요:** 너는 선생님 본인이기 때문에, **"안녕하세요, OOO 컨설턴트입니다" 혹은 "xxx쌤 입니다"라고 너 자신을 소개하는 문장을 절대로 쓰지 마.**
2. [수정] "안녕하세요. ${shortName}의 ${currentMonth + 1}월 리포트 보내드립니다."처럼 자연스럽고 친근하게 첫인사를 시작해 줘.
3. 전체적인 톤은 **따뜻하고, 친근하며, 학생을 격려**해야 하지만, 동시에 데이터에 기반한 **전문가의 통찰력**이 느껴져야 해.
4. \`~입니다.\`와 \`~요.\`를 적절히 섞어서 부드럽지만 격식 있는 어투를 사용해 줘.
5. **가장 중요:** 학생을 지칭할 때 '${studentName} 학생' 대신 '${shortName}${studentNameParticle}', '${shortName}${studentNameParticle2}'처럼 '${shortName}'(짧은이름)을 자연스럽게 불러주세요.
6. 한국어 이름을 쓸 때 뒤의 조사를 꼭 이름의 발음과 어울리는 것으로 올바르게 사용해 주세요. (EX: 환호이가(X) 환호가(O))

**[내용 작성 지침]**
1. **[데이터]** 아래 제공되는 [월간 통계]와 [일일 코멘트]를 **절대로 나열하지 말고,** 자연스럽게 문장 속에 녹여내 줘.
2. **[정량 평가]** "숙제 수행율 6%"처럼 부정적인 수치도 숨기지 말고 **정확히 언급**하되, "시급합니다" 같은 차가운 표현 대신 "다음 달엔 이 부분을 꼭 함께 챙겨보고 싶어요"처럼 **따뜻한 권유형**으로 표현해 줘.
3. **[정성 평가]** 월간 통계 부분에서 긍정적인 부분이 있다면, **그것을 먼저 칭찬**하면서 코멘트를 시작해 줘. (예: "이번 달에 ${shortName}${studentNameParticle2} 'Dora's Mystery' 원서를 1권 완독했네요! 정말 기특합니다.")
4. **[개선점]** 가장 아쉬웠던 점(예: 숙제 6%)을 명확히 짚어주고, "매일 꾸준히 숙제하는 습관", "어휘는 클래스 카드를 매일 5분 보기 처럼 짬짬히 해라", "문법 점수가 낮은 건 문법은 학원와서 3분 복습 처럼 개념을 빠르게 복습하도록 하겠다." 처럼 **구체적이고 쉬운 개선안**을 제시해 줘.
5. **[마무리]** 마지막은 항상 다음 달을 응원하는 격려의 메시지나, 학부모님께 드리는 감사 인사(예: "한 달간 리디튜드를 믿고 맡겨주셔서 감사합니다.")로 따뜻하게 마무리해 줘.
6. **[강조 금지]** 절대로 마크다운(\`**\` or \`*\`)을 사용하여 텍스트를 강조하지 마세요.

[월간 통계]
- 숙제 수행율(평균): ${stats.hwAvg}%
- 어휘 점수(평균): ${stats.vocabAvg}점
- 문법 점수(평균): ${stats.grammarAvg}점
- 읽은 책: ${stats.totalBooks}권 (${stats.bookList})
- 독해 통과율: ${stats.readingPassRate}%

[일일 코멘트 모음]
${comments}
`;
                            const result = await geminiModel.generateContent(prompt);
                            const response = await result.response;
                            aiSummary = response.text();
                            console.log(`[월간 리포트] ${studentName} 학생 AI 요약 성공!`);
                        } catch (aiError) {
                            console.error(`[월간 리포트] ${studentName} 학생 AI 요약 실패:`, aiError);
                            aiSummary = 'AI 요약 중 오류가 발생했습니다.';
                        }
                    }

                    // '월간 리포트 DB'에 새 페이지로 저장
                    const reportTitle = `${studentName} - ${monthString} 월간 리포트`;
                    const reportUrl = `${domainUrl}/monthly-report?studentId=${studentPageId}&month=${monthString}`;

                    const existingReport = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
                        method: 'POST',
                        body: JSON.stringify({
                            filter: {
                                and: [
                                    { property: '학생', relation: { contains: studentPageId } },
                                    { property: '리포트 월', rich_text: { equals: monthString } }
                                ]
                            },
                            page_size: 1
                        })
                    });

                    if (existingReport.results.length > 0) {
                        const existingPageId = existingReport.results[0].id;
                        await fetchNotion(`https://api.notion.com/v1/pages/${existingPageId}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                                properties: {
                                    '월간리포트URL': { url: reportUrl },
                                    '숙제수행율(평균)': { number: stats.hwAvg },
                                    '어휘점수(평균)': { number: stats.vocabAvg },
                                    '문법점수(평균)': { number: stats.grammarAvg },
                                    '총 읽은 권수': { number: stats.totalBooks },
                                    '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                                    'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                                    '독해 통과율(%)': { number: stats.readingPassRate }
                                }
                            })
                        });
                        console.log(`[월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '업데이트' 성공!`);
                    } else {
                        await fetchNotion('https://api.notion.com/v1/pages', {
                            method: 'POST',
                            body: JSON.stringify({
                                parent: { database_id: dbIds.MONTHLY_REPORT_DB_ID },
                                properties: {
                                    '이름': { title: [{ text: { content: reportTitle } }] },
                                    '학생': { relation: [{ id: studentPageId }] },
                                    '리포트 월': { rich_text: [{ text: { content: monthString } }] },
                                    '월간리포트URL': { url: reportUrl },
                                    '숙제수행율(평균)': { number: stats.hwAvg },
                                    '어휘점수(평균)': { number: stats.vocabAvg },
                                    '문법점수(평균)': { number: stats.grammarAvg },
                                    '총 읽은 권수': { number: stats.totalBooks },
                                    '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                                    'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                                    '독해 통과율(%)': { number: stats.readingPassRate }
                                }
                            })
                        });
                        console.log(`[월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '새로 저장' 성공!`);
                    }
                } catch (studentError) {
                    console.error(`[월간 리포트] ${studentName} 학생 처리 중 오류 발생:`, studentError.message);
                }
            }

            console.log('--- [월간 리포트] 자동화 스케줄 완료 ---');

        } catch (error) {
            console.error('--- [월간 리포트] 자동화 스케줄 중 오류 발생 ---', error);
        }
    }, {
        timezone: "Asia/Seoul"
    });
}