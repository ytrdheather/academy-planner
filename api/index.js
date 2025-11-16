import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs'; // 1. 리포트 템플릿 파일을 읽기 위해 'fs' 모듈 추가
import cron from 'node-cron'; // 2. 스케줄링(자동화)을 위해 'node-cron' 모듈 추가
import { GoogleGenerativeAI } from '@google/generative-ai'; // 3. Gemini AI 연결을 위해 모듈 추가
// [신규] 월간 리포트 모듈 임포트 (경로 수정)
import { initializeMonthlyReportRoutes } from './monthlyReportModule.js';

// --- .env 파일에서 환경 변수 로드 ---
const {
    JWT_SECRET = 'dev-only-secret-readitude-2025',
    NOTION_ACCESS_TOKEN,
    STUDENT_DATABASE_ID,
    PROGRESS_DATABASE_ID,
    KOR_BOOKS_ID,
    ENG_BOOKS_ID,
    GEMINI_API_KEY, // AI 요약 기능용 API 키
    MONTHLY_REPORT_DB_ID, // 월간 리포트 저장용 DB ID
    GRAMMAR_DB_ID, // 문법 숙제 관리 DB ID
    DOMAIN_URL = 'https://readitude.onrender.com' // 배포 시 .env 변수로 대체됨
} = process.env;

const PORT = process.env.PORT || 5001; // Render의 PORT 또는 로컬 5001

// --- 기본 설정 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const publicPath = path.join(__dirname, '../public');

// [신규] Gemini AI 클라이언트 설정
let genAI;
let geminiModel;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-09-2025' });
    console.log('✅ Gemini AI가 성공적으로 연결되었습니다.');
} else {
    console.warn('⚠️ GEMINI_API_KEY가 .env 파일에 없습니다. AI 요약 기능이 비활성화됩니다.');
}

// (교사 계정 정보는 변경 없음)
const userAccounts = {
    'manager': { password: 'rdtd112!@', role: 'manager', name: '원장 헤더쌤' },
    'teacher1': { password: 'rdtd112!@', role: 'manager', name: '조이쌤' },
    'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '주디쌤' },
    'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '소영쌤' },
    'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '레일라쌤' },
    'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '제니쌤' },
    'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '릴리쌤' }
};

// --- [신규] Notion API 호출 래퍼 (에러 핸들링 및 재시도) ---
async function fetchNotion(url, options) {
    const headers = {
        'Authorization': `Bearer ${NOTION_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
    };
    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
        const errorData = await response.json();
        console.error(`Notion API Error (${url}):`, JSON.stringify(errorData, null, 2));
        throw new Error(errorData.message || `Notion API Error: ${response.status}`);
    }
    return response.json();
}

// --- Helper Functions (기존 함수들) ---
function generateToken(userData) { return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; } }

// [신규] 헬퍼 함수: 롤업 또는 속성에서 간단한 텍스트 추출
const getSimpleText = (prop) => {
    if (!prop) return '';
    // [버그 수정] 코멘트가 여러 줄일 경우, 모든 텍스트를 \n으로 합쳐서 반환
    if (prop.type === 'rich_text') {
        return prop.rich_text.map(t => t.plain_text).join('\n');
    }
    if (prop.type === 'title' && prop.title.length > 0) return prop.title[0].plain_text;
    if (prop.type === 'select' && prop.select) return prop.select.name;
    return '';
};

async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
    if (!NOTION_ACCESS_TOKEN || !title || !databaseId) return null;
    try {
        const isTitleProp = ['Title', '이름'].includes(titlePropertyName);
        let filterBody;
        if (titlePropertyName === '반이름') {
            filterBody = { property: titlePropertyName, select: { equals: title } };
        } else if (isTitleProp) {
            // --- [핵심 수정 3] ---
            // 'contains' (포함) 대신 'equals' (일치)를 사용해야
            // "Harry Pot"이라고 썼을 때 "Harry Potter"가 저장되는 문제를 막을 수 있습니다.
            filterBody = { property: titlePropertyName, title: { equals: title } };
        } else {
            filterBody = { property: titlePropertyName, rich_text: { equals: title } };
        }

        const data = await fetchNotion(`https://api.notion.com/v1/databases/${databaseId}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: filterBody, page_size: 1 })
        });
        return data.results[0]?.id || null;
    } catch (error) {
        console.error(`Error finding page ID for title "${title}" in DB ${databaseId}:`, error);
        return null;
    }
}

// =======================================================================
// [신규] 월간 리포트 모듈에 필요한 헬퍼 함수 3개 (오류 수정)
// =======================================================================

// =======================================================================
// [수정됨] 1. '오늘' 날짜 계산 버그 수정 (가장 큰 문제)
// 서버 시간대와 관계없이 KST '오늘'을 계산하도록 수정합니다.
// =======================================================================
function getKSTTodayRange() {
    // 서버의 타임존과 관계없이 항상 KST를 기준으로 '오늘' 날짜 객체를 생성합니다.
    const kstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));

    // KST 기준 '오늘' 날짜의 YYYY-MM-DD 문자열을 생성합니다.
    const year = kstNow.getFullYear();
    const month = (kstNow.getMonth() + 1).toString().padStart(2, '0');
    const day = kstNow.getDate().toString().padStart(2, '0');
    const kstDateString = `${year}-${month}-${day}`; // 예: "2025-11-17"

    // KST 00:00:00 부터 23:59:59.999 까지의 범위를 생성합니다.
    const start = new Date(`${kstDateString}T00:00:00.000+09:00`);
    const end = new Date(`${kstDateString}T23:59:59.999+09:00`);

    return {
        start: start.toISOString(),
        end: end.toISOString(),
        dateString: kstDateString
    };
}


// [신규] 날짜를 'YYYY년 MM월 DD일 (요일)' 형식으로 변환
function getKoreanDate(dateString) {
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' };
    return new Intl.DateTimeFormat('ko-KR', options).format(date);
}

// [신규] 롤업 데이터 추출
const getRollupValue = (prop, isNumber = false) => {
    if (!prop?.rollup) return isNumber ? null : '';
    if (prop.rollup.type === 'number') return prop.rollup.number;
    if (prop.rollup.type === 'array' && prop.rollup.array.length > 0) {
        const firstItem = prop.rollup.array[0];
        if (!firstItem) return isNumber ? null : '';
        if (firstItem.type === 'title' && firstItem.title.length > 0) return firstItem.title[0].plain_text;
        if (firstItem.type === 'rich_text' && firstItem.rich_text.length > 0) return firstItem.rich_text[0].plain_text;
        if (firstItem.type === 'number') return firstItem.number;
        if (firstItem.type === 'relation') return ''; // 관계형 자체는 빈값 처리
        if (firstItem.type === 'select' && firstItem.select) return firstItem.select.name;
        if (firstItem.type === 'formula') {
            if (firstItem.formula.type === 'string') return firstItem.formula.string;
            if (firstItem.formula.type === 'number') return firstItem.formula.number;
        }
    }
    if (prop.rollup.type === 'formula') {
        if (prop.rollup.formula.type === 'number') return prop.rollup.formula.number;
        if (prop.rollup.formula.type === 'string') return prop.rollup.formula.string;
    }
    return isNumber ? null : '';
};

