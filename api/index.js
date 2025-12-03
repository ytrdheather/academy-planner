import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';

// [모듈 Import]
import { initializeMonthlyReportRoutes } from './monthlyReportModule.js';
import { initializeBookRoutes, processBookRelations } from './bookModule.js';

const {
    JWT_SECRET = 'dev-only-secret-readitude-2025',
    NOTION_ACCESS_TOKEN,
    STUDENT_DATABASE_ID,
    PROGRESS_DATABASE_ID,
    KOR_BOOKS_ID,
    ENG_BOOKS_ID,
    GEMINI_API_KEY,
    MONTHLY_REPORT_DB_ID,
    GRAMMAR_DB_ID,
    DOMAIN_URL = 'https://readitude.onrender.com'
} = process.env;

const PORT = process.env.PORT || 5001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const publicPath = path.join(__dirname, '../public');

// Notion API 호출 헬퍼 (재시도 로직 포함)
async function fetchNotion(url, options, retries = 3) {
    const headers = {
        'Authorization': `Bearer ${NOTION_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
    };
    
    try {
        const response = await fetch(url, { ...options, headers });

        // [409 Conflict] 에러 발생 시 재시도
        if (response.status === 409 && retries > 0) {
            console.warn(`⚠️ Notion API Conflict (409). 재시도 중... (남은 시도: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, 500)); 
            return fetchNotion(url, options, retries - 1);
        }

        if (!response.ok) {
            const errorData = await response.json();
            console.error(`Notion API Error (${url}):`, JSON.stringify(errorData, null, 2));
            throw new Error(errorData.message || `Notion API Error: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        throw error;
    }
}

// Gemini AI 설정
let genAI, geminiModel;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-09-2025' });
    console.log('✅ Gemini AI 연결됨');
}

// --- 선생님 계정 정보 ---
const userAccounts = {
    'manager': { password: 'rdtd112!@', role: 'manager', name: '원장 헤더쌤' },
    'teacher1': { password: 'rdtd112!@', role: 'manager', name: '조이쌤' },
    'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '주디쌤' },
    'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '소영쌤' },
    'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '레일라쌤' },
    'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '제니쌤' },
    'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '릴리쌤' }
};

// --- Helper Functions ---
function generateToken(userData) { return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; } }

function getKSTTodayRange() {
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffset);
    const kstDateString = kstNow.toISOString().split('T')[0];
    const start = new Date(`${kstDateString}T00:00:00.000+09:00`);
    const end = new Date(`${kstDateString}T23:59:59.999+09:00`);
    return { start: start.toISOString(), end: end.toISOString(), dateString: kstDateString };
}

function getKoreanDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' };
    return new Intl.DateTimeFormat('ko-KR', options).format(date);
}

const getRollupArray = (prop) => {
    if (!prop?.rollup?.array) return [];
    return prop.rollup.array.map(item => {
        if (item.type === 'number') return item.number;
        if (item.type === 'select') return item.select?.name;
        if (item.type === 'title') return item.title?.[0]?.plain_text;
        if (item.type === 'rich_text') return item.rich_text?.[0]?.plain_text;
        return null;
    });
};

const getRollupValue = (prop, isNumber = false) => {
    if (!prop?.rollup) return isNumber ? null : '';
    if (prop.rollup.type === 'number') return prop.rollup.number;
    if (prop.rollup.type === 'array' && prop.rollup.array.length > 0) {
        const item = prop.rollup.array[0];
        if (item.type === 'title') return item.title[0]?.plain_text || '';
        if (item.type === 'rich_text') return item.rich_text[0]?.plain_text || '';
        if (item.type === 'number') return item.number;
        if (item.type === 'select') return item.select?.name || '';
    }
    return isNumber ? null : '';
};

const getSimpleText = (prop) => {
    if (!prop) return '';
    if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('\n');
    if (prop.type === 'title') return prop.title[0]?.plain_text || '';
    if (prop.type === 'select') return prop.select?.name || '';
    return '';
};

async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
    if (!NOTION_ACCESS_TOKEN || !title || !databaseId) return null;
    try {
        let filterBody = { property: titlePropertyName, title: { equals: title } };
        if (titlePropertyName === '반이름') filterBody = { property: titlePropertyName, select: { equals: title } };
        else if (titlePropertyName === '책제목') filterBody = { property: titlePropertyName, rich_text: { equals: title } };

        const data = await fetchNotion(`https://api.notion.com/v1/databases/${databaseId}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: filterBody, page_size: 1 })
        });
        return data.results[0]?.id || null;
    } catch (error) { return null; }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '인증 토큰이 필요합니다' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: '유효하지 않은 토큰입니다' });
    req.user = decoded;
    next();
}

