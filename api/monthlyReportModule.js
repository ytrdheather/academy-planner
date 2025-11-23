import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

// ----------------------------------------------------------------------
// [ 헬퍼 함수 및 변수 ]
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
 * 월간 리포트용 데이터 파서 (다중 책 지원 업데이트)
 */
async function parseMonthlyStatsData(page) {
    const props = page.properties;

    // 1. 숙제 수행율
    const performanceRateString = props['수행율']?.formula?.string || '0%';
    const completionRate = parseFloat(performanceRateString.replace('%', '')) || 0;

    // 2. 시험 점수
    const vocabScoreString = props['📰 단어 테스트 점수']?.formula?.string || 'N/A';
    const vocabScore = (vocabScoreString === 'N/A') ? 'N/A' : (parseFloat(vocabScoreString) || 0);

    const grammarScoreString = props['📑 문법 시험 점수']?.formula?.string || 'N/A';
    const grammarScore = (grammarScoreString === 'N/A') ? 'N/A' : (parseFloat(grammarScoreString) || 0);

    const readingResult = props['📚 독해 해석 시험 결과']?.formula?.string || 'N/A';

    // 3. [핵심 수정] 총 읽은 권수 (다중 책 처리)
    // 롤업된 책 제목들을 배열로 모두 가져옵니다.
    let bookTitles = [];
    const rollup = props['📖 책제목 (롤업)']?.rollup;
    
    if (rollup && rollup.array) {
        bookTitles = rollup.array.map(item => {
            // 롤업 데이터 타입에 따라 텍스트 추출
            if (item.type === 'title') return item.title?.[0]?.plain_text;
            if (item.type === 'rich_text') return item.rich_text?.[0]?.plain_text;
            return null;
        }).filter(title => title && title !== '읽은 책 없음');
    }

    // 4. 일일 코멘트
    const teacherComment = getSimpleText(props['❤ Today\'s Notice!']) || '';

    // 5. 날짜
    const pageDate = props['🕐 날짜']?.date?.start || '';

    return {
        completionRate: (completionRate === null) ? null : Math.round(completionRate),
        vocabScore,
        grammarScore,
        readingResult,
        bookTitles: bookTitles, // 배열로 반환 (예: ['해리포터', '매직트리하우스'])
        teacherComment,
        date: pageDate
    };
}

/**
 * 월간 리포트 HTML 렌더링 헬퍼
 */