// =======================================================================

// --- 미들웨어 (기존과 동일) ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { return res.status(401).json({ error: '인증 토큰이 필요합니다' }); }
    const decoded = verifyToken(token);
    if (!decoded) { return res.status(401).json({ error: '유효하지 않은 토큰입니다' }); }
    req.user = decoded;
    next();
}

// --- 페이지 라우트 (기존과 동일) ---
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
// [수정] planner-modular.html을 서빙하도록 경로 수정
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner-modular.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));


// --- [신규] 헬퍼 함수: KST 기준 '오늘'의 시작과 끝, 날짜 문자열 반환 ---
// [중복 삭제] (위로 이동)
/*
function getKSTDate() { ... }
function getKSTDateString() { ... }
function getKSTTodayRange() { ... }
*/

// [유지] 헬퍼 함수: 날짜를 'YYYY년 MM월 DD일 (요일)' 형식으로 변환 ---
// [중복 삭제] (위로 이동)
/*
function getKoreanDate(dateString) { ... }
*/

// --- [공통] 헬퍼 함수: 롤업 데이터 추출 (수정됨) ---
// [중복 삭제] (위로 이동)
/*
const getRollupValue = (prop, isNumber = false) => { ... };
*/

// =======================================================================
// [기능 분리 1: 데일리 대시보드 복구]
// 헤더님이 찾아주신 "어제 잘 되던" 원본 `parseDailyReportData` 함수로 복원합니다.
// 이 함수는 '데일리 대시보드'와 '데일리 리포트'가 사용합니다.
// =======================================================================
async function parseDailyReportData(page) {
    const props = page.properties;
    const studentName = props['이름']?.title?.[0]?.plain_text || '학생';
    
    // =======================================================================
    // [수정됨] 2. 날짜 파싱 버그 수정
    // 특정 날짜(어제) 조회 시 '오늘' 날짜로 덮어쓰던 버그를 수정합니다.
    // =======================================================================
    const pageDate = props['🕐 날짜']?.date?.start || ''; 
    if (!pageDate) {
        console.warn(`[parseDailyReportData] 페이지 ${page.id}에 날짜 값이 없습니다. (비어있음)`);
    }

    let assignedTeachers = [];
    if (props['담당쌤']?.rollup?.array) {
        assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text || item.rich_text?.[0]?.plain_text))].filter(Boolean);
    }

    // 1. 숙제 및 테스트
    const performanceRateString = props['수행율']?.formula?.string || '0%';
    const performanceRate = parseFloat(performanceRateString.replace('%', '')) || 0;

    const homework = {
        grammar: props['⭕ 지난 문법 숙제 검사']?.status?.name || '해당 없음',
        vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '해당 없음',
        readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '해당 없음',
        summary: props['4️⃣ Summary 숙제']?.status?.name || '해당 없음',
        dailyReading: props['5️⃣ 매일 독해 숙제']?.status?.name || '해당 없음', // [추가] 5번 숙제 값을 읽어오도록 추가
        diary: props['6️⃣ 영어일기 or 개인 독해서']?.status?.name || '해당 없음'
    };

    const tests = {
        vocabUnit: props['어휘유닛']?.rich_text?.[0]?.plain_text || '',
        vocabCorrect: props['단어 (맞은 개수)']?.number ?? null,
        vocabTotal: props['단어 (전체 개수)']?.number ?? null,
        vocabScore: props['📰 단어 테스트 점수']?.formula?.string || 'N/A', // N/A 또는 점수(%)
        readingWrong: props['독해 (틀린 개수)']?.number ?? null,
        readingResult: props['📚 독해 해석 시험 결과']?.formula?.string || 'N/A', // PASS, FAIL, N/A
        havruta: props['독해 하브루타']?.select?.name || '숙제없음',
        grammarTotal: props['문법 (전체 개수)']?.number ?? null,
        grammarWrong: props['문법 (틀린 개수)']?.number ?? null,
        grammarScore: props['📑 문법 시험 점수']?.formula?.string || 'N/A' // N/A 또는 점수(%)
    };

    // 2. 리스닝
    const listening = {
        study: props['영어 더빙 학습 완료']?.status?.name || '진행하지 않음',
        workbook: props['더빙 워크북 완료']?.status?.name || '진행하지 않음'
    };

    // 3. 독서
    const reading = {
        readingStatus: props['📖 영어독서']?.select?.name || '',
        vocabStatus: props['어휘학습']?.select?.name || '',
        bookTitle: getRollupValue(props['📖 책제목 (롤업)']) || '읽은 책 없음',
        bookRelationId: props['오늘 읽은 영어 책']?.relation?.[0]?.id || '',
        bookSeries: getRollupValue(props['시리즈이름']),
        bookAR: getRollupValue(props['AR'], true),
        bookLexile: getRollupValue(props['Lexile'], true),
        writingStatus: props['Writing']?.select?.name || 'N/A'
    };

    // --- 4. 문법 DB에서 진도/숙제 내용 가져오기 ---
    const grammarClassName = getRollupValue(props['문법클래스']) || null;
    let grammarTopic = '진도 해당 없음';
    let grammarHomework = '숙제 내용 없음';

    if (grammarClassName && GRAMMAR_DB_ID) {
        try {
            const grammarDbData = await fetchNotion(`https://api.notion.com/v1/databases/${GRAMMAR_DB_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: {
                        property: '반이름',
                        select: { equals: grammarClassName }
                    },
                    page_size: 1
                })
            });

            if (grammarDbData.results.length > 0) {
                const grammarProps = grammarDbData.results[0].properties;
                grammarTopic = getSimpleText(grammarProps['문법 진도 내용']) || '진도 해당 없음';
                grammarHomework = getSimpleText(grammarProps['문법 과제 내용']) || '숙제 내용 없음';
            }
        } catch (e) {
            console.error(`[문법 DB 조회 오류] (반이름: ${grammarClassName}):`, e.message);
        }
    }

    // 4. 코멘트
    // [버그 수정] rich_text 배열의 [0]만 읽던 것을, getSimpleText 헬퍼 함수를 사용하도록 수정
    const fullComment_daily = getSimpleText(props['❤ Today\'s Notice!']) || '오늘의 코멘트가 없습니다.';

    const comment = {
        teacherComment: fullComment_daily,
        grammarClass: grammarClassName || '진도 해당 없음',
        grammarTopic: grammarTopic,
        grammarHomework: grammarHomework
    };

    // 5. 월간 리포트용 학생 ID (관계형)
    const studentRelationId = props['학생']?.relation?.[0]?.id || null;

    return {
        pageId: page.id,
        studentName,
        studentRelationId, // 월간 리포트 통계용
        date: pageDate,
        teachers: assignedTeachers,
        completionRate: Math.round(performanceRate),
        homework,
        tests,
        listening,
        reading,
        comment
    };
}

// =======================================================================
// [기능 분리 2: 월간 리포트 신설]
// '월간 리포트 통계' 전용 파서 함수를 새로 추가합니다.
// 이 함수는 '월간 리포트' API 2개(수동, 자동)만 사용합니다.
// =======================================================================
// [삭제] parseMonthlyStatsData 함수 (monthlyReportModule.js로 이동)

// --- [공통] 데이터 조회 함수 (파서를 위 함수로 교체) ---
// (이 함수는 데일리 대시보드 전용이 되었습니다. 'parseDailyReportData'를 호출합니다.)
async function fetchProgressData(req, res, parseFunction) {
    const { period = 'today', date, teacher } = req.query;
    if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) {
        throw new Error('서버 환경 변수가 설정되지 않았습니다.');
    }
    
    // [*** 여기부터 수정 ***]
    // const filterConditions = []; // 이 줄을 삭제합니다.
    let finalFilter; // filterConditions 대신 finalFilter 변수를 사용합니다.

    if (period === 'specific_date' && date) {
        // "특정 날짜" 조회 시
        const specificDate = date; // "2025-11-16"
        const start = new Date(`${specificDate}T00:00:00.000+09:00`).toISOString();
        const end = new Date(`${specificDate}T23:59:59.999+09:00`).toISOString();
        
        // [수정] '타임스탬프 범위' 또는 '날짜 문자열'이 일치하는 모든 데이터를 찾도록 "or" 필터 사용
        finalFilter = {
            "or": [
                { // 1. 타임스탬프가 KST 범위 내에 있는 데이터 (예: 11/16 00:00 ~ 23:59)
                    "and": [
                        { property: '🕐 날짜', date: { on_or_after: start } },
                        { property: '🕐 날짜', date: { on_or_before: end } }
                    ]
                },
                { // 2. 날짜 문자열(YYYY-MM-DD)이 정확히 일치하는 데이터 (예: "2025-11-16")
                    "property": "🕐 날짜", "date": { "equals": specificDate }
                }
            ]
        };
    } else { // 기본값 'today' 조회 시
        // [수정] "오늘" 조회 시에도 '타임스탬프 범위' 또는 '날짜 문자열' 모두 조회
        const { start, end, dateString } = getKSTTodayRange(); // KST 기준 '오늘'
        
        finalFilter = {
            "or": [
                { // 1. 타임스탬프가 KST 오늘 범위 내에 있는 데이터
                    "and": [
                        { property: '🕐 날짜', date: { on_or_after: start } },
                        { property: '🕐 날짜', date: { on_or_before: end } }
                    ]
                },
                { // 2. 날짜 문자열(YYYY-MM-DD)이 오늘 날짜와 일치하는 데이터
                    "property": "🕐 날짜", "date": { "equals": dateString }
                }
            ]
        };
    }
    // [*** 여기까지 수정 ***]


    const pages = [];
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: finalFilter, // [수정] filterConditions.length > 0 ? { and: filterConditions } : undefined -> finalFilter
                sorts: [{ property: '🕐 날짜', direction: 'descending' }, { property: '이름', direction: 'ascending' }],
                page_size: 100, start_cursor: startCursor
            })
        });
        pages.push(...data.results);
        hasMore = data.has_more; startCursor = data.next_cursor;
    }

    const parsedData = await Promise.all(pages.map(parseFunction));
    return parsedData;
}

// --- API 라우트 (데이터 조회를 통합 파서로 변경) ---

app.get('/api/daily-report-data', requireAuth, async (req, res) => {
    try {
        // [복구] 'parseDailyReportData' 원본 함수를 호출하므로, 대시보드가 정상 복구됩니다.
        const data = await fetchProgressData(req, res, parseDailyReportData);
        res.json(data);
    } catch (error) {
        console.error('데일리 리포트 데이터 로드 오류:', error);
        res.status(500).json({ message: error.message || '서버 오류' });
    }
});

// 업데이트 API (진도 관리 DB) - (기존과 동일)
app.post('/api/update-homework', requireAuth, async (req, res) => {
    const { pageId, propertyName, newValue, propertyType } = req.body;
    if (!pageId || !propertyName || newValue === undefined) { return res.status(400).json({ success: false, message: '필수 정보 누락' }); }

    try {
        if (!NOTION_ACCESS_TOKEN) { throw new Error('서버 토큰 오류'); }
        let notionUpdatePayload;
        switch (propertyType) {
            case 'number':
                const numValue = Number(newValue);
                notionUpdatePayload = { number: (isNaN(numValue) || newValue === '' || newValue === null) ? null : numValue };
                break;
            case 'rich_text':
                notionUpdatePayload = { rich_text: [{ text: { content: newValue || '' } }] };
                break;
            case 'select':
                if (newValue === null || newValue === '숙제없음' || newValue === '') { notionUpdatePayload = { select: null }; }
                else { notionUpdatePayload = { select: { name: newValue } }; }
                break;
            case 'relation':
                if (newValue === null || newValue === '') { notionUpdatePayload = { relation: [] }; }
                else { notionUpdatePayload = { relation: [{ id: newValue }] }; }
                break;
            case 'status': default:
                if (newValue === null || newValue === '숙제 없음' || newValue === '진행하지 않음' || newValue === '해당 없음') {
                    const defaultStatusName = (newValue === '진행하지 않음') ? "진행하지 않음" : (newValue === '해당 없음' ? "해당 없음" : "숙제 없음");
                    notionUpdatePayload = { status: { name: defaultStatusName } };
                } else { notionUpdatePayload = { status: { name: newValue } }; }
                break;
        }

        // [최종 버그 수정] 망가졌던 URL을 'api.notion.com'으로 완벽하게 복구합니다.
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: { [propertyName]: notionUpdatePayload } })
        });

        res.json({ success: true, message: '업데이트 성공' });
    } catch (error) {
        console.error(`숙제 업데이트 처리 중 오류 (PageID: ${pageId}):`, error);
        res.status(500).json({ success: false, message: error.message || '서버 내부 오류' });
    }
});


// --- 나머지 API 라우트 (기존과 동일) ---
app.get('/api/teachers', requireAuth, async (req, res) => {
    try {
        const teacherNames = Object.values(userAccounts).filter(acc => acc.role === 'teacher' || acc.role === 'manager').map(acc => acc.name);
        const teacherOptions = teacherNames.map((name, index) => ({ id: `t${index}`, name: name }));
        res.json(teacherOptions);
    } catch (error) { console.error('강사 목록 로드 오류:', error); res.status(500).json([]); }
});

app.post('/teacher-login', async (req, res) => {
    try {
        const { teacherId, teacherPassword } = req.body;
        if (!teacherId || !teacherPassword) { return res.status(400).json({ success: false, message: '아이디와 비밀번호를 모두 입력해주세요.' }); }
        if (!userAccounts[teacherId]) { return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' }); }
        const userAccount = userAccounts[teacherId];
        if (userAccount.password === teacherPassword) {
            const tokenPayload = { loginId: teacherId, name: userAccount.name, role: userAccount.role };
            const token = generateToken(tokenPayload);
            res.json({ success: true, message: '로그인 성공', token });
        } else {
            res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        }
    } catch (error) { console.error('선생님 로그인 처리 중 예외 발생:', error); res.status(500).json({ success: false, message: '서버 내부 오류로 로그인 처리에 실패했습니다.' }); }
});

app.get('/api/teacher/user-info', requireAuth, (req, res) => {
    if (!req.user) { return res.status(401).json({ error: '인증 실패' }); }
    res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId });
});

app.get('/api/user-info', requireAuth, (req, res) => {
    res.json({ userId: req.user.userId || req.user.loginId, userName: req.user.name, userRole: req.user.role });
});

// [수정] 'planner.html'이 학생 이름을 가져오기 위해 호출하는 '/api/student-info' 엔드포인트를 복구합니다.
app.get('/api/student-info', requireAuth, (req, res) => {
    if (!req.user || req.user.role !== 'student') {
        return res.status(401).json({ error: '학생 인증 실패' });
    }
    // planner.html이 기대하는 'studentId'와 'studentName'을 반환합니다.
    res.json({
        studentId: req.user.userId,
        studentName: req.user.name
    });
});


app.post('/login', async (req, res) => {
    const { studentId, studentPassword } = req.body;
    try {
        if (!NOTION_ACCESS_TOKEN || !STUDENT_DATABASE_ID) { return res.status(500).json({ success: false, message: '서버 설정 오류.' }); }
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] } })
        });
        if (data.results.length > 0) {
            const studentRecord = data.results[0].properties;
            // [최종 수정] '이름' 속성을 'title'로 올바르게 읽습니다. (헤더님 확인)
            const realName = studentRecord['이름']?.title?.[0]?.plain_text || studentId;
            const token = generateToken({ userId: studentId, role: 'student', name: realName });
            // [최종 수정] 'userName' 필드를 **제거**하고, token만 반환하도록 수정합니다.
            // (planner.html은 token을 받고 /api/user-info를 다시 호출하는 방식입니다.)
            // [수정] 클라이언트(planner.html)가 /login 응답에서 바로 이름을 사용할 수 있도록 'userName'을 다시 추가합니다.
            // [진짜.최종.수정] 'index예전.js'와 동일하게 token만 반환하도록 userName 필드를 제거합니다.
            res.json({ success: true, message: '로그인 성공!', token });
        } else {
            res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        }
    } catch (error) { console.error('로그인 오류:', error); res.status(500).json({ success: false, message: '로그인 중 오류가 발생했습니다.' }); }
});

app.get('/api/search-books', requireAuth, async (req, res) => {
    const { query } = req.query;
    try {
        if (!NOTION_ACCESS_TOKEN || !ENG_BOOKS_ID) { 
            throw new Error('Server config error for Eng Books.'); 
        }
        
        // --- [핵심 수정 4] ---
        // Notion API에서 직접 필터링하도록 수정합니다. (성능 향상)
        // 'contains'를 사용하여 부분 일치 검색을 지원합니다.
        const filter = query ? { property: 'Title', title: { contains: query } } : undefined;
        
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${ENG_BOOKS_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ 
                filter: filter,
                page_size: 20 // 검색 결과는 20개로 제한
            })
        });
        
        // 데이터 파싱
        const books = data.results.map(page => {
            const props = page.properties;
            return {
                id: page.id,
                title: props.Title?.title?.[0]?.plain_text || 'No Title',
                author: props.Author?.rich_text?.[0]?.plain_text || '',
                level: props.Level?.select?.name || ''
            };
        });
        
        // [수정] 서버 측 필터링 로직 제거 (Notion이 이미 필터링함)
        res.json(books);
        
    } catch (error) { 
        console.error('English book search API error:', error); 
        res.status(500).json([]); 
    }
});

app.get('/api/search-sayu-books', requireAuth, async (req, res) => {
    const { query } = req.query;
    try {
        if (!NOTION_ACCESS_TOKEN || !KOR_BOOKS_ID) { 
            throw new Error('Server config error for Kor Books.'); 
        }
        
        // --- [핵심 수정 5] ---
        // Notion API에서 직접 필터링 (한국책 속성명: '책제목')
        const filter = query ? { property: '책제목', rich_text: { contains: query } } : undefined;
        
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${KOR_BOOKS_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ 
                filter: filter,
                page_size: 20 // 검색 결과는 20개로 제한
            })
        });
        
// 아무 곳에나 (예: 550줄 근처)
app.get('/test', (req, res) => {
    res.json({ message: '서버 작동 중', time: new Date() });
});

        // 데이터 파싱
        const books = data.results.map(page => {
            const props = page.properties;
            return {
                id: page.id,
                title: props.책제목?.rich_text?.[0]?.plain_text || props['책제목']?.rich_text?.[0]?.plain_text || 'No Title',
                author: props.지은이?.rich_text?.[0]?.plain_text || props['지은이']?.rich_text?.[0]?.plain_text || '',
                publisher: props.출판사?.rich_text?.[0]?.plain_text || props['출판사']?.rich_text?.[0]?.plain_text || ''
            };
        });
        
        // [수정] 서버 측 필터링 로직 제거
        res.json(books);
        
    } catch (error) { 
        console.error('Korean book search API error:', error); 
        res.status(500).json([]); 
    }
});

app.get('/api/test-all-books', requireAuth, async (req, res) => {
    try {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${ENG_BOOKS_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ page_size: 5 })
        });
        
        console.log('전체 책 개수:', data.results.length);
        if(data.results.length > 0) {
            console.log('첫 번째 책 속성들:', Object.keys(data.results[0].properties));
            console.log('Title 속성:', data.results[0].properties.Title);
        }
        
        res.json(data.results);
    } catch (error) {
        console.error('테스트 에러:', error);
        res.status(500).json({ error: error.message });
    }
});

// =======================================================================
// [학생 플래너 저장 API - 완전 수정 버전]
// planner-modular.html에서 보낸 form data를 Notion DB에 저장
// =======================================================================
app.post('/save-progress', requireAuth, async (req, res) => {
    const formData = req.body;
    const studentName = req.user.name; // 토큰에 저장된 학생 이름
    
    try {
        if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) { 
            throw new Error('Server config error.'); 
        }

        // 1. HTML의 name 속성 -> Notion DB의 실제 속성 이름 매핑
        const propertyNameMap = {
            // 리스닝 섹션
            "영어 더빙 학습 완료": "영어 더빙 학습 완료",
            "더빙 워크북 완료": "더빙 워크북 완료",
            
            // 숙제 확인 섹션 (HTML에 이미 이모지 포함됨)
            "⭕ 지난 문법 숙제 검사": "⭕ 지난 문법 숙제 검사",
            "1️⃣ 어휘 클카 암기 숙제": "1️⃣ 어휘 클카 암기 숙제",
            "2️⃣ 독해 단어 클카 숙제": "2️⃣ 독해 단어 클카 숙제",
            "4️⃣ Summary 숙제": "4️⃣ Summary 숙제",
            "5️⃣ 매일 독해 숙제": "5️⃣ 매일 독해 숙제",
            "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 영어일기 or 개인 독해서",
            
            // 시험 결과 섹션 (Notion DB는 공백 없음!)
            "단어 (맞은 개수)": "단어(맞은 개수)",
            "단어 (전체 개수)": "단어(전체 개수)",
            "어휘유닛": "어휘유닛",
            "문법 (전체 개수)": "문법(전체 개수)",
            "문법 (틀린 개수)": "문법(틀린 개수)",
            "독해 (틀린 개수)": "독해(틀린 개수)",
            "독해 하브루타": "독해 하브루타",
            
            // 원서 독서 섹션
            "오늘 읽은 영어 책": "오늘 읽은 영어 책",  // 관계형
            "📖 영어독서": "📖 영어독서",
            "어휘학습": "어휘학습",
            
            // [수정] HTML의 name 속성 'Writing'을 매핑
            "Writing": "Writing",
            
            // 한국 독서 섹션 (HTML name 속성 기준)
            "오늘 읽은 한국 책": "국어 독서 제목",  // 관계형 - Notion에서는 "국어 독서 제목"
            "📕 책 읽는 거인": "📕 책 읽는 거인",  // select 속성
            
            // 학습 소감
            "오늘의 학습 소감": "오늘의 학습 소감"
        };

        // 2. 값 변환 매핑 (웹앱 표시값 -> Notion 저장값)
        // [수정] HTML 폼의 <option> value에 맞춰서 매핑 테이블 보강
        const valueMapping = {
            // 숙제 상태 변환
            "해당없음": "숙제 없음",
            "안 해옴": "안 해옴",
            "숙제 함": "숙제 함",
            
            // 리스닝 상태
            "진행하지 않음": "진행하지 않음",
            "완료": "완료",
            "미완료": "미완료",
            
            // 독서 관련 (📖 영어독서)
            "못함": "못함",
            "완료함": "완료함",
            
            // 어휘학습
            "완료": "완료",
            "SKIP": "SKIP",
            "미완료": "미완료",

            // 하브루타
            "숙제없음": "숙제없음",
            "못하고감": "못하고감",
            "완료함": "완료함",

            // 책 읽는 거인
            "못함": "못함",
            "시작함": "시작함",
            "절반": "절반",
            "거의다읽음": "거의다읽음",
            "완료함": "완료함",
            
            // Writing
            "안함": "안함",
            "완료": "완료"
        };

        // 3. 데이터 타입 분류 (HTML의 name 기준)
        const numberProps = [
            "단어 (맞은 개수)",
            "단어 (전체 개수)", 
            "문법 (전체 개수)", 
            "문법 (틀린 개수)", 
            "독해 (틀린 개수)"
        ];
        
        const selectProps = [
            "독해 하브루타", 
            "📖 영어독서", // [수정] 이모지 포함
            "어휘학습", 
            "Writing", 
            "📕 책 읽는 거인" // [수정] 이모지 포함
        ];
        
        const textProps = [
            "어휘유닛", 
            "오늘의 학습 소감"
        ];
        
        const statusProps = [
            // [수정] HTML의 name 속성 기준으로 수정
            "영어 더빙 학습 완료",
            "더빙 워크북 완료",
            "⭕ 지난 문법 숙제 검사",
            "1️⃣ 어휘 클카 암기 숙제",
            "2️⃣ 독해 단어 클카 숙제",
            "4️⃣ Summary 숙제",
            "5️⃣ 매일 독해 숙제",
            "6️⃣ 영어일기 or 개인 독해서"
        ];

        const relationProps = [
            "오늘 읽은 영어 책",
            "오늘 읽은 한국 책" // [수정] HTML의 name 속성 기준
        ];

        // 4. Notion에 저장할 properties 객체 생성
        const properties = {};

        // 5. 폼 데이터를 properties 객체로 변환
        for (let key in formData) {
            let value = formData[key];
            
            // 값이 없으면 건너뛰기
            if (!value || value === '') continue;
            
            // 값 변환 (웹앱 표시값 -> Notion 값)
            const convertedValue = valueMapping[value] || value;
            
            // Notion 속성명 가져오기
            const notionPropName = propertyNameMap[key] || key;
            
            // 관계형 속성 처리 (책)
            if (key === '오늘 읽은 영어 책' || key === '오늘 읽은 영어 책 ID') {
                const bookId = formData['오늘 읽은 영어 책 ID'];
                const bookTitle = formData['오늘 읽은 영어 책'];
                
                if (bookId && bookId !== '') {
                    properties['오늘 읽은 영어 책'] = { relation: [{ id: bookId }] };
                } else if (bookTitle && bookTitle !== '') {
                    // [수정] ID가 없고 텍스트만 있을 경우, '정확히 일치'하는 책만 찾습니다. (findPageIdByTitle 수정됨)
                    const bookPageId = await findPageIdByTitle(process.env.ENG_BOOKS_ID, bookTitle, 'Title');
                    if (bookPageId) {
                        properties['오늘 읽은 영어 책'] = { relation: [{ id: bookPageId }] };
                    }
                    // [수정] ID가 없으면 아무것도 저장하지 않습니다 (잘못된 관계형 저장을 막음)
                }
                continue;
            }
            
            if (key === '오늘 읽은 한국 책' || key === '오늘 읽은 한국 책 ID') {
                const bookId = formData['오늘 읽은 한국 책 ID'];
                const bookTitle = formData['오늘 읽은 한국 책'];
                
                if (bookId && bookId !== '') {
                    properties['국어 독서 제목'] = { relation: [{ id: bookId }] };  // Notion에서는 "국어 독서 제목"
                } else if (bookTitle && bookTitle !== '') {
                    // [핵심 수정 6] 한국책 DB의 Title 속성명인 '책제목'으로 찾아야 합니다.
                    const bookPageId = await findPageIdByTitle(process.env.KOR_BOOKS_ID, bookTitle, '책제목');
                    if (bookPageId) {
                        properties['국어 독서 제목'] = { relation: [{ id: bookPageId }] };
                    }
                }
                continue;
            }
            
            // ID 필드는 건너뜁니다 (위에서 이미 처리됨)
            if (key === '오늘 읽은 영어 책 ID' || key === '오늘 읽은 한국 책 ID') continue;

            // 숫자 속성 처리
            if (numberProps.includes(key)) {
                const numValue = Number(convertedValue);
                if (!isNaN(numValue)) {
                    properties[notionPropName] = { number: numValue };
                }
            }
            // Select 속성 처리
            else if (selectProps.includes(key)) {
                // [수정] 기본값('못함', '안함' 등)도 저장해야 하므로 조건 제거
                properties[notionPropName] = { select: { name: convertedValue } };
            }
            // 텍스트 속성 처리
            else if (textProps.includes(key)) {
                properties[notionPropName] = { rich_text: [{ text: { content: convertedValue } }] };
            }
            // Status 속성 처리
            else if (statusProps.includes(key)) {
                // Status는 모든 값을 저장 (숙제 없음, 진행하지 않음 포함)
                properties[notionPropName] = { status: { name: convertedValue } };
            }
        }

        // 6. KST 기준 '오늘'의 시작과 끝 범위를 가져옵니다.
        const { start, end, dateString } = getKSTTodayRange();

        // =======================================================================
        // [수정됨] 3. 학생 저장 API 버그 수정
        // Make.com이 만든 '날짜만 있는' 데이터를 찾도록 'or' 필터를 추가합니다.
        // =======================================================================
        // 7. '이름'과 '오늘 날짜'로 '진도 관리 DB'에서 기존 페이지를 검색합니다.
        const existingPageQuery = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: '이름', title: { equals: studentName } },
                        { // 🌟 "or" 필터를 여기에도 추가합니다.
                            "or": [
                                {
                                    "and": [
                                        { property: '🕐 날짜', date: { on_or_after: start } },
                                        { property: '🕐 날짜', date: { on_or_before: end } }
                                    ]
                                },
                                { "property": "🕐 날짜", "date": { "equals": dateString } }
                            ]
                        }
                    ]
                },
                page_size: 1
            })
        });

        console.log(`[save-progress] ${studentName} 학생의 오늘(${dateString}) 데이터 검색 결과: ${existingPageQuery.results.length}개`);

        // 8. 기존 페이지가 있는지 여부에 따라 '업데이트' 또는 '생성'을 수행합니다.
        if (existingPageQuery.results.length > 0) {
            // --- 기존 페이지가 있으면: '업데이트' (PATCH) ---
            const existingPageId = existingPageQuery.results[0].id;
            console.log(`[save-progress] ${studentName} 학생의 '오늘' 페이지(${existingPageId})를 '업데이트'합니다.`);
            console.log('[save-progress] 업데이트할 속성들:', Object.keys(properties));

            await fetchNotion(`https://api.notion.com/v1/pages/${existingPageId}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties })
            });

            console.log(`[save-progress] 업데이트 성공: ${studentName} (${dateString})`);
            res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 저장되었습니다!' });
            
        } else {
            // --- 기존 페이지가 없으면: '생성' (POST) ---
            console.log(`[save-progress] ${studentName} 학생의 '오늘' 페이지가 없으므로 '생성'합니다.`);

            // 필수 속성 추가
            properties['이름'] = { title: [{ text: { content: studentName } }] };
            
            // [*** 복구 ***] 헤더님이 주신 "잘 되던" 로직(dateString 사용)으로 복구합니다.
            properties['🕐 날짜'] = { date: { start: dateString } };
            
            // [추가] 학생 명부와 관계형 연결 (월간 리포트용)
            const studentPageId = await findPageIdByTitle(STUDENT_DATABASE_ID, studentName, '이름');
            if (studentPageId) {
                properties['학생'] = { relation: [{ id: studentPageId }] };
                console.log(`[save-progress] 학생 명부(${studentPageId}) 관계형 연결 완료.`);
            } else {
                 console.warn(`[save-progress] 학생 명부에서 ${studentName} 학생을 찾을 수 없어 관계형 연결에 실패했습니다.`);
            }

            await fetchNotion(`https://api.notion.com/v1/pages`, {
                method: 'POST',
                body: JSON.stringify({
                    parent: { database_id: PROGRESS_DATABASE_ID },
                    properties
                })
            });

            console.log(`[save-progress] 생성 성공: ${studentName} (${dateString})`);
            res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 저장되었습니다!' });
        }
        
    } catch (error) {
        console.error('[save-progress] 처리 중 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || '저장 중 오류가 발생했습니다.' 
        });
    }
});