app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner-modular.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));

initializeBookRoutes(app, fetchNotion, process.env);
try {
    initializeMonthlyReportRoutes({
        app, fetchNotion, geminiModel,
        dbIds: { STUDENT_DATABASE_ID, PROGRESS_DATABASE_ID, KOR_BOOKS_ID, ENG_BOOKS_ID, MONTHLY_REPORT_DB_ID, GRAMMAR_DB_ID },
        domainUrl: DOMAIN_URL, publicPath,
        getRollupValue, getSimpleText, getKSTTodayRange, getKoreanDate
    });
} catch(e) { console.error('Monthly Report Module Init Error', e); }

async function parseDailyReportData(page) {
    const props = page.properties;
    const studentName = props['이름']?.title?.[0]?.plain_text || '학생';
    const pageDate = props['🕐 날짜']?.date?.start || getKSTTodayRange().dateString;

    let assignedTeachers = [];
    if (props['담당쌤']?.rollup?.array) {
        assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text))].filter(Boolean);
    }

    const homework = {
        grammar: props['⭕ 지난 문법 숙제 검사']?.status?.name || '해당 없음',
        vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '해당 없음',
        readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '해당 없음',
        summary: props['4️⃣ Summary 숙제']?.status?.name || '해당 없음',
        dailyReading: props['5️⃣ 독해서 풀기']?.status?.name || '해당 없음', 
        diary: props['6️⃣ 부&매&일']?.status?.name || '해당 없음'
    };

    // [점수 계산 로직] 100점 만점 환산 (숙제 없음 제외)
    const checkList = [
        homework.grammar,
        homework.vocabCards,
        homework.readingCards,
        homework.summary,
        homework.dailyReading,
        homework.diary,
        props['영어 더빙 학습 완료']?.status?.name,
        props['더빙 워크북 완료']?.status?.name,
        props['📖 영어독서']?.select?.name,
        props['어휘학습']?.select?.name
    ];

    let totalScore = 0;
    let count = 0;

    checkList.forEach(status => {
        if (!status) return;
        // 100점 그룹: 숙제 함, 완료, 완료함, 대체 등
        if (['숙제 함', '완료', '완료함', '원서독서로 대체', '듣기평가교재 완료'].includes(status)) {
            totalScore += 100;
            count++;
        } 
        // 0점 그룹: 안 해옴, 미완료, 못함 등
        else if (['안 해옴', '미완료', '못함', '못하고감'].includes(status)) {
            totalScore += 0;
            count++;
        }
        // 제외 그룹: 숙제 없음, 해당 없음, 진행하지 않음, SKIP 등 -> count 증가 안 함
    });

    // 항목이 하나도 없으면(모두 숙제 없음) N/A, 아니면 평균 점수
    const performanceRate = count > 0 ? Math.round(totalScore / count) : 'N/A';

    const getFormulaValue = (prop) => {
        if (!prop?.formula) return 'N/A';
        if (prop.formula.type === 'string') return prop.formula.string;
        if (prop.formula.type === 'number') return prop.formula.number;
        return 'N/A';
    };

    const tests = {
        vocabUnit: getSimpleText(props['어휘유닛']),
        vocabCorrect: props['단어(맞은 개수)']?.number ?? null,
        vocabTotal: props['단어(전체 개수)']?.number ?? null,
        vocabScore: getFormulaValue(props['📰 단어 테스트 점수']),
        readingWrong: props['독해(틀린 개수)']?.number ?? null,
        readingResult: getFormulaValue(props['📚 독해 해석 시험 결과']),
        havruta: props['독해 하브루타']?.select?.name || '숙제없음',
        grammarTotal: props['문법(전체 개수)']?.number ?? null,
        grammarWrong: props['문법(틀린 개수)']?.number ?? null,
        grammarScore: getFormulaValue(props['📑 문법 시험 점수'])
    };

    const listening = {
        study: props['영어 더빙 학습 완료']?.status?.name || '진행하지 않음',
        workbook: props['더빙 워크북 완료']?.status?.name || '진행하지 않음',
        koreanBooks: (() => {
            const titles = getRollupArray(props['국어책제목(롤업)']);
            const ids = props['국어 독서 제목']?.relation?.map(r => r.id) || [];
            return titles.map((t, i) => ({ title: t, id: ids[i] || null }));
        })(),
        giantStatus: props['📕 책 읽는 거인']?.select?.name || ''
    };

    const engBookTitles = getRollupArray(props['📖 책제목 (롤업)']);
    const engBookARs = getRollupArray(props['AR']); 
    const engBookLexiles = getRollupArray(props['Lexile']); 
    const engBookIds = props['오늘 읽은 영어 책']?.relation?.map(r => r.id) || [];
    
    const englishBooks = engBookTitles.map((title, idx) => ({ 
        title: title, 
        id: engBookIds[idx] || null,
        ar: engBookARs[idx] || null,
        lexile: engBookLexiles[idx] || null
    }));

    const reading = {
        readingStatus: props['📖 영어독서']?.select?.name || '',
        vocabStatus: props['어휘학습']?.select?.name || '',
        bookTitle: getRollupValue(props['📖 책제목 (롤업)']) || '읽은 책 없음',
        englishBooks: englishBooks, 
        bookSeries: getRollupValue(props['시리즈이름']),
        bookAR: getRollupValue(props['AR'], true),
        bookLexile: getRollupValue(props['Lexile'], true),
        writingStatus: props['Writing']?.select?.name || 'N/A'
    };

    const grammarClassName = getRollupValue(props['문법클래스']) || null;
    let grammarTopic = getSimpleText(props['오늘 문법 진도']);
    let grammarHomework = getSimpleText(props['문법 숙제 내용']) || getSimpleText(props['문법 과제 내용']);

    const comment = {
        teacherComment: getSimpleText(props['❤ Today\'s Notice!']) || '오늘의 코멘트가 없습니다.',
        grammarClass: grammarClassName || '진도 해당 없음',
        grammarTopic: grammarTopic || '진도 해당 없음', 
        grammarHomework: grammarHomework || '숙제 내용 없음'
    };

    return {
        pageId: page.id,
        studentName,
        studentRelationId: props['학생']?.relation?.[0]?.id || null,
        date: pageDate,
        teachers: assignedTeachers,
        completionRate: performanceRate, // 계산된 점수
        homework, tests, listening, reading, comment
    };
}