function renderMonthlyReportHTML(res, template, studentName, month, stats, monthPages, attendanceDays) {
    const [year, monthNum] = month.split('-').map(Number);
    const firstDay = new Date(year, monthNum - 1, 1).toISOString().split('T')[0];
    const lastDay = new Date(year, monthNum, 0).toISOString().split('T')[0];
    const totalDaysInMonth = new Date(year, monthNum, 0).getDate();

    // [핵심 수정] 독서 목록 생성 (다중 책 펼치기 + 중복 제거)
    // 1. 모든 날짜의 책 배열을 하나로 합침 (flat)
    const allBookTitles = monthPages.flatMap(p => p.bookTitles || []);
    
    // 2. 중복 제거
    const uniqueBooks = [...new Set(allBookTitles)];
    
    // 3. HTML 리스트 생성
    const bookListHtml = uniqueBooks.length > 0
        ? uniqueBooks.map(title => `<li>${title}</li>`).join('\n')
        : '<li class="text-gray-500 font-normal">이번 달에 읽은 원서가 없습니다.</li>';

    // 통계 계산 (자동 생성 시 stats가 없을 경우를 대비해 재계산 로직 보강 가능하나, 여기서는 전달받은 stats 사용)
    // 단, 총 권수는 uniqueBooks.length가 더 정확할 수 있음 (선택 사항)
    
    const hwScore = Math.round(stats.hwAvg);
    const rtNotice = {};
    if (hwScore < 70) {
        rtNotice.bgColor = 'bg-red-50';
        rtNotice.borderColor = 'border-red-400';
        rtNotice.titleColor = 'text-red-900';
        rtNotice.textColor = 'text-red-800';
        rtNotice.title = '⚠️ RT-Check Point 경고';
    } else {
        rtNotice.bgColor = 'bg-green-50';
        rtNotice.borderColor = 'border-green-400';
        rtNotice.titleColor = 'text-green-900';
        rtNotice.textColor = 'text-green-800';
        rtNotice.title = '👏 RT-Check Point 칭찬';
    }

    const vocabScoreColor = (stats.vocabAvg < 80) ? 'text-red-600' : 'text-teal-600';
    const grammarScoreColor = (stats.grammarAvg < 80) ? 'text-red-600' : 'text-teal-600';
    const readingPassRateColor = (stats.readingPassRate < 80) ? 'text-red-600' : 'text-teal-600';

    const replacements = {
        '{{STUDENT_NAME}}': studentName,
        '{{REPORT_MONTH}}': `${year}년 ${monthNum}월`,
        '{{START_DATE}}': firstDay,
        '{{END_DATE}}': lastDay,
        '{{HW_AVG_SCORE}}': hwScore,
        '{{HW_SCORE_COLOR}}': (hwScore < 70) ? 'text-red-600' : 'text-teal-600',
        '{{RT_NOTICE_BG_COLOR}}': rtNotice.bgColor,
        '{{RT_NOTICE_BORDER_COLOR}}': rtNotice.borderColor,
        '{{RT_NOTICE_TITLE_COLOR}}': rtNotice.titleColor,
        '{{RT_NOTICE_TEXT_COLOR}}': rtNotice.textColor,
        '{{RT_NOTICE_TITLE}}': rtNotice.title,
        '{{AI_SUMMARY}}': stats.aiSummary.replace(/\n/g, '<br>'),
        '{{ATTENDANCE_DAYS}}': attendanceDays,
        '{{TOTAL_DAYS_IN_MONTH}}': totalDaysInMonth,
        '{{VOCAB_AVG_SCORE}}': Math.round(stats.vocabAvg),
        '{{VOCAB_SCORE_COLOR}}': vocabScoreColor,
        '{{GRAMMAR_AVG_SCORE}}': Math.round(stats.grammarAvg),
        '{{GRAMMAR_SCORE_COLOR}}': grammarScoreColor,
        '{{READING_PASS_RATE}}': Math.round(stats.readingPassRate),
        '{{READING_PASS_RATE_COLOR}}': readingPassRateColor,
        '{{TOTAL_BOOKS_READ}}': stats.totalBooks,
        '{{BOOK_LIST_HTML}}': bookListHtml,
    };

    let html = template.replace(new RegExp(Object.keys(replacements).join('|'), 'g'), (match) => {
        return replacements[match];
    });

    res.send(html);
}