app.get('/api/get-today-progress', requireAuth, async (req, res) => {
    const studentName = req.user.name;
    
    try {
        if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) {
            throw new Error('Server config error.');
        }
        
        // KST 기준 오늘 날짜
        const { start, end, dateString } = getKSTTodayRange();
        
        // =======================================================================
        // [수정됨] 4. 학생 조회 API 버그 수정
        // Make.com이 만든 '날짜만 있는' 데이터를 찾도록 'or' 필터를 추가합니다.
        // =======================================================================
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: '이름', title: { equals: studentName } },
                        { // 🌟 "or" 필터를 여기에 추가합니다.
                            "or": [
                                {
                                    "and": [
                                        { property: '🕐 날짜', date: { on_or_after: start } },
                                        { property: '🕐 날짜', date: { on_or_before: end } }
                                    ]
                                },
                                { "property": "🕐 날짜", "date": { "equals": dateString } }
                            ]
                        }
                    ]
                },
                page_size: 1
            })
        });
        
        if (query.results.length === 0) {
            console.log(`[get-today-progress] ${studentName} 학생의 오늘 데이터가 없습니다.`);
            return res.json({ success: true, progress: null, message: '오늘 저장된 데이터가 없습니다.' });
        }
        
        // 데이터 파싱
        const page = query.results[0];
        const properties = page.properties;
        const progress = {};
        
        // 각 속성을 읽어서 객체로 변환
        for (const [key, value] of Object.entries(properties)) {
            // 타이틀 (이름)
            if (value.type === 'title' && value.title.length > 0) {
                progress[key] = value.title[0].plain_text;
            }
            // 텍스트
            else if (value.type === 'rich_text' && value.rich_text.length > 0) {
                progress[key] = value.rich_text[0].plain_text;
            }
            // 숫자
            else if (value.type === 'number') {
                progress[key] = value.number;
            }
            // 선택
            else if (value.type === 'select' && value.select) {
                progress[key] = value.select.name;
            }
            // 상태
            else if (value.type === 'status' && value.status) {
                progress[key] = value.status.name;
            }
            // 날짜
            else if (value.type === 'date' && value.date) {
                progress[key] = value.date.start;
            }
            // [수정] 관계형 속성은 롤업 속성(책 제목)을 대신 사용합니다.
            // (planner.js의 fillFormWithData가 롤업 제목을 사용하도록 설정해야 합니다)
            else if (value.type === 'rollup' && value.rollup.array.length > 0) {
                 const firstItem = value.rollup.array[0];
                 if (firstItem.type === 'title' && firstItem.title.length > 0) {
                     // 롤업 속성명 (예: '📖 책제목 (롤업)') 대신 관계형 속성명 (예: '오늘 읽은 영어 책')에
                     // 롤업된 '제목'을 넣어주어 폼을 채울 수 있게 합니다.
                     if (key === '📖 책제목 (롤업)') {
                         progress['오늘 읽은 영어 책'] = firstItem.title[0].plain_text;
                     } else if (key === '국어책제목(롤업)') { // (Notion DB에 이 롤업이 있다고 가정)
                         progress['국어 독서 제목'] = firstItem.title[0].plain_text;
                     }
                 }
            }
        }
        
        // [추가] planner.js의 fillFormWithData가 Notion의 '국어 독서 제목' 속성을
        // HTML의 '오늘 읽은 한국 책' 필드에 매핑하므로, progress 객체의 키를 맞춰줍니다.
        if (progress['국어 독서 제목']) {
            progress['오늘 읽은 한국 책'] = progress['국어 독서 제목'];
        }
        // [추가] '📕 책 읽는 거인' 속성
        if (progress['📕 책 읽는 거인']) {
             progress['📕 책 읽는 거인'] = progress['📕 책 읽는 거인'];
        }

        console.log(`[get-today-progress] ${studentName} 학생의 오늘 데이터를 불러왔습니다.`);
        res.json({ success: true, progress, message: '데이터 로드 성공' });
        
    } catch (error) {
        console.error('[get-today-progress] 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || '데이터 로드 중 오류가 발생했습니다.' 
        });
    }
});

