import fs from 'fs';
import path from 'path';
import nodeCron from 'node-cron';
// 크론은 주입받는 게 원칙이다(테스트에서 진짜 스케줄러가 뜨면 안 된다) → wiki/patterns/module-di.md
// 주입이 없으면 예전처럼 node-cron 을 쓴다.

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
let getPropByKeywords;
let notifyOwner;

// 노션 수식은 점수를 87.77777777777779 같은 실수로 돌려준다.
// 막대 그래프·AI 프롬프트·평균이 전부 이 값을 그대로 쓰던 탓에 소수점이 화면까지 샜다.
// 값을 꺼내는 지점에서 한 번만 정수로 맞추고, 아래로는 전부 정수만 흐르게 한다.
function roundScore(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 'N/A';
    return Math.round(v);
}

/** 노션 formula 속성에서 점수를 꺼내 정수로 돌려준다. 못 읽으면 'N/A' */
function getScoreFromFormula(prop) {
    if (!prop || !prop.formula) return 'N/A';
    if (prop.formula.type === 'number') return roundScore(prop.formula.number);
    if (prop.formula.type === 'string') {
        const str = prop.formula.string;
        if (!str || str === 'N/A') return 'N/A';
        const match = str.match(/-?\d+(\.\d+)?/);
        return match ? roundScore(parseFloat(match[0])) : 'N/A';
    }
    return 'N/A';
}

/**
 * 'YYYY-MM' 을 그 달의 첫날·마지막날로 편다.
 * new Date(y, m, 0).toISOString() 은 서버 시간대에 따라 하루 밀리므로 문자열로 직접 만든다.
 */
function monthRange(month) {
    const [year, monthNum] = String(month).split('-').map(Number);
    const totalDays = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    const pad = (n) => String(n).padStart(2, '0');
    return {
        year,
        monthNum,
        totalDays,
        firstDay: `${year}-${pad(monthNum)}-01`,
        lastDay: `${year}-${pad(monthNum)}-${pad(totalDays)}`
    };
}

/** 서버가 해외라서 크론 콜백 안의 new Date() 는 한국 날짜가 아니다. KST 기준 'YYYY-MM-DD' */
function kstToday() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