async function fetchProgressData(req, res, parseFunction) {
    const { period = 'today', date } = req.query;
    if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) throw new Error('Server config error');
    
    let dateString;
    if (period === 'specific_date' && date) {
        dateString = date;
    } else {
        dateString = getKSTTodayRange().dateString;
    }

    const finalFilter = {
        "property": "🕐 날짜",
        "date": { "equals": dateString }
    };

    const pages = [];
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: finalFilter,
                sorts: [{ property: '🕐 날짜', direction: 'descending' }, { property: '이름', direction: 'ascending' }],
                page_size: 100, start_cursor: startCursor
            })
        });
        pages.push(...data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
    }
    return await Promise.all(pages.map(parseFunction));
}

app.get('/api/daily-report-data', requireAuth, async (req, res) => {
    try {
        const data = await fetchProgressData(req, res, parseDailyReportData);
        res.json(data);
    } catch (error) {
        console.error('Daily Report Data Error:', error);
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/update-grammar-by-class', requireAuth, async (req, res) => {
    const { className, topic, homework, date } = req.body; 
    if (!className || !date) { return res.status(400).json({ success: false, message: '반 이름과 날짜는 필수입니다.' }); }
    const targetClass = className.trim();
    try {
        const filter = { "property": "🕐 날짜", "date": { "equals": date } };
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter }) });
        const students = query.results;
        let updatedCount = 0;
        const updatePromises = students.map(async (page) => {
            const studentClass = getRollupValue(page.properties['문법클래스']);
            if (studentClass && studentClass.trim() === targetClass) {
                await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties: { '오늘 문법 진도': { rich_text: [{ text: { content: topic || '' } }] }, '문법 숙제 내용': { rich_text: [{ text: { content: homework || '' } }] } } })
                });
                updatedCount++;
            }
        });
        await Promise.all(updatePromises);
        res.json({ success: true, message: `${updatedCount}명의 학생(${targetClass})에게 문법 숙제를 배포했습니다.` });
    } catch (error) { console.error('Grammar batch update error:', error); res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/update-homework', requireAuth, async (req, res) => {
    const { pageId, propertyName, newValue, propertyType, updates } = req.body;
    if (!pageId) return res.status(400).json({ success: false, message: 'Page ID missing' });
    try {
        const mapPropName = (name) => {
            const mapping = { "단어 (맞은 개수)": "단어(맞은 개수)", "단어 (전체 개수)": "단어(전체 개수)", "문법 (전체 개수)": "문법(전체 개수)", "문법 (틀린 개수)": "문법(틀린 개수)", "독해 (틀린 개수)": "독해(틀린 개수)", "5️⃣ 매일 독해 숙제": "5️⃣ 독해서 풀기", "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 부&매&일", "오늘 읽은 한국 책": "국어 독서 제목", "문법 과제 내용": "문법 숙제 내용" };
            return mapping[name] || name; 
        };
        const mapValue = (val) => { if (val === "해당 없음" || val === "해당없음") return "숙제 없음"; return val; };
        const propertiesToUpdate = {};
        if (updates && typeof updates === 'object') {
            for (const [propName, valObj] of Object.entries(updates)) {
                const notionPropName = mapPropName(propName); const val = mapValue(valObj.value); const type = valObj.type || 'status'; let payload;
                if (type === 'number') payload = { number: Number(val) || 0 }; else if (type === 'rich_text') payload = { rich_text: [{ text: { content: val || '' } }] }; else if (type === 'select') payload = { select: val ? { name: val } : null }; else if (type === 'relation') { if (Array.isArray(val)) payload = { relation: val.map(id => ({ id })) }; else payload = { relation: val ? [{ id: val }] : [] }; } else if (type === 'status') payload = { status: { name: val || '숙제 없음' } };
                propertiesToUpdate[notionPropName] = payload;
            }
        } else if (propertyName) {
            const notionPropName = mapPropName(propertyName); const val = mapValue(newValue); let payload;
            if (propertyType === 'number') payload = { number: Number(val) || 0 }; else if (propertyType === 'rich_text') payload = { rich_text: [{ text: { content: val || '' } }] }; else if (propertyType === 'select') payload = { select: val ? { name: val } : null }; else if (propertyType === 'relation') { if (Array.isArray(val)) payload = { relation: val.map(id => ({ id })) }; else payload = { relation: val ? [{ id: val }] : [] }; } else if (propertyType === 'status') payload = { status: { name: val || '숙제 없음' } };
            propertiesToUpdate[notionPropName] = payload;
        } else { return res.status(400).json({ success: false, message: 'No update data provided' }); }
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: propertiesToUpdate }) });
        res.json({ success: true });
    } catch (error) { console.error('Update Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/teachers', requireAuth, async (req, res) => { const list = Object.values(userAccounts).filter(a => a.role === 'teacher' || a.role === 'manager').map(a => ({ name: a.name })); res.json(list); });
app.post('/teacher-login', async (req, res) => { const { teacherId, teacherPassword } = req.body; const account = userAccounts[teacherId]; if (account && account.password === teacherPassword) { const token = generateToken({ loginId: teacherId, name: account.name, role: account.role }); res.json({ success: true, token }); } else { res.status(401).json({ success: false, message: 'Invalid credentials' }); } });
app.get('/api/teacher/user-info', requireAuth, (req, res) => { res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId }); });
app.get('/api/user-info', requireAuth, (req, res) => { res.json({ userId: req.user.userId, userName: req.user.name, userRole: req.user.role }); });
app.get('/api/student-info', requireAuth, (req, res) => { if (req.user.role !== 'student') return res.status(401).json({ error: 'Students only' }); res.json({ studentId: req.user.userId, studentName: req.user.name }); });
app.post('/login', async (req, res) => { const { studentId, studentPassword } = req.body; try { const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] } }) }); if (data.results.length > 0) { const name = data.results[0].properties['이름']?.title?.[0]?.plain_text || studentId; const token = generateToken({ userId: studentId, role: 'student', name: name }); res.json({ success: true, token }); } else { res.json({ success: false, message: '로그인 실패' }); } } catch (e) { res.status(500).json({ success: false, message: 'Error' }); } });
app.post('/save-progress', requireAuth, async (req, res) => {
    const formData = req.body;
    const studentName = req.user.name;
    try {
        const ALLOWED_PROPS = { "영어 더빙 학습 완료": "영어 더빙 학습 완료", "더빙 워크북 완료": "더빙 워크북 완료", "⭕ 지난 문법 숙제 검사": "⭕ 지난 문법 숙제 검사", "1️⃣ 어휘 클카 암기 숙제": "1️⃣ 어휘 클카 암기 숙제", "2️⃣ 독해 단어 클카 숙제": "2️⃣ 독해 단어 클카 숙제", "4️⃣ Summary 숙제": "4️⃣ Summary 숙제", "5️⃣ 독해서 풀기": "5️⃣ 독해서 풀기", "6️⃣ 부&매&일": "6️⃣ 부&매&일", "단어 (맞은 개수)": "단어(맞은 개수)", "단어 (전체 개수)": "단어(전체 개수)", "어휘유닛": "어휘유닛", "문법 (전체 개수)": "문법(전체 개수)", "문법 (틀린 개수)": "문법(틀린 개수)", "독해 (틀린 개수)": "독해(틀린 개수)", "독해 하브루타": "독해 하브루타", "📖 영어독서": "📖 영어독서", "어휘학습": "어휘학습", "Writing": "Writing", "📕 책 읽는 거인": "📕 책 읽는 거인", "오늘의 학습 소감": "오늘의 학습 소감" };
        const valueMapping = { "해당없음": "숙제 없음", "안 해옴": "안 해옴", "숙제 함": "숙제 함", "진행하지 않음": "진행하지 않음", "완료": "완료", "미완료": "미완료", "원서독서로 대체": "원서독서로 대체", "듣기평가교재 완료": "듣기평가교재 완료", "못함": "못함", "완료함": "완료함", "SKIP": "SKIP", "안함": "안함", "숙제없음": "숙제없음", "못하고감": "못하고감", "시작함": "시작함", "절반": "절반", "거의다읽음": "거의다읽음" };
        const properties = {};
        for (let key in formData) { if (key === 'englishBooks' || key === 'koreanBooks') continue; if (!ALLOWED_PROPS.hasOwnProperty(key)) continue; let rawValue = formData[key]; if (rawValue === undefined || rawValue === '') continue; let value = valueMapping[rawValue] || rawValue; const notionPropName = ALLOWED_PROPS[key]; if (key.includes('(맞은 개수)') || key.includes('(전체 개수)') || key.includes('(틀린 개수)')) { const numVal = Number(value); properties[notionPropName] = { number: isNaN(numVal) ? 0 : numVal }; } else if (['독해 하브루타', '📖 영어독서', '어휘학습', 'Writing', '📕 책 읽는 거인'].includes(key)) { properties[notionPropName] = { select: { name: value } }; } else if (['어휘유닛', '오늘의 학습 소감'].includes(key)) { properties[notionPropName] = { rich_text: [{ text: { content: value } }] }; } else { properties[notionPropName] = { status: { name: value } }; } }
        if (formData.englishBooks && Array.isArray(formData.englishBooks)) { properties['오늘 읽은 영어 책'] = await processBookRelations(formData.englishBooks, ENG_BOOKS_ID, 'Title'); }
        if (formData.koreanBooks && Array.isArray(formData.koreanBooks)) { properties['국어 독서 제목'] = await processBookRelations(formData.koreanBooks, KOR_BOOKS_ID, '책제목'); }
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '이름', title: { equals: studentName } }, { property: '🕐 날짜', date: { equals: dateString } } ] };
        const existingPageQuery = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter, page_size: 1 }) });
        if (existingPageQuery.results.length > 0) { await fetchNotion(`https://api.notion.com/v1/pages/${existingPageQuery.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) }); } else { properties['이름'] = { title: [{ text: { content: studentName } }] }; properties['🕐 날짜'] = { date: { start: dateString } }; const studentPageId = await findPageIdByTitle(STUDENT_DATABASE_ID, studentName, '이름'); if (studentPageId) properties['학생'] = { relation: [{ id: studentPageId }] }; await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: PROGRESS_DATABASE_ID }, properties }) }); }
        res.json({ success: true, message: '저장 완료' });
    } catch (error) { console.error('Save Error:', error); res.status(500).json({ success: false, message: error.message }); }
});
app.get('/api/get-today-progress', requireAuth, async (req, res) => {
    const studentName = req.user.name;
    try {
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '이름', title: { equals: studentName } }, { property: '🕐 날짜', date: { equals: dateString } } ] };
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter, page_size: 1 }) });
        if (query.results.length === 0) return res.json({ success: true, progress: null });
        const props = query.results[0].properties;
        const progress = {};
        for (const [key, value] of Object.entries(props)) { if (value.type === 'title') progress[key] = value.title[0]?.plain_text; else if (value.type === 'rich_text') progress[key] = value.rich_text[0]?.plain_text; else if (value.type === 'number') progress[key] = value.number; else if (value.type === 'select') progress[key] = value.select?.name; else if (value.type === 'status') progress[key] = value.status?.name; }
        const engBookTitles = getRollupArray(props['📖 책제목 (롤업)']); const engBookARs = getRollupArray(props['AR']); const engBookLexiles = getRollupArray(props['Lexile']); const engBookIds = props['오늘 읽은 영어 책']?.relation?.map(r => r.id) || []; progress.englishBooks = engBookTitles.map((title, idx) => ({ title: title, id: engBookIds[idx] || null, ar: engBookARs[idx] || null, lexile: engBookLexiles[idx] || null }));
        const korBookTitles = getRollupArray(props['국어책제목(롤업)']); const korBookIds = props['국어 독서 제목']?.relation?.map(r => r.id) || []; progress.koreanBooks = korBookTitles.map((title, idx) => ({ title, id: korBookIds[idx] || null }));
        res.json({ success: true, progress });
    } catch (error) { console.error('Load Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

let reportTemplate = '';
try {
    reportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'dailyreport.html'), 'utf-8');
} catch (e) { console.error('Template load error', e); }

// [신규] 리포트 색상 결정 함수
function getReportColor(value, type) {
    const GREEN = '#10b981';
    const RED = '#ef4444';
    const GRAY = '#9ca3af';

    if (type === 'score') {
        if (value === 'N/A' || value === null) return GRAY;
        const num = parseInt(value);
        return (!isNaN(num) && num >= 80) ? GREEN : RED;
    }
    if (type === 'result') {
        if (value === 'PASS') return GREEN;
        if (value === 'FAIL') return RED;
        return GRAY;
    }
    if (type === 'status') {
        if (value === '완료' || value === '완료함') return GREEN;
        if (value === '미완료' || value === '못함' || value === '안 해옴') return RED;
        return GRAY;
    }
    if (type === 'hw_detail') {
        if (value === '숙제 함') return GREEN;
        if (value === '안 해옴') return RED;
        return GRAY;
    }
    return GRAY;
}
// [신규] AI 일일 코멘트 생성 API
app.post('/api/generate-daily-comment', requireAuth, async (req, res) => {
    const { pageId, studentName, keywords } = req.body;

    if (!pageId || !keywords) {
        return res.status(400).json({ success: false, message: '필수 정보가 누락되었습니다.' });
    }

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ success: false, message: 'AI 기능이 서버에 설정되지 않았습니다.' });
    }

    try {
        // 1. 해당 학생의 오늘 학습 데이터(페이지 정보)를 가져옵니다.
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsedData = await parseDailyReportData(page); // 기존 파싱 함수 재사용

        // 2. 프롬프트 작성 (헤더님 요청 사항 반영)
        const prompt = `
        너는 영어 학원 선생님이고, 지금 학부모님께 보낼 학생의 '일일 학습 코멘트'를 작성해야 해.
        
        [역할]
        - 초중고 학생을 가르치는 영어 전문가이자, 따뜻하고 유쾌한 선생님.
        - 학생의 발전을 진심으로 응원하는 말투 사용 (존댓말, 이모지 적절히 사용).
        
        [입력 정보]
        - 학생 이름: ${studentName}
        - 오늘의 키워드: ${keywords}
        - 숙제 수행율: ${parsedData.completionRate}%
        - 테스트 결과: 
          * 문법: ${parsedData.tests.grammarScore}점 (오답 ${parsedData.tests.grammarWrong}개)
          * 어휘: ${parsedData.tests.vocabScore}점 (오답 ${parsedData.tests.vocabTotal - parsedData.tests.vocabCorrect}개)
          * 독해: ${parsedData.tests.readingResult} (오답 ${parsedData.tests.readingWrong}개)
          * 리스닝/더빙: ${parsedData.listening.study}
          * 원서 독서: ${parsedData.reading.readingStatus}
        
        [작성 규칙]
        
        1. 첫 번째 문단 (키워드 중심 스토리텔링):
           - 입력된 키워드(${keywords})를 사용하여 학생의 오늘 수업 태도나 에피소드를 자연스럽게 서술해줘.
           - 예시처럼 키워드를 문장에 자연스럽게 녹여내야 해.
           - 예시 :  오늘 우리 예준이가 수업 시간에 집중을 정말 잘해줬습니다. 특히 독해 시간에 시간을 아주 효율적으로 알차게 쓰고 갔어요. 😁 
           시험 볼 때는 잠깐 피곤했는지 살짝 졸기도 했는데요 😴 그래도 금방 잠 깨고 다시 마음 다잡고 집중하더니 결과까지 좋게 나와서 폭풍 칭찬 해주었습니다 👏
           피곤할 텐데도 스스로 이겨내고 끝까지 잘해낸 모습이 참 기특하네요. 댁에서도 오늘 정말 수고했다고 따뜻한 말 한마디 건네주세요! ^_^
        
        2. 두 번째 문단 (학습 현황 피드백):
           - 숙제 수행율이 ${parsedData.completionRate}%임.
             * 100%: "완벽합니다! 계속 이렇게만 해 주세요! >_<" 칭찬
             * 80% 이상: "아주 훌륭해요! 그래도 완벽한 숙제 수행을 노려봅시다." 칭찬
             * 70% 이상: "조금 더 숙제 수행율을 높이도록 노력하면 좋겠어요" 격려
             * 69% 이하: "숙제 미흡으로 보강이 필요합니다. ㅠㅠ 보강 스케줄 참고하셔서(카톡채널 소식 확인해 주세요!) 패널티 보강 보내주세요!"라고 안내.
           
           - 학습 성취 코멘트:
             * 'N/A'나 '해당 없음'인 항목은 언급하지 마.
             * PASS 하거나 점수가 좋은 항목(80점 이상)은 칭찬해줘.
             * 미완료되거나 점수가 낮은 항목, FAIL한 항목은 "다음 시간에 더 나은 결과로 꼼꼼히 채우겠습니다."라는 긍정적인 멘트로 마무리해줘.
        
        3. 마무리 인사:
           - 오늘의 긍정적 성취 1가지를 콕 집어 칭찬.
           - 부족했던 점이나 아쉬운 점 1가지에 대한 대안 제시.
           - 따뜻한 끝인사. (예: 댁에서도 격려 부탁드립니다 ^^)
        
        [출력 형식]
        - 바로 복사해서 보낼 수 있도록 코멘트 본문만 작성해줘.
        - 문단 사이에는 줄바꿈을 넣어줘.
        - 조금의 이모지 사용은 괜찮아! 환기성으로 문단 앞에 써줘.
        `;

        // 3. AI에게 요청
        const result = await geminiModel.generateContent(prompt);
        const generatedComment = result.response.text();

        res.json({ success: true, comment: generatedComment });

    } catch (error) {
        console.error('AI Comment Generation Error:', error);
        res.status(500).json({ success: false, message: 'AI 코멘트 생성 중 오류가 발생했습니다.' });
    }
});

app.get('/report', async (req, res) => {
    const { pageId, date } = req.query;
    if (!pageId) return res.status(400).send('Missing info');
    
    try {
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsed = await parseDailyReportData(page);
        
        let html = reportTemplate;
        const bookTitleStr = parsed.reading.englishBooks && parsed.reading.englishBooks.length > 0
            ? parsed.reading.englishBooks.map(b => b.title).join(', ')
            : (parsed.reading.bookTitle || '읽은 책 없음');

        // [핵심 수정] 데이터 연결 복구 및 색상 적용
        const replacements = {
            '{{STUDENT_NAME}}': parsed.studentName,
            '{{REPORT_DATE}}': getKoreanDate(parsed.date),
            '{{TEACHER_COMMENT}}': parsed.comment.teacherComment.replace(/\n/g, '<br>'),
            
            '{{HW_SCORE}}': parsed.completionRate === 'N/A' ? 'N/A' : parsed.completionRate + '%',
            '{{HW_SCORE_COLOR}}': getReportColor(parsed.completionRate === 'N/A' ? null : parsed.completionRate, 'score'),
            
            '{{GRAMMAR_SCORE}}': parsed.tests.grammarScore,
            '{{GRAMMAR_SCORE_COLOR}}': getReportColor(parsed.tests.grammarScore, 'score'),
            
            '{{VOCAB_SCORE}}': parsed.tests.vocabScore,
            '{{VOCAB_SCORE_COLOR}}': getReportColor(parsed.tests.vocabScore, 'score'),
            
            '{{READING_TEST_STATUS}}': parsed.tests.readingResult,
            '{{READING_TEST_COLOR}}': getReportColor(parsed.tests.readingResult, 'result'),
            
            '{{LISTENING_STATUS}}': parsed.listening.study,
            '{{LISTENING_COLOR}}': getReportColor(parsed.listening.study, 'status'),
            // [폰트 크기 조절]
            '{{LISTENING_FONT_CLASS}}': (parsed.listening.study && parsed.listening.study.length > 5) ? 'text-lg' : 'text-4xl',
            
            '{{READING_BOOK_STATUS}}': parsed.reading.readingStatus,
            '{{READING_BOOK_COLOR}}': getReportColor(parsed.reading.readingStatus, 'status'),

            // [숙제 상세 연결]
            '{{HW_GRAMMAR_STATUS}}': parsed.homework.grammar,
            '{{HW_GRAMMAR_COLOR}}': getReportColor(parsed.homework.grammar, 'hw_detail'),
            
            '{{HW_VOCAB_STATUS}}': parsed.homework.vocabCards,
            '{{HW_VOCAB_COLOR}}': getReportColor(parsed.homework.vocabCards, 'hw_detail'),
            
            '{{HW_READING_CARD_STATUS}}': parsed.homework.readingCards,
            '{{HW_READING_CARD_COLOR}}': getReportColor(parsed.homework.readingCards, 'hw_detail'),
            
            '{{HW_SUMMARY_STATUS}}': parsed.homework.summary,
            '{{HW_SUMMARY_COLOR}}': getReportColor(parsed.homework.summary, 'hw_detail'),
            
            '{{HW_DIARY_STATUS}}': parsed.homework.diary,
            '{{HW_DIARY_COLOR}}': getReportColor(parsed.homework.diary, 'hw_detail'),

            '{{GRAMMAR_CLASS_TOPIC}}': parsed.comment.grammarTopic,
            '{{GRAMMAR_HW_DETAIL}}': parsed.comment.grammarHomework,
            '{{BOOK_TITLE}}': bookTitleStr, 
            '{{BOOK_LEVEL}}': (parsed.reading.bookAR || parsed.reading.bookLexile) ? `${parsed.reading.bookAR || 'N/A'} / ${parsed.reading.bookLexile || 'N/A'}` : 'N/A',
            '{{WRITING_STATUS}}': parsed.reading.writingStatus,

            '{{RD_CHECK_POINT_SCORE}}': parsed.completionRate // 100점 만점 환산 점수
        };
        
        for (const [key, val] of Object.entries(replacements)) {
            html = html.split(key).join(val || 'N/A');
        }
        res.send(html);
    } catch (e) { 
        console.error('리포트 생성 중 오류:', e);
        res.status(500).send('Report Error'); 
    }
});

cron.schedule('0 22 * * *', async () => {
    console.log('--- 데일리 리포트 URL 자동 생성 ---');
    try {
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: dateString } } ] };
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter }) });
        for (const page of data.results) {
            const url = `${DOMAIN_URL}/report?pageId=${page.id}&date=${dateString}`;
            if (page.properties['데일리리포트URL']?.url === url) continue;
            await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) });
        }
    } catch (e) { console.error('Cron Error', e); }
}, { timezone: "Asia/Seoul" });

cron.schedule('50 21 * * *', async () => {
    console.log('--- [문법 숙제 동기화] 자동화 스케줄 실행 (21:50) ---');
    // ... (동일)
}, { timezone: "Asia/Seoul" });

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Final Server running on ${PORT}`));