// =======================================================================
// [신규] 데일리 리포트 동적 생성 API
// =======================================================================

let reportTemplate = '';
try {
    reportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'dailyreport.html'), 'utf-8');
    console.log('✅ dailyreport.html 템플릿을 성공적으로 불러왔습니다.');
} catch (e) {
    console.error('❌ dailyreport.html 템플릿 파일을 읽을 수 없습니다.', e);
};

// [삭제] 월간 리포트 템플릿 로드 (monthlyReportModule.js로 이동)

function getReportColors(statusOrScore, type) {
    // #5bb3ac (초록), #72aaa6 (회청), #ffde59 (노랑), #ff5757 (빨강)
    const colors = {
        green: '#5bb3ac',
        teal: '#72aaa6',
        yellow: '#ffde59',
        red: '#ff5757',
        gray: '#9ca3af'
    };

    if (type === 'hw_summary') { // 숙제 수행율 (숫자 %)
        const score = parseInt(statusOrScore) || 0;
        if (score >= 90) return colors.green;
        if (score >= 80) return colors.teal;
        if (score >= 70) return colors.yellow;
        return colors.red;
    }
    if (type === 'test_score') { // 문법/어휘 (N/A 또는 숫자 %)
        if (statusOrScore === 'N/A' || statusOrScore === null) return colors.gray;
        const score = parseInt(statusOrScore) || 0;
        if (score >= 80) return colors.green;
        if (score >= 70) return colors.teal;
        if (score >= 50) return colors.yellow;
        return colors.red;
    }
    if (type === 'test_status') { // 독해 (PASS/FAIL/N/A)
        if (statusOrScore === 'PASS') return colors.green;
        if (statusOrScore === 'FAIL') return colors.red;
        return colors.gray; // N/A
    }
    if (type === 'status') { // 리스닝, 독서 (완료/미완료/N/A)
        if (statusOrScore === '완료' || statusOrScore === '완료함') return colors.green;
        if (statusOrScore === '미완료' || statusOrScore === '못함') return colors.red;
        return colors.gray; // N/A, 진행하지 않음 등
    }
    if (type === 'hw_detail') { // 숙제 상세 (숙제 함/안 해옴/해당 없음)
        if (statusOrScore === '숙제 함') return '완료'; // 텍스트 반환
        if (statusOrScore === '안 해옴') return '미완료'; // 텍스트 반환
        return '해당 없음'; // 텍스트 반환
    }
    return colors.gray;
}