/** 'YYYY-MM-DD' 또는 'YYYY-MM' 의 지난달을 'YYYY-MM' 으로. 1월이면 작년 12월로 넘어간다. */
function prevMonth(dateStr) {
    const [year, monthNum] = String(dateStr).split('-').map(Number);
    const d = new Date(Date.UTC(year, monthNum - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 노션 rich_text 한 덩어리의 상한. 넘기면 저장이 잘린다.
const NOTION_TEXT_LIMIT = 2000;

/**
 * AI 요약을 노션에 넣을 수 있는 길이로 줄인다.
 * 그냥 substring 하면 문장 한가운데서 끊겨 학부모 화면에 그대로 나갔다.
 * 마지막 문장·문단 끝까지만 남긴다.
 */
function fitForNotion(text) {
    if (!text) return '';
    const t = String(text).trim();
    if (t.length <= NOTION_TEXT_LIMIT) return t;
    const cut = t.slice(0, NOTION_TEXT_LIMIT);
    const stop = Math.max(cut.lastIndexOf('다.'), cut.lastIndexOf('다!'), cut.lastIndexOf('\n'));
    return (stop > NOTION_TEXT_LIMIT * 0.5 ? cut.slice(0, stop + 2) : cut).trim();
}

/**
 * 월간 리포트용 데이터 파서
 */
async function parseMonthlyStatsData(page) {
    const props = page.properties;

    const performanceRateString = props['수행율']?.formula?.string || '0%';
    const completionRate = parseFloat(performanceRateString.replace('%', '')) || 0;

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

/** 한 학생의 한 달치 진도 페이지를 전부 읽어 파싱한다. 100건이 넘어도 다 가져온다. */
async function fetchMonthPages(studentName, firstDay, lastDay) {
    const pages = [];
    let cursor = null;
    do {
        const body = {
            filter: {
                and: [
                    { property: '이름', title: { equals: studentName } },
                    { property: '🕐 날짜', date: { on_or_after: firstDay } },
                    { property: '🕐 날짜', date: { on_or_before: lastDay } }
                ]
            },
            page_size: 100
        };
        if (cursor) body.start_cursor = cursor;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.PROGRESS_DATABASE_ID}/query`, {
            method: 'POST', body: JSON.stringify(body)
        });
        pages.push(...(data.results || []));
        cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    return Promise.all(pages.map(parseMonthlyStatsData));
}

/** 월간 통계. 수동 생성·크론·화면이 어긋나지 않도록 한 곳에서만 계산한다. */
function computeMonthlyStats(monthPages) {
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
    const isScore = (v) => v !== 'N/A' && v !== null && v !== 0;

    const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
    const vocabScores = monthPages.map(p => p.vocabScore).filter(isScore);
    const grammarScores = monthPages.map(p => p.grammarScore).filter(isScore);
    const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');

    const allBooks = monthPages.flatMap(p => p.books || []);
    allBooks.sort((a, b) => new Date(a.date) - new Date(b.date));

    return {
        hwAvg: avg(hwRates),
        vocabAvg: avg(vocabScores),
        grammarAvg: avg(grammarScores),
        readingPassRate: readingResults.length
            ? Math.round(readingResults.filter(r => r === 'PASS').length / readingResults.length * 100)
            : 0,
        totalBooks: allBooks.length,
        bookListString: allBooks.map(b => (b.ar ? `${b.title}(AR:${b.ar})` : b.title)).join(', ') || '읽은 책 없음'
    };
}

/** 일일 코멘트를 프롬프트에 넣을 만큼만 모은다. [비용 절감] 최근 1500자만 */
function collectComments(monthPages) {
    const comments = monthPages
        .map(p => `[${p.date}] ${p.teacherComment}`)
        .filter(c => c.trim().length > 15)
        .join('\n');
    return comments.length > 1500 ? comments.slice(-1500) : comments;
}

function buildReportPrompt({ studentName, month, stats, grammarDetailsString, comments }) {
    return `
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

반드시 아래 4개의 소제목만 사용하고, 소제목 앞에는 반드시 '### '을 붙여주세요. 이 외의 소제목은 만들지 마세요.
### 🌟 월간 성취도 종합 평가
### 💪 발견된 강점 (Strengths)
### 🎯 보완할 점 및 약점 (Weaknesses)
### 👩‍🏫 선생님 종합 코멘트

[문법 파트별 세부 점수]를 심층 분석해서, 점수가 높은 파트는 '💪 발견된 강점'에, 오답이 많은 파트(예: to부정사, 수동태)는 '🎯 보완할 점 및 약점'에 파트 이름을 그대로 언급하며 구체적으로 적어주세요.

단순한 사실 나열보다는 통계를 기반으로 한 전문가다운 분석을 제공하고, 중요한 부분은 **강조표시**를 해주세요.
점수는 위에 주어진 숫자를 그대로 쓰고, 임의로 소수점을 붙이지 마세요.
전체 분량은 공백 포함 1,200자 이내로 맞춰주세요. 이 한도를 넘으면 저장할 때 뒷부분이 잘립니다.
`;
}

function buildReportProps({ stats, reportUrl, aiSummary }) {
    const props = {
        '월간리포트URL': { url: `https://${reportUrl}` },
        '숙제수행율(평균)': { number: stats.hwAvg },
        '어휘점수(평균)': { number: stats.vocabAvg },
        '문법점수(평균)': { number: stats.grammarAvg },
        '총 읽은 권수': { number: stats.totalBooks },
        '읽은 책 목록': { rich_text: [{ text: { content: stats.bookListString.substring(0, NOTION_TEXT_LIMIT) } }] },
        '독해 통과율(%)': { number: stats.readingPassRate }
    };
    // null 이면 'AI 요약' 속성을 건드리지 않는다 (기존 요약 보존)
    if (aiSummary !== null && aiSummary !== undefined) {
        props['AI 요약'] = { rich_text: [{ text: { content: fitForNotion(aiSummary) } }] };
    }
    return props;
}

/**
 * 학생 한 명의 한 달 리포트를 만들거나 갱신한다.
 * 수동 라우트와 토요일 크론이 이 함수 하나를 공유한다 — 예전엔 통계·프롬프트·저장이
 * 두 벌로 복사돼 있어서 한쪽만 고치면 자동/수동 결과가 조용히 갈렸다.
 *
 * force=true 면 이미 리포트가 있어도 AI 요약을 다시 만든다 (기본은 [비용 절감] 생략).
 * 통계 숫자는 force 여부와 무관하게 항상 최신으로 덮어쓴다.
 */
async function generateMonthlyReport({ studentName, studentPageId, month, force = false }) {
    const { firstDay, lastDay } = monthRange(month);
    const monthPages = await fetchMonthPages(studentName, firstDay, lastDay);
    if (monthPages.length === 0) return { status: 'no-data' };

    const stats = computeMonthlyStats(monthPages);
    const grammarDetails = calculateGrammarDetails(monthPages);
    const grammarDetailsString = grammarDetails.map(g => `${g.topic}(${g.score}점)`).join(', ') || '상세 기록 없음';

    const cleanDomain = domainUrl.replace(/^https?:\/\//, '');
    const reportUrl = `${cleanDomain}/monthly-report?studentId=${studentPageId}&month=${month}`;

    const existing = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.MONTHLY_REPORT_DB_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({
            filter: {
                and: [
                    { property: '학생', relation: { contains: studentPageId } },
                    { property: '리포트 월', rich_text: { equals: month } }
                ]
            },
            page_size: 1
        })
    });
    const existingPage = existing.results[0] || null;

    let aiSummary = null;
    if (geminiModel && (!existingPage || force)) {
        try {
            const prompt = buildReportPrompt({
                studentName, month, stats, grammarDetailsString, comments: collectComments(monthPages)
            });
            const result = await geminiModel.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } }
            });
            aiSummary = (await result.response).text();
        } catch (e) {
            console.error('Gemini Error:', studentName, month, e);
        }
    }

    const props = buildReportProps({ stats, reportUrl, aiSummary });

    if (existingPage) {
        await fetchNotion(`https://api.notion.com/v1/pages/${existingPage.id}`, {
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

    return {
        status: existingPage ? 'updated' : 'created',
        aiRegenerated: aiSummary !== null,
        url: `https://${reportUrl}`
    };
}

function renderMonthlyReportHTML(res, template, studentName, month, stats, monthPages, attendanceDays, grammarDetails) {
    const { year, monthNum, firstDay, lastDay, totalDays: totalDaysInMonth } = monthRange(month);

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
    const cron = dependencies.cron || nodeCron;
    const requireAuth = dependencies.requireAuth || ((req, res, next) => next()); // 인증 미들웨어
    fetchNotion = dependencies.fetchNotion;
    geminiModel = dependencies.geminiModel;
    dbIds = dependencies.dbIds;
    domainUrl = dependencies.domainUrl;
    publicPath = dependencies.publicPath;
    getRollupValue = dependencies.getRollupValue;
    getSimpleText = dependencies.getSimpleText;
    getKSTTodayRange = dependencies.getKSTTodayRange;
    getKoreanDate = dependencies.getKoreanDate;
    // 없으면 콘솔에만 남는다. 이 크론은 월 1회라 실패 통지가 특히 중요하다 → wiki/patterns/kakaowork-notify.md
    notifyOwner = dependencies.notifyOwner || null;
    getPropByKeywords = dependencies.getPropByKeywords || ((propsObj, keywords) => {
        for (const k of Object.keys(propsObj || {})) {
            if (keywords.every(word => k.includes(word))) return propsObj[k];
        }
        return null;
    });

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

                // 팝업에도 87.7777… 이 그대로 뜨던 자리. 공용 헬퍼가 정수로 맞춘다.
                const grammarScore = getScoreFromFormula(
                    props['📑 문법 시험 점수'] || getPropByKeywords(props, ['문법', '점수'])
                );
                
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

            const { firstDay, lastDay } = monthRange(month);
            const monthPages = await fetchMonthPages(studentName, firstDay, lastDay);
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

    // 리포트 한 건 수동 생성/갱신. ?force=true 를 붙이면 AI 요약까지 다시 만든다.
    // 리포트 한 건 수동 생성/갱신. ?force=true 를 붙이면 AI 요약까지 다시 만든다.
    app.get('/api/manual-monthly-report-gen', requireAuth, async (req, res) => {
        const { studentName, month } = req.query;
        const force = req.query.force === 'true';
        if (!studentName || !month) return res.status(400).json({ message: 'Missing info' });

        try {
            const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter: { property: '이름', title: { equals: studentName } }, page_size: 1 })
            });
            if (!studentData.results.length) return res.status(404).json({ message: 'Student not found' });

            const result = await generateMonthlyReport({
                studentName,
                studentPageId: studentData.results[0].id,
                month,
                force
            });

            if (result.status === 'no-data') return res.json({ message: 'No data for this month' });

            res.json({
                success: true,
                message: result.status === 'created'
                    ? 'Generated'
                    : (result.aiRegenerated ? 'Updated' : 'Updated (AI 재생성 생략)'),
                url: result.url
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({ message: e.message });
        }
    });

    /**
     * 명부 전원의 한 달 리포트를 만든다. 1일 크론과 수동 트리거가 공유한다.
     * 이미 있는 학생은 통계만 갱신하고 AI 재생성은 건너뛰므로 여러 번 돌려도 안전하다.
     */
    async function runMonthlyReportBatch(month) {
        const tally = { month, created: 0, updated: 0, skipped: 0, failed: 0, failedNames: [] };
        let cursor = null;

        do {
            const body = { page_size: 100 };
            if (cursor) body.start_cursor = cursor;
            const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_DATABASE_ID}/query`, {
                method: 'POST', body: JSON.stringify(body)
            });

            for (const student of studentData.results) {
                const studentName = student.properties['이름']?.title?.[0]?.plain_text;
                if (!studentName) continue;

                try {
                    const r = await generateMonthlyReport({
                        studentName, studentPageId: student.id, month, force: false
                    });
                    if (r.status === 'no-data') { tally.skipped++; continue; }
                    if (r.status === 'created') { tally.created++; console.log(`   -> ${studentName} 발행 완료`); }
                    else { tally.updated++; console.log(`   -> ${studentName} 갱신 완료`); }
                } catch (e) {
                    // 한 명이 터져도 나머지는 계속 돈다. 예전엔 여기서 전체 루프가 멈췄다.
                    tally.failed++;
                    tally.failedNames.push(studentName);
                    console.error(`   🚨 ${studentName} 리포트 실패:`, e.message);
                }

                // Gemini·Notion 쓰기 속도 조절
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // 명부가 100명을 넘으면 다음 장을 이어 읽는다 (현재 95명)
            cursor = studentData.has_more ? studentData.next_cursor : null;
        } while (cursor);

        return tally;
    }

    /**
     * 🔴 배포가 크론을 죽였을 때의 복구 수단. 이 크론은 한 달에 딱 한 번 돌기 때문에
     * 놓치면 다음 기회가 한 달 뒤다 — 다른 크론과 달리 자동 복구가 없다.
     * month 를 안 주면 지난달을 만든다. 멱등하므로 여러 번 눌러도 된다.
     */
    app.post('/api/monthly-report/tick', requireAuth, async (req, res) => {
        const month = req.query.month || prevMonth(kstToday());
        if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ message: 'month 는 YYYY-MM 형식' });

        try {
            const tally = await runMonthlyReportBatch(month);
            res.json({ success: true, ...tally });
        } catch (e) {
            console.error('🚨 월간 리포트 수동 실행 에러:', e);
            res.status(500).json({ message: e.message });
        }
    });

    // 🔴 매월 1일 09:00(KST). '지난달' 리포트를 전원 생성한다.
    //
    // 이력: 4번째 토요일(22~28일) → 마지막 토요일 → 1일. 앞의 둘은 조회 범위가 1일~말일인데
    // 정작 돌리는 날이 그 달 안이라 매달 마지막 며칠이 리포트에서 빠졌다. 1일로 옮겨야만
    // 한 달이 완전히 닫힌 뒤에 집계된다. (2026-09-01 원장 확정)
    //
    // 시각을 10시로 하지 않은 이유: 1일이 월요일이면 조교 장보기 크론(`0 10 * * 1`)과 겹친다.
    // 09:00 은 앞뒤로 비어 있고, 95명 × 2초 ≈ 4분이라 10:20 데일리 리포트 생성 전에 끝난다.
    cron.schedule('0 9 1 * *', async () => {
        // 서버가 해외라 콜백 안의 new Date() 는 한국 날짜가 아니다. timezone 옵션은 발화 시각만 정한다.
        const targetMonth = prevMonth(kstToday());
        console.log(`--- 🚀 ${targetMonth} 월간 리포트 자동 생성 시작 ---`);

        try {
            const t = await runMonthlyReportBatch(targetMonth);
            const line = `${targetMonth} 월간 리포트 — 발행 ${t.created}, 갱신 ${t.updated}, 데이터없음 ${t.skipped}, 실패 ${t.failed}`;
            console.log(`--- 🎉 ${line} ---`);

            // 한 달에 한 번뿐이라 조용히 실패하면 한 달을 통째로 잃는다. 결과를 사람이 보는 자리에 남긴다.
            if (notifyOwner) {
                const body = t.failed
                    ? `${line}\n\n실패: ${t.failedNames.join(', ')}\n복구: POST /api/monthly-report/tick?month=${targetMonth}`
                    : line;
                await notifyOwner('월간 리포트 생성', body);
            }
        } catch (error) {
            console.error('🚨 월간 리포트 스케줄러 에러:', error);
            if (notifyOwner) {
                await notifyOwner(
                    '🚨 월간 리포트 생성 실패',
                    `${targetMonth} 생성이 중간에 멈췄습니다: ${error.message}\n복구: POST /api/monthly-report/tick?month=${targetMonth}`
                );
            }
        }
    }, { timezone: "Asia/Seoul" });
}