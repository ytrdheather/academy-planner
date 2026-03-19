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
 * 월간 리포트용 데이터 파서
 */
async function parseMonthlyStatsData(page) {
    const props = page.properties;

    const performanceRateString = props['수행율']?.formula?.string || '0%';
    const completionRate = parseFloat(performanceRateString.replace('%', '')) || 0;

    const getScoreFromFormula = (prop) => {
        if (!prop || !prop.formula) return 'N/A';
        if (prop.formula.type === 'number') return prop.formula.number !== null ? prop.formula.number : 'N/A';
        if (prop.formula.type === 'string') {
            const str = prop.formula.string;
            if (!str || str === 'N/A') return 'N/A';
            const match = str.match(/-?\d+(\.\d+)?/); 
            if (match) return parseFloat(match[0]);
            return 'N/A';
        }
        return 'N/A';
    };

    const getPropByKeywords = (propsObj, keywords) => {
        const keys = Object.keys(propsObj);
        for (const k of keys) {
            if (keywords.every(word => k.includes(word))) return propsObj[k];
        }
        return null;
    };

    const vocabScoreProp = props['📰 단어 테스트 점수'] || getPropByKeywords(props, ['단어', '점수']);
    const grammarScoreProp = props['📑 문법 시험 점수'] || getPropByKeywords(props, ['문법', '점수']);
    const readingResultProp = props['📚 독해 해석 시험 결과'] || getPropByKeywords(props, ['독해', '결과']);

    const vocabScore = getScoreFromFormula(vocabScoreProp);
    const grammarScore = getScoreFromFormula(grammarScoreProp);
    const readingResult = readingResultProp?.formula?.string || 'N/A';

    const grammarTopicProp = props['문법 테스트 내용'] || getPropByKeywords(props, ['문법', '테스트', '내용']) || props['문법 파트'];
    let grammarTopics = [];
    if (grammarTopicProp) {
        if (grammarTopicProp.type === 'multi_select' && grammarTopicProp.multi_select) {
            grammarTopics = grammarTopicProp.multi_select.map(i => i.name);
        } else if (grammarTopicProp.type === 'select' && grammarTopicProp.select) {
            grammarTopics = [grammarTopicProp.select.name];
        } else if (grammarTopicProp.type === 'rich_text' && grammarTopicProp.rich_text && grammarTopicProp.rich_text.length > 0) {
            grammarTopics = grammarTopicProp.rich_text[0].plain_text.split(',').map(s => s.trim());
        }
    }

    const vocabCorrect = props['단어(맞은 개수)']?.number || props['단어 (맞은 개수)']?.number || 0;

    let books = [];
    const titleRollup = props['📖 책제목 (롤업)']?.rollup || getPropByKeywords(props, ['책제목', '롤업'])?.rollup;
    const arRollup = props['AR']?.rollup; 
    
    const pageDate = props['🕐 날짜']?.date?.start || getPropByKeywords(props, ['날짜'])?.date?.start || '';

    if (titleRollup && titleRollup.array) {
        titleRollup.array.forEach((item, index) => {
            let title = null;
            if (item.type === 'title') title = item.title?.[0]?.plain_text;
            else if (item.type === 'rich_text') title = item.rich_text?.[0]?.plain_text;
            
            if (title && title !== '읽은 책 없음') {
                let ar = null;
                if (arRollup && arRollup.array && arRollup.array[index]) {
                    const arItem = arRollup.array[index];
                    if (arItem.type === 'number') ar = arItem.number;
                    else if (arItem.type === 'rich_text') ar = arItem.rich_text?.[0]?.plain_text;
                }
                books.push({ title, ar, date: pageDate });
            }
        });
    }

    const teacherComment = getSimpleText(props['❤ Today\'s Notice!'] || getPropByKeywords(props, ['Today', 'Notice'])) || '';

    return {
        completionRate: (completionRate === null) ? null : Math.round(completionRate),
        vocabScore,
        grammarScore,
        grammarTopics, 
        readingResult,
        vocabCorrect,
        books: books, 
        teacherComment,
        date: pageDate
    };
}