function getHwDetailColor(status) {
    if (status === '완료') return '#5bb3ac'; // green
    if (status === '미완료') return '#ff5757'; // red
    return '#9ca3af'; // gray
}


function fillReportTemplate(template, data) {
    const { tests, homework, listening, reading, comment } = data;

    // HW 상세 포맷팅
    const hwGrammarStatus = getReportColors(homework.grammar, 'hw_detail');
    const hwVocabStatus = getReportColors(homework.vocabCards, 'hw_detail');
    const hwReadingCardStatus = getReportColors(homework.readingCards, 'hw_detail');
    const hwSummaryStatus = getReportColors(homework.summary, 'hw_detail');
    const hwDiaryStatus = getReportColors(homework.diary, 'hw_detail');

    const replacements = {
        '{{STUDENT_NAME}}': data.studentName,
        '{{REPORT_DATE}}': getKoreanDate(data.date),
        // [버그 수정] 코멘트가 여러 줄일 경우 <br>로 변환
        '{{TEACHER_COMMENT}}': (comment.teacherComment || '오늘의 코멘트가 없습니다.').replace(/\n/g, '<br>'),

        '{{HW_SCORE}}': formatReportValue(data.completionRate, 'percent'),
        '{{HW_SCORE_COLOR}}': getReportColors(data.completionRate, 'hw_summary'),

        '{{GRAMMAR_SCORE}}': formatReportValue(tests.grammarScore, 'score'),
        '{{GRAMMAR_SCORE_COLOR}}': getReportColors(tests.grammarScore, 'test_score'),

        '{{VOCAB_SCORE}}': formatReportValue(tests.vocabScore, 'score'),
        '{{VOCAB_SCORE_COLOR}}': getReportColors(tests.vocabScore, 'test_score'),

        '{{READING_TEST_STATUS}}': formatReportValue(tests.readingResult, 'status'),
        '{{READING_TEST_COLOR}}': getReportColors(tests.readingResult, 'test_status'),

        '{{LISTENING_STATUS}}': formatReportValue(listening.study, 'listen_status'),
        '{{LISTENING_COLOR}}': getReportColors(listening.study, 'status'),

        '{{READING_BOOK_STATUS}}': formatReportValue(reading.readingStatus, 'read_status'),
        '{{READING_BOOK_COLOR}}': getReportColors(reading.readingStatus, 'status'),

        '{{GRAMMAR_CLASS_TOPIC}}': comment.grammarTopic || '진도 해당 없음',
        '{{GRAMMAR_HW_DETAIL}}': comment.grammarHomework || '숙제 내용 없음',

        '{{HW_GRAMMAR_STATUS}}': hwGrammarStatus,
        '{{HW_GRAMMAR_COLOR}}': getHwDetailColor(hwGrammarStatus),
        '{{HW_VOCAB_STATUS}}': hwVocabStatus,
        '{{HW_VOCAB_COLOR}}': getHwDetailColor(hwVocabStatus),
        '{{HW_READING_CARD_STATUS}}': hwReadingCardStatus,
        '{{HW_READING_CARD_COLOR}}': getHwDetailColor(hwReadingCardStatus),
        '{{HW_SUMMARY_STATUS}}': hwSummaryStatus,
        '{{HW_SUMMARY_COLOR}}': getHwDetailColor(hwSummaryStatus),
        '{{HW_DIARY_STATUS}}': hwDiaryStatus,
        '{{HW_DIARY_COLOR}}': getHwDetailColor(hwDiaryStatus),

        '{{BOOK_TITLE}}': reading.bookTitle || '읽은 책 없음',
        '{{BOOK_LEVEL}}': (reading.bookAR || reading.bookLexile) ? `${reading.bookAR || 'N/A'} / ${reading.bookLexile || 'N/A'}` : 'N/A',
        '{{WRITING_STATUS}}': reading.writingStatus || 'N/A'
    };

    return template.replace(new RegExp(Object.keys(replacements).join('|'), 'g'), (match) => {
        const value = replacements[match];
        return value !== null && value !== undefined ? value : '';
    });
}