// ----------------------------------------------------------------------
// [ 메인 모듈 초기화 함수 ]
// ----------------------------------------------------------------------
export function initializeMonthlyReportRoutes(dependencies) {
    const app = dependencies.app;
    fetchNotion = dependencies.fetchNotion;
    geminiModel = dependencies.geminiModel;
    dbIds = dependencies.dbIds;
    domainUrl = dependencies.domainUrl;
    publicPath = dependencies.publicPath;
    getRollupValue = dependencies.getRollupValue;
    getSimpleText = dependencies.getSimpleText;
    getKSTTodayRange = dependencies.getKSTTodayRange;
    getKoreanDate = dependencies.getKoreanDate;

    let monthlyReportTemplate = '';
    try {
        monthlyReportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'monthlyreport.html'), 'utf-8');
    } catch (e) { console.error('Monthly Report Template Error', e); }

    // 1. 월간 리포트 뷰 (HTML 생성)
    app.get('/monthly-report', async (req, res) => {
        const { studentId, month } = req.query;
        if (!studentId || !month) return res.status(400).send('Missing info');
        if (!monthlyReportTemplate) return res.status(500).send('Template Error');

        try {
            // DB에서 리포트 데이터 조회
            const reportQuery = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: {
                        and: [
                            { property: '학생', relation: { contains: studentId } },
                            { property: '리포트 월', rich_text: { equals: month } }
                        ]
                    },
                    page_size: 1
                })
            });

            if (reportQuery.results.length === 0) return res.status(404).send('Report not found');
            const reportData = reportQuery.results[0].properties;

            // 학생 이름 가져오기
            let studentName = '학생';
            if (reportData['학생']?.relation?.[0]?.id) {
                const studentPage = await fetchNotion(`https://api.notion.com/v1/pages/${reportData['학생'].relation[0].id}`);
                studentName = studentPage.properties['이름']?.title?.[0]?.plain_text || '학생';
            }

            const stats = {
                hwAvg: reportData['숙제수행율(평균)']?.number || 0,
                vocabAvg: reportData['어휘점수(평균)']?.number || 0,
                grammarAvg: reportData['문법점수(평균)']?.number || 0,
                totalBooks: reportData['총 읽은 권수']?.number || 0,
                aiSummary: getSimpleText(reportData['AI 요약']) || '요약 없음',
                readingPassRate: reportData['독해 통과율(%)']?.number || 0
            };

            // 진도 DB에서 상세 데이터(책 목록 등) 조회
            const [year, monthNum] = month.split('-').map(Number);
            const firstDay = new Date(year, monthNum - 1, 1).toISOString().split('T')[0];
            const lastDay = new Date(year, monthNum, 0).toISOString().split('T')[0];

            const progressQuery = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.PROGRESS_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: {
                        and: [
                            { property: '이름', title: { equals: studentName } },
                            { property: '🕐 날짜', date: { on_or_after: firstDay } },
                            { property: '🕐 날짜', date: { on_or_before: lastDay } }
                        ]
                    },
                    page_size: 100
                })
            });

            const monthPages = await Promise.all(progressQuery.results.map(parseMonthlyStatsData));
            renderMonthlyReportHTML(res, monthlyReportTemplate, studentName, month, stats, monthPages, monthPages.length);

        } catch (error) {
            console.error(error);
            res.status(500).send('Error generating report');
        }
    });

    // 2. URL 조회 API
    app.get('/api/monthly-report-url', async (req, res) => {
        const { studentName, date } = req.query;
        try {
            const d = new Date(date);
            // 지난 달 구하기
            const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
            const monthStr = `${lastMonth.getFullYear()}-${(lastMonth.getMonth() + 1).toString().padStart(2, '0')}`;

            const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: {
                        and: [
                            { property: '이름', title: { contains: studentName } },
                            { property: '리포트 월', rich_text: { equals: monthStr } }
                        ]
                    },
                    page_size: 1
                })
            });

            if (data.results.length > 0 && data.results[0].properties['월간리포트URL']?.url) {
                res.json({ success: true, url: data.results[0].properties['월간리포트URL'].url });
            } else {
                res.status(404).json({ success: false, message: 'URL not found' });
            }
        } catch (e) { res.status(500).json({ message: e.message }); }
    });

    // 3. 수동 생성 API (다중 책 카운팅 적용)
    app.get('/api/manual-monthly-report-gen', async (req, res) => {
        const { studentName, month } = req.query;
        if (!studentName || !month) return res.status(400).json({ message: 'Missing info' });

        try {
            // 학생 찾기
            const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter: { property: '이름', title: { equals: studentName } } })
            });
            if (!studentData.results.length) return res.status(404).json({ message: 'Student not found' });
            const studentPageId = studentData.results[0].id;

            // 진도 데이터 가져오기
            const [y, m] = month.split('-');
            const firstDay = new Date(y, m - 1, 1).toISOString().split('T')[0];
            const lastDay = new Date(y, m, 0).toISOString().split('T')[0];

            const progressData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.PROGRESS_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: {
                        and: [
                            { property: '이름', title: { equals: studentName } },
                            { property: '🕐 날짜', date: { on_or_after: firstDay } },
                            { property: '🕐 날짜', date: { on_or_before: lastDay } }
                        ]
                    }
                })
            });

            const monthPages = await Promise.all(progressData.results.map(parseMonthlyStatsData));
            if (monthPages.length === 0) return res.json({ message: 'No data for this month' });

            // [통계 계산]
            const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
            const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
            const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
            const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');
            
            // [핵심] 책 통계 (flatten & unique)
            const allBookTitles = monthPages.flatMap(p => p.bookTitles);
            const uniqueBooks = [...new Set(allBookTitles)];
            
            const comments = monthPages.map(p => `[${p.date}] ${p.teacherComment}`).filter(c => c.trim().length > 15).join('\n');

            const stats = {
                hwAvg: hwRates.length ? Math.round(hwRates.reduce((a,b)=>a+b,0)/hwRates.length) : 0,
                vocabAvg: vocabScores.length ? Math.round(vocabScores.reduce((a,b)=>a+b,0)/vocabScores.length) : 0,
                grammarAvg: grammarScores.length ? Math.round(grammarScores.reduce((a,b)=>a+b,0)/grammarScores.length) : 0,
                readingPassRate: readingResults.length ? Math.round(readingResults.filter(r=>r==='PASS').length/readingResults.length*100) : 0,
                totalBooks: uniqueBooks.length, // 중복 제거된 권수
                bookListString: uniqueBooks.join(', ') || '읽은 책 없음'
            };

            // Gemini 요약
            let aiSummary = 'AI 요약 불가';
            if (geminiModel) {
                try {
                    const prompt = `
                    선생님 입장에서 학부모님께 보낼 ${month}월 리포트 총평을 작성해줘. 학생 이름: ${studentName}.
                    [통계] 숙제:${stats.hwAvg}%, 어휘:${stats.vocabAvg}, 문법:${stats.grammarAvg}, 독해통과:${stats.readingPassRate}%, 독서:${stats.totalBooks}권.
                    [책목록] ${stats.bookListString}
                    [일일코멘트] ${comments}
                    친근하고 격려하는 톤으로, 구체적인 개선점도 포함해서 작성해줘.
                    `;
                    const result = await geminiModel.generateContent(prompt);
                    aiSummary = (await result.response).text();
                } catch (e) { console.error(e); }
            }

            // DB 저장
            const reportUrl = `${domainUrl}/monthly-report?studentId=${studentPageId}&month=${month}`;
            const existingReport = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: {
                        and: [
                            { property: '학생', relation: { contains: studentPageId } },
                            { property: '리포트 월', rich_text: { equals: month } }
                        ]
                    }
                })
            });

            const props = {
                '월간리포트URL': { url: reportUrl },
                '숙제수행율(평균)': { number: stats.hwAvg },
                '어휘점수(평균)': { number: stats.vocabAvg },
                '문법점수(평균)': { number: stats.grammarAvg },
                '총 읽은 권수': { number: stats.totalBooks },
                '읽은 책 목록': { rich_text: [{ text: { content: stats.bookListString.substring(0, 2000) } }] },
                'AI 요약': { rich_text: [{ text: { content: aiSummary.substring(0, 2000) } }] },
                '독해 통과율(%)': { number: stats.readingPassRate }
            };

            if (existingReport.results.length > 0) {
                await fetchNotion(`https://api.notion.com/v1/pages/${existingReport.results[0].id}`, {
                    method: 'PATCH', body: JSON.stringify({ properties: props })
                });
            } else {
                await fetchNotion('https://api.notion.com/v1/pages', {
                    method: 'POST',
                    body: JSON.stringify({
                        parent: { database_id: dbIds.MONTHLY_REPORT_DB_ID },
                        properties: {
                            ...props,
                            '이름': { title: [{ text: { content: `${studentName} - ${month} 리포트` } }] },
                            '학생': { relation: [{ id: studentPageId }] },
                            '리포트 월': { rich_text: [{ text: { content: month } }] }
                        }
                    })
                });
            }

            res.json({ success: true, message: 'Generated', url: reportUrl });

        } catch (e) {
            console.error(e);
            res.status(500).json({ message: e.message });
        }
    });

    // 4. 스케줄링 (매월 마지막 주 금요일)
    // (간소화를 위해 로직은 위 수동 생성과 거의 동일하므로 생략하거나 필요시 추가)
    // ...
}