function calculateGrammarDetails(monthPages) {
    const tests = [];
    monthPages.forEach(p => {
        if (p.grammarScore !== 'N/A' && p.grammarScore !== null && p.grammarScore !== 0) {
            const topics = (p.grammarTopics && p.grammarTopics.length > 0) ? p.grammarTopics.join(', ') : '종합/기본 문법';
            let dateStr = '';
            if (p.date) {
                const parts = p.date.split('-');
                if (parts.length >= 3) {
                    dateStr = `[${parseInt(parts[1])}/${parseInt(parts[2])}] `;
                }
            }
            tests.push({
                topic: dateStr + topics,
                score: p.grammarScore,
                date: p.date
            });
        }
    });
    return tests.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function renderMonthlyReportHTML(res, template, studentName, month, stats, monthPages, attendanceDays, grammarDetails) {
    const [year, monthNum] = month.split('-').map(Number);
    const firstDay = new Date(year, monthNum - 1, 1).toISOString().split('T')[0];
    const lastDay = new Date(year, monthNum, 0).toISOString().split('T')[0];
    const totalDaysInMonth = new Date(year, monthNum, 0).getDate();

    const allBooks = monthPages.flatMap(p => p.books || []);
    allBooks.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    const bookListHtml = allBooks.length > 0
        ? allBooks.map(b => {
            const arBadge = b.ar ? `<span class="inline-block bg-teal-100 text-teal-700 text-[11px] font-extrabold px-2 py-0.5 rounded-full ml-1.5 align-middle border border-teal-200">AR ${b.ar}</span>` : '';
            let dateStr = '';
            if (b.date) {
                const parts = b.date.split('-');
                if (parts.length >= 3) {
                    dateStr = `<span class="text-gray-400 text-[13px] mr-2 font-bold">[${parseInt(parts[1])}/${parseInt(parts[2])}]</span>`;
                }
            }
            return `<li class="flex items-center mb-1.5">${dateStr}<span class="text-gray-800">${b.title}</span>${arBadge}</li>`;
        }).join('\n')
        : '<li class="text-gray-500 font-normal">이번 달에 읽은 원서가 없습니다.</li>';

    const totalVocabWords = monthPages.reduce((sum, p) => sum + (p.vocabCorrect || 0), 0);

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

    let grammarBarsHtml = '';
    if (grammarDetails && grammarDetails.length > 0) {
        const maxScore = Math.max(...grammarDetails.map(g => g.score));
        grammarBarsHtml = grammarDetails.map((g) => {
            const isMax = g.score === maxScore && maxScore > 0; 
            const isPass = g.score >= 70;
            const isReview = g.score <= 60;

            let barColor = isMax ? 'bg-blue-500' : (isReview ? 'bg-orange-400' : 'bg-teal-400');
            let barHeight = isMax ? 'h-5' : 'h-3';
            let textWeight = isMax ? 'font-extrabold text-blue-700' : 'font-bold text-gray-700';
            
            let badgeHtml = '';
            if (isReview) {
                badgeHtml = '<span class="ml-2 px-2 py-0.5 text-[11px] font-extrabold bg-orange-50 text-orange-600 border border-orange-200 rounded-md">⭐ 복습필요</span>';
            } else if (isPass) {
                badgeHtml = '<span class="ml-2 px-2 py-0.5 text-[11px] font-extrabold bg-green-50 text-green-600 border border-green-200 rounded-md">✅ PASS</span>';
            }

            return `
            <div class="mb-5 last:mb-0">
                <div class="flex justify-between items-end mb-1.5">
                    <span class="text-[14px] ${textWeight} flex items-center">${g.topic} ${badgeHtml}</span>
                    <span class="text-[14px] ${textWeight}">${g.score}점</span>
                </div>
                <div class="w-full bg-gray-100 rounded-full h-5 flex items-center p-0.5 border border-gray-200 shadow-inner">
                    <div class="${barColor} ${barHeight} rounded-full shadow-sm" style="width: ${g.score}%;"></div>
                </div>
            </div>`;
        }).join('\n');
    } else {
        grammarBarsHtml = `
        <div class="flex flex-col items-center justify-center h-full min-h-[150px] text-gray-400">
            <span class="text-4xl mb-3">📭</span>
            <p class="text-sm font-medium">이번 달 세부 문법 파트 기록이 없습니다.</p>
        </div>`;
    }

    let displaySummary = stats.aiSummary || '';
    displaySummary = displaySummary
        .replace(/^###\s*(.*)$/gm, '<h3 class="text-[1.1rem] font-extrabold text-teal-800 mt-8 mb-3 bg-teal-50 px-3 py-2 rounded-lg border-l-4 border-teal-500 shadow-sm flex items-center">$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-teal-700 font-bold bg-teal-50/50 px-1 rounded">$1</strong>')
        .replace(/\n/g, '<br>');

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
        '{{AI_SUMMARY}}': displaySummary,
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
        '{{TOTAL_VOCAB_WORDS}}': totalVocabWords,
        '{{GRAMMAR_BARS_HTML}}': grammarBarsHtml
    };

    let html = template.replace(new RegExp(Object.keys(replacements).join('|'), 'g'), (match) => {
        return replacements[match];
    });

    res.send(html);
}

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

    // [신규 API] 선생님 대시보드용 최근 1주일 히스토리 검색 (팝업용)
    app.get('/api/student-history', async (req, res) => {
        const { studentName } = req.query;
        if (!studentName) return res.status(400).json({ message: 'Missing studentName' });
        
        try {
            const today = new Date();
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(today.getDate() - 7);
            
            const firstDay = sevenDaysAgo.toISOString().split('T')[0];
            const lastDay = today.toISOString().split('T')[0];

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
                    sorts: [ { property: '🕐 날짜', direction: 'descending' } ],
                    page_size: 7
                })
            });

            const history = await Promise.all(progressQuery.results.map(async (page) => {
                const props = page.properties;
                const date = props['🕐 날짜']?.date?.start || '';
                
                const getPropByKeywords = (propsObj, keywords) => {
                    const keys = Object.keys(propsObj);
                    for (const k of keys) {
                        if (keywords.every(word => k.includes(word))) return propsObj[k];
                    }
                    return null;
                };
                
                const grammarTopic = getSimpleText(props['오늘 문법 진도']) || '-';
                const grammarHomework = getSimpleText(props['문법 숙제 내용']) || '-';
                
                const grammarTestProp = props['문법 테스트 내용'] || getPropByKeywords(props, ['문법', '테스트', '내용']) || props['문법 파트'];
                let grammarTestStr = '-';
                if (grammarTestProp) {
                    if (grammarTestProp.type === 'multi_select' && grammarTestProp.multi_select) {
                        grammarTestStr = grammarTestProp.multi_select.map(i => i.name).join(', ');
                    } else if (grammarTestProp.type === 'select' && grammarTestProp.select) {
                        grammarTestStr = grammarTestProp.select.name;
                    } else if (grammarTestProp.type === 'rich_text' && grammarTestProp.rich_text && grammarTestProp.rich_text.length > 0) {
                        grammarTestStr = grammarTestProp.rich_text[0].plain_text;
                    }
                }

                const grammarScoreProp = props['📑 문법 시험 점수'] || getPropByKeywords(props, ['문법', '점수']);
                let grammarScore = 'N/A';
                if (grammarScoreProp && grammarScoreProp.formula) {
                    if (grammarScoreProp.formula.type === 'number') grammarScore = grammarScoreProp.formula.number !== null ? grammarScoreProp.formula.number : 'N/A';
                    if (grammarScoreProp.formula.type === 'string') {
                        const str = grammarScoreProp.formula.string;
                        const match = str ? str.match(/-?\d+(\.\d+)?/) : null; 
                        if (match) grammarScore = parseFloat(match[0]);
                    }
                }
                
                const comment = getSimpleText(props['❤ Today\'s Notice!'] || getPropByKeywords(props, ['Today', 'Notice'])) || '';

                return { date, grammarTopic, grammarHomework, grammarTest: grammarTestStr, grammarScore, comment };
            }));

            res.json({ success: true, history });
        } catch (error) {
            console.error(error);
            res.status(500).json({ success: false, message: 'History fetch failed' });
        }
    });

    app.get('/monthly-report', async (req, res) => {
        const { studentId, month } = req.query;
        if (!studentId || !month) return res.status(400).send('Missing info');
        if (!monthlyReportTemplate) return res.status(500).send('Template Error');

        try {
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
            const grammarDetails = calculateGrammarDetails(monthPages); 

            renderMonthlyReportHTML(res, monthlyReportTemplate, studentName, month, stats, monthPages, monthPages.length, grammarDetails);

        } catch (error) {
            console.error(error);
            res.status(500).send('Error generating report');
        }
    });

    app.get('/api/monthly-report-url', async (req, res) => {
        const { studentName, date } = req.query;
        try {
            const d = new Date(date);
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

    app.get('/api/manual-monthly-report-gen', async (req, res) => {
        const { studentName, month } = req.query;
        if (!studentName || !month) return res.status(400).json({ message: 'Missing info' });

        try {
            const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter: { property: '이름', title: { equals: studentName } } })
            });
            if (!studentData.results.length) return res.status(404).json({ message: 'Student not found' });
            const studentPageId = studentData.results[0].id;

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

            const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
            const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
            const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
            const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');
            
            const allBooks = monthPages.flatMap(p => p.books || []);
            allBooks.sort((a, b) => new Date(a.date) - new Date(b.date));
            
            const comments = monthPages.map(p => `[${p.date}] ${p.teacherComment}`).filter(c => c.trim().length > 15).join('\n');

            const stats = {
                hwAvg: hwRates.length ? Math.round(hwRates.reduce((a,b)=>a+b,0)/hwRates.length) : 0,
                vocabAvg: vocabScores.length ? Math.round(vocabScores.reduce((a,b)=>a+b,0)/vocabScores.length) : 0,
                grammarAvg: grammarScores.length ? Math.round(grammarScores.reduce((a,b)=>a+b,0)/grammarScores.length) : 0,
                readingPassRate: readingResults.length ? Math.round(readingResults.filter(r=>r==='PASS').length/readingResults.length*100) : 0,
                totalBooks: allBooks.length,
                bookListString: allBooks.map(b => b.ar ? `${b.title}(AR:${b.ar})` : b.title).join(', ') || '읽은 책 없음'
            };

            const grammarDetails = calculateGrammarDetails(monthPages);
            const grammarDetailsString = grammarDetails.map(g => `${g.topic}(${g.score}점)`).join(', ') || '상세 기록 없음';

            let aiSummary = 'AI 요약 불가';
            if (geminiModel) {
                try {
                    const prompt = `
                    당신은 '리디튜드(Readitude)' 영어 학원의 전문 학습 분석 AI입니다.
                    학생 이름: ${studentName}
                    이번 달: ${month}
                    [통계] 숙제:${stats.hwAvg}%, 어휘:${stats.vocabAvg}점, 문법(평균):${stats.grammarAvg}점, 독해통과:${stats.readingPassRate}%, 독서:${stats.totalBooks}권.
                    [문법 파트별 세부 점수] ${grammarDetailsString}
                    [책목록] ${stats.bookListString}
                    [일일코멘트] ${comments}
                    
                    위 데이터를 바탕으로 학부모님께 제공할 월간 학습 분석 리포트를 작성해주세요. 
                    선생님이 학부모님께 직접 보내는 편지 형식(예: "안녕하세요, 담당 강사입니다", "보내드립니다")은 절대 사용하지 마세요. 
                    대신 객관적이고 전문적인 어조(예: "~했습니다", "~보입니다", "~가 필요합니다")로 학생의 한 달 성취를 평가하는 '리포트 문서' 형식으로 작성해주세요.
                    
                    특히 [문법 파트별 세부 점수]를 심층 분석하여, 학생이 어느 파트(예: to부정사, 수동태 등)에 확실한 강점이 있고, 어느 파트에서 오답이 발생하여 보완이 필요한지 '💡 독해 및 문법' 섹션에 구체적으로 언급해주세요.
                    
                    반드시 다음 4개의 소제목을 포함하여 영역별로 작성해주세요. 소제목 앞에는 반드시 '### '을 붙여야 합니다.
                    ### 🌟 월간 성취도 종합 평가
                    ### 💪 발견된 강점 (Strengths)
                    ### 🎯 보완할 점 및 약점 (Weaknesses)
                    ### 👩‍🏫 선생님 종합 코멘트
                    
                    단순한 사실 나열보다는 통계를 기반으로 한 전문가다운 분석을 제공하고, 중요한 부분은 **강조표시**를 해주세요.
                    `;
                    const result = await geminiModel.generateContent(prompt);
                    aiSummary = (await result.response).text();
                } catch (e) { console.error(e); }
            }

            const cleanDomain = domainUrl.replace(/^https?:\/\//, '');
            const reportUrl = `${cleanDomain}/monthly-report?studentId=${studentPageId}&month=${month}`;
            
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
                '월간리포트URL': { url: `https://${reportUrl}` },
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

            res.json({ success: true, message: 'Generated', url: `https://${reportUrl}` });

        } catch (e) {
            console.error(e);
            res.status(500).json({ message: e.message });
        }
    });

    cron.schedule('0 22 * * 6', async () => {
        const today = new Date();
        const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

        if (today.getMonth() !== nextWeek.getMonth()) {
            console.log('--- 🚀 이번 달 마지막 토요일: 월말 리포트 자동 생성 시작 ---');

            try {
                const currentMonth = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}`;
                const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
                const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

                const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                    method: 'POST'
                });

                for (const student of studentData.results) {
                    const studentName = student.properties['이름']?.title?.[0]?.plain_text;
                    const studentPageId = student.id;
                    
                    if (!studentName) continue;
                    console.log(`[자동 생성] ${studentName} 학생의 ${currentMonth}월 리포트 작업 중...`);

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
                    if (monthPages.length === 0) {
                        console.log(`   -> ${studentName} 학생은 이번 달 데이터가 없어 건너뜁니다.`);
                        continue;
                    }

                    const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
                    const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
                    const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== 'N/A' && s !== null && s !== 0);
                    const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');
                    
                    const allBooks = monthPages.flatMap(p => p.books || []);
                    allBooks.sort((a, b) => new Date(a.date) - new Date(b.date));
                    
                    const comments = monthPages.map(p => `[${p.date}] ${p.teacherComment}`).filter(c => c.trim().length > 15).join('\n');

                    const stats = {
                        hwAvg: hwRates.length ? Math.round(hwRates.reduce((a,b)=>a+b,0)/hwRates.length) : 0,
                        vocabAvg: vocabScores.length ? Math.round(vocabScores.reduce((a,b)=>a+b,0)/vocabScores.length) : 0,
                        grammarAvg: grammarScores.length ? Math.round(grammarScores.reduce((a,b)=>a+b,0)/grammarScores.length) : 0,
                        readingPassRate: readingResults.length ? Math.round(readingResults.filter(r=>r==='PASS').length/readingResults.length*100) : 0,
                        totalBooks: allBooks.length,
                        bookListString: allBooks.map(b => b.ar ? `${b.title}(AR:${b.ar})` : b.title).join(', ') || '읽은 책 없음'
                    };

                    const grammarDetails = calculateGrammarDetails(monthPages);
                    const grammarDetailsString = grammarDetails.map(g => `${g.topic}(${g.score}점)`).join(', ') || '상세 기록 없음';

                    let aiSummary = 'AI 요약 불가';
                    if (geminiModel) {
                        try {
                            const prompt = `
                            당신은 '리디튜드(Readitude)' 영어 학원의 전문 학습 분석 AI입니다.
                            학생 이름: ${studentName}
                            이번 달: ${currentMonth}
                            [통계] 숙제:${stats.hwAvg}%, 어휘:${stats.vocabAvg}점, 문법(평균):${stats.grammarAvg}점, 독해통과:${stats.readingPassRate}%, 독서:${stats.totalBooks}권.
                            [문법 파트별 세부 점수] ${grammarDetailsString}
                            [책목록] ${stats.bookListString}
                            [일일코멘트] ${comments}
                            
                            위 데이터를 바탕으로 학부모님께 제공할 월간 학습 분석 리포트를 작성해주세요. 
                            선생님이 학부모님께 직접 보내는 편지 형식(예: "안녕하세요, 담당 강사입니다", "보내드립니다")은 절대 사용하지 마세요. 
                            대신 객관적이고 전문적인 어조(예: "~했습니다", "~보입니다", "~가 필요합니다")로 학생의 한 달 성취를 평가하는 '리포트 문서' 형식으로 작성해주세요.
                            
                            특히 [문법 파트별 세부 점수]를 심층 분석하여, 학생이 어느 파트(예: to부정사, 수동태 등)에 확실한 강점이 있고, 어느 파트에서 오답이 발생하여 보완이 필요한지 '💡 독해 및 문법' 섹션에 구체적으로 언급해주세요.
                            
                            반드시 다음 4개의 소제목을 포함하여 영역별로 작성해주세요. 소제목 앞에는 반드시 '### '을 붙여야 합니다.
                            ### 🌟 월간 성취도 종합 평가
                            ### 💪 발견된 강점 (Strengths)
                            ### 🎯 보완할 점 및 약점 (Weaknesses)
                            ### 👩‍🏫 선생님 종합 코멘트
                            
                            단순한 사실 나열보다는 통계를 기반으로 한 전문가다운 분석을 제공하고, 중요한 부분은 **강조표시**를 해주세요.
                            `;
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            const result = await geminiModel.generateContent(prompt);
                            aiSummary = (await result.response).text();
                        } catch (e) { console.error('Gemini Error:', e); }
                    }

                    const cleanDomain = domainUrl.replace(/^https?:\/\//, '');
                    const reportUrl = `${cleanDomain}/monthly-report?studentId=${studentPageId}&month=${currentMonth}`;
                    
                    const existingReport = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
                        method: 'POST',
                        body: JSON.stringify({
                            filter: {
                                and: [
                                    { property: '학생', relation: { contains: studentPageId } },
                                    { property: '리포트 월', rich_text: { equals: currentMonth } }
                                ]
                            }
                        })
                    });

                    const props = {
                        '월간리포트URL': { url: `https://${reportUrl}` },
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
                                    '이름': { title: [{ text: { content: `${studentName} - ${currentMonth} 리포트` } }] },
                                    '학생': { relation: [{ id: studentPageId }] },
                                    '리포트 월': { rich_text: [{ text: { content: currentMonth } }] }
                                }
                            })
                        });
                    }
                    console.log(`   -> ${studentName} 리포트 발행 완료`);
                }
                console.log('--- 🎉 이번 달 리포트 자동 생성 완료 ---');
            } catch (error) {
                console.error('🚨 월말 리포트 스케줄러 에러:', error);
            }
        }
    }, { timezone: "Asia/Seoul" });
}