function formatReportValue(value, type) {
    if (value === null || value === undefined) value = 'N/A';

    if (type === 'score' && value !== 'N/A') {
        return `${parseInt(value) || 0}<span class="text-2xl text-gray-500">점</span>`;
    }
    if (type === 'percent' && value !== 'N/A') {
        return `${parseInt(value) || 0}%`;
    }
    if (type === 'listen_status') {
        if (value === '완료') return '완료';
        if (value === '미완료') return '미완료';
        // [*** 유일한 수정 ***] 헤더님 파일 원본 로직 복구
        return 'N/A';
    }
    if (type === 'read_status') {
        if (value === '완료함') return '완료';
        if (value === '못함') return '미완료';
        return 'N/A';
    }
    return value; // 'N/A', 'PASS', 'FAIL' 등
}

app.get('/report', async (req, res) => {
    const { pageId, date } = req.query;

    if (!pageId || !date) {
        return res.status(400).send('필수 정보(pageId, date)가 누락되었습니다.');
    }
    if (!reportTemplate) {
        return res.status(500).send('서버 오류: 리포트 템플릿을 읽을 수 없습니다.');
    }

    try {
        const pageData = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        // [복구] 'parseDailyReportData' 원본 함수를 호출합니다.
        const parsedData = await parseDailyReportData(pageData);
        const finalHtml = fillReportTemplate(reportTemplate, parsedData);
        res.send(finalHtml);
    } catch (error) {
        console.error(`리포트 생성 오류 (PageID: ${pageId}):`, error);
        res.status(500).send(`리포트 생성 중 오류가 발생했습니다: ${error.message}`);
    }
});

// =======================================================================
// [신규] 월간 리포트 동적 생성 API (View)
// =======================================================================
// [삭제] 월간 리포트 관련 코드는 모두 monthlyReportModule.js로 이동했습니다.


// =======================================================================
// [신규] 자동화 스케줄링 (Cron Jobs)
// =======================================================================

// --- [신규] 1. 데일리 리포트 URL 자동 생성 (매일 밤 10시) ---
cron.schedule('0 22 * * *', async () => {
    console.log('--- [데일리 리포트] 자동화 스케줄 실행 (매일 밤 10시) ---');

    if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) {
        console.error('[데일리 리포트] DB ID가 설정되지 않아 스케줄을 중단합니다.');
        return;
    }

    try {
        const { start, end, dateString } = getKSTTodayRange();

        const filter = {
            // [수정] 스케줄러도 'or' 필터를 사용해야 합니다.
            "or": [
                {
                    "and": [
                        { property: '🕐 날짜', date: { on_or_after: start } },
                        { property: '🕐 날짜', date: { on_or_before: end } }
                    ]
                },
                { "property": "🕐 날짜", "date": { "equals": dateString } }
            ]
        };

        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: filter })
        });

        const pages = data.results;
        if (!pages || pages.length === 0) {
            console.log(`[데일리 리포트] ${dateString} 날짜에 해당하는 진도 페이지가 없습니다.`);
            return;
        }

        console.log(`[데일리 리포트] 총 ${pages.length}개의 오늘 진도 페이지를 찾았습니다.`);

        for (const page of pages) {
            try {
                const pageId = page.id;
                const reportUrl = `${DOMAIN_URL}/report?pageId=${pageId}&date=${dateString}`;

                const currentUrl = page.properties['데일리리포트URL']?.url;
                if (currentUrl === reportUrl) {
                    console.log(`[데일리 리포트] ${pageId} - 이미 URL이 존재합니다. (스킵)`);
                    continue;
                }

                await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        properties: {
                            '데일리리포트URL': { url: reportUrl }
                        }
                    })
                });
                console.log(`[데일리 리포트] ${pageId} - URL 저장 성공: ${reportUrl}`);
            } catch (pageError) {
                console.error(`[데일리 리포트] ${page.id} 업데이트 실패:`, pageError.message);
            }
        }
        console.log('--- [데일리 리포트] 자동화 스케줄 완료 ---');

    } catch (error) {
        console.error('--- [데일리 리포트] 자동화 스케줄 중 오류 발생 ---', error);
    }
}, {
    timezone: "Asia/Seoul"
});


// --- [신규] 2. 월간 리포트 URL 자동 생성 ---
// [삭제] 월간 리포트 cron job은 monthlyReportModule.js로 이동했습니다.


// [신규] 월간 리포트 모듈 초기화
// ----------------------------------------------------------------------
// index.js에 정의된 모든 헬퍼와 설정을 객체로 모아 전달합니다.
// ----------------------------------------------------------------------
try {
    const dbIds = {
        STUDENT_DATABASE_ID,
        PROGRESS_DATABASE_ID,
        KOR_BOOKS_ID,
        ENG_BOOKS_ID,
        MONTHLY_REPORT_DB_ID,
        GRAMMAR_DB_ID
    };

    const helpers = {
        getRollupValue,
        getSimpleText,
        getKSTTodayRange,
        getKoreanDate
    };
    
    initializeMonthlyReportRoutes({
        app,
        fetchNotion,
        geminiModel,
        dbIds,
        domainUrl: DOMAIN_URL,
        publicPath,
        ...helpers
    });
    console.log('✅ 월간 리포트 모듈(monthlyReportModule.js)이 성공적으로 연결되었습니다.');
} catch (e) {
    console.error('❌ 월간 리포트 모듈 연결에 실패했습니다:', e);
}



// --- 서버 실행 ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 최종 서버가 ${PORT} 포트에서 실행 중입니다.`);
});