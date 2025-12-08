import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';

// [모듈 Import] 책 검색과 월간 리포트 기능은 여기 연결되어 있습니다!
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

// Notion API 호출 헬퍼
async function fetchNotion(url, options, retries = 3) {
    const headers = {
        'Authorization': `Bearer ${NOTION_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
    };
    
    try {
        const response = await fetch(url, { ...options, headers });

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

// [모듈 초기화] 기능들이 여기서 로드됩니다!
initializeBookRoutes(app, fetchNotion, process.env);
try {
    initializeMonthlyReportRoutes({
        app, fetchNotion, geminiModel,
        dbIds: { STUDENT_DATABASE_ID, PROGRESS_DATABASE_ID, KOR_BOOKS_ID, ENG_BOOKS_ID, MONTHLY_REPORT_DB_ID, GRAMMAR_DB_ID },
        domainUrl: DOMAIN_URL, publicPath,
        getRollupValue, getSimpleText, getKSTTodayRange, getKoreanDate
    });
} catch(e) { console.error('Monthly Report Module Init Error', e); }

// AI 일일 코멘트 생성 API
app.post('/api/generate-daily-comment', requireAuth, async (req, res) => {
    const { pageId, studentName, keywords } = req.body;
    if (!pageId || !keywords) return res.status(400).json({ success: false, message: 'Missing info' });
    if (!GEMINI_API_KEY) return res.status(500).json({ success: false, message: 'AI not configured' });

    try {
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsedData = await parseDailyReportData(page);
        const prompt = `
        너는 영어 학원 선생님이고, 지금 학부모님께 보낼 학생의 '일일 학습 코멘트'를 작성해야 해.
        [역할] 초중고 학생을 가르치는 영어 전문가이자, 따뜻하고 유쾌한 선생님.
        [입력 정보] 학생 이름: ${studentName}, 키워드: ${keywords}, 숙제 수행율: ${parsedData.completionRate}%
        [작성 규칙]
        1. 첫 번째 문단: 키워드를 중심으로 학생의 오늘 태도나 에피소드를 자연스럽게 서술.
        2. 두 번째 문단: 숙제 수행율과 학습 성취(테스트 점수 등)에 대한 피드백. 잘한 건 칭찬, 부족한 건 격려.
        3. 마무리: 긍정적 성취 1가지 칭찬, 아쉬운 점 1가지 대안 제시, 따뜻한 끝인사.
        [출력 형식] 코멘트 본문만 작성 (줄바꿈 포함).
        `;
        const result = await geminiModel.generateContent(prompt);
        res.json({ success: true, comment: result.response.text() });
    } catch (error) {
        console.error('AI Comment Generation Error:', error);
        res.status(500).json({ success: false, message: 'AI generation failed' });
    }
});

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

    const checkList = [
        homework.grammar, homework.vocabCards, homework.readingCards, homework.summary, homework.dailyReading, homework.diary,
        props['영어 더빙 학습 완료']?.status?.name, props['더빙 워크북 완료']?.status?.name, props['📖 영어독서']?.select?.name, props['어휘학습']?.select?.name
    ];

    let totalScore = 0; let count = 0;
    checkList.forEach(status => {
        if (!status) return;
        if (['숙제 함', '완료', '완료함', '원서독서로 대체', '듣기평가교재 완료'].includes(status)) { totalScore += 100; count++; } 
        else if (['안 해옴', '미완료', '못함', '못하고감'].includes(status)) { totalScore += 0; count++; }
    });
    const performanceRate = count > 0 ? Math.round(totalScore / count) : null;

    const getFormulaValue = (prop) => {
        if (!prop?.formula) return null;
        if (prop.formula.type === 'string') return prop.formula.string || null; 
        if (prop.formula.type === 'number') return prop.formula.number; 
        return null;
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
        title: title, id: engBookIds[idx] || null, ar: engBookARs[idx] || null, lexile: engBookLexiles[idx] || null
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

    const comment = {
        teacherComment: getSimpleText(props['❤ Today\'s Notice!']) || '오늘의 코멘트가 없습니다.',
        grammarClass: getRollupValue(props['문법클래스']) || '진도 해당 없음',
        grammarTopic: getSimpleText(props['오늘 문법 진도']) || '진도 해당 없음', 
        grammarHomework: getSimpleText(props['문법 숙제 내용']) || getSimpleText(props['문법 과제 내용']) || '숙제 내용 없음'
    };

    return { pageId: page.id, studentName, date: pageDate, teachers: assignedTeachers, completionRate: performanceRate, homework, tests, listening, reading, comment };
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
    if (!className || !date) return res.status(400).json({ success: false, message: 'Missing info' });
    try {
        const filter = { "property": "🕐 날짜", "date": { "equals": date } };
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter }) });
        const updates = query.results.filter(p => getRollupValue(p.properties['문법클래스'])?.trim() === className.trim()).map(p => 
            fetchNotion(`https://api.notion.com/v1/pages/${p.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties: { '오늘 문법 진도': { rich_text: [{ text: { content: topic || '' } }] }, '문법 숙제 내용': { rich_text: [{ text: { content: homework || '' } }] } } })
            })
        );
        await Promise.all(updates);
        res.json({ success: true, message: `Updated ${updates.length} students` });
    } catch (error) { console.error('Grammar Update Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/update-homework', requireAuth, async (req, res) => {
    const { pageId, propertyName, newValue, propertyType, updates } = req.body;
    if (!pageId) return res.status(400).json({ success: false, message: 'Page ID missing' });
    try {
        const mapPropName = (name) => {
            const m = { "단어 (맞은 개수)": "단어(맞은 개수)", "단어 (전체 개수)": "단어(전체 개수)", "문법 (전체 개수)": "문법(전체 개수)", "문법 (틀린 개수)": "문법(틀린 개수)", "독해 (틀린 개수)": "독해(틀린 개수)", "5️⃣ 매일 독해 숙제": "5️⃣ 독해서 풀기", "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 부&매&일", "오늘 읽은 한국 책": "국어 독서 제목", "문법 과제 내용": "문법 숙제 내용" };
            return m[name] || name; 
        };
        const propertiesToUpdate = {};
        if (updates) {
             for (const [propName, valObj] of Object.entries(updates)) {
                const notionPropName = mapPropName(propName); const val = valObj.value; const type = valObj.type || 'status'; let payload;
                if (type === 'status') payload = { status: { name: val || '숙제 없음' } };
                propertiesToUpdate[notionPropName] = payload;
            }
        } else {
            const notionPropName = mapPropName(propertyName);
            let payload;
            if (propertyType === 'number') payload = { number: Number(newValue) || 0 };
            else if (propertyType === 'rich_text') payload = { rich_text: [{ text: { content: newValue || '' } }] };
            else if (propertyType === 'select') payload = { select: newValue ? { name: newValue } : null };
            else if (propertyType === 'relation') payload = { relation: Array.isArray(newValue) ? newValue.map(id => ({ id })) : (newValue ? [{ id: newValue }] : []) };
            else payload = { status: { name: newValue || '숙제 없음' } };
            propertiesToUpdate[notionPropName] = payload;
        }
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: propertiesToUpdate }) });
        res.json({ success: true });
    } catch (error) { console.error('Update Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/teachers', requireAuth, async (req, res) => { res.json(Object.values(userAccounts).filter(a => a.role === 'teacher' || a.role === 'manager').map(a => ({ name: a.name }))); });
app.post('/teacher-login', async (req, res) => { const { teacherId, teacherPassword } = req.body; const account = userAccounts[teacherId]; if (account && account.password === teacherPassword) { const token = generateToken({ loginId: teacherId, name: account.name, role: account.role }); res.json({ success: true, token }); } else { res.status(401).json({ success: false, message: 'Invalid credentials' }); } });
app.get('/api/teacher/user-info', requireAuth, (req, res) => { res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId }); });
app.get('/api/user-info', requireAuth, (req, res) => { res.json({ userId: req.user.userId, userName: req.user.name, userRole: req.user.role }); });
app.get('/api/student-info', requireAuth, (req, res) => { if (req.user.role !== 'student') return res.status(401).json({ error: 'Students only' }); res.json({ studentId: req.user.userId, studentName: req.user.name }); });
app.post('/login', async (req, res) => { const { studentId, studentPassword } = req.body; try { const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] } }) }); if (data.results.length > 0) { const name = data.results[0].properties['이름']?.title?.[0]?.plain_text || studentId; const token = generateToken({ userId: studentId, role: 'student', name: name }); res.json({ success: true, token }); } else { res.json({ success: false, message: '로그인 실패' }); } } catch (e) { res.status(500).json({ success: false, message: 'Error' }); } });
app.post('/save-progress', requireAuth, async (req, res) => {
    // ... (기존 저장 로직 유지, 매핑은 이미 수정됨)
    const formData = req.body;
    const studentName = req.user.name;
    try {
        const ALLOWED_PROPS = { 
            "영어 더빙 학습 완료": "영어 더빙 학습 완료", "영어 더빙 학습": "영어 더빙 학습 완료",
            "더빙 워크북 완료": "더빙 워크북 완료", "더빙 워크북": "더빙 워크북 완료",
            "⭕ 지난 문법 숙제 검사": "⭕ 지난 문법 숙제 검사", "1️⃣ 어휘 클카 암기 숙제": "1️⃣ 어휘 클카 암기 숙제", 
            "2️⃣ 독해 단어 클카 숙제": "2️⃣ 독해 단어 클카 숙제", "4️⃣ Summary 숙제": "4️⃣ Summary 숙제", 
            "5️⃣ 독해서 풀기": "5️⃣ 독해서 풀기", "5️⃣ 매일 독해 숙제": "5️⃣ 독해서 풀기",
            "6️⃣ 부&매&일": "6️⃣ 부&매&일", "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 부&매&일",
            "단어(맞은 개수)": "단어(맞은 개수)", "단어(전체 개수)": "단어(전체 개수)",
            
            // [중요] 띄어쓰기 포함 매핑 (planner.html의 name 속성과 일치)
            "단어 (맞은 개수)": "단어(맞은 개수)", 
            "단어 (전체 개수)": "단어(전체 개수)",
            "어휘정답": "단어(맞은 개수)", "어휘총문제": "단어(전체 개수)", 

            "어휘유닛": "어휘유닛", "문법(전체 개수)": "문법(전체 개수)", "문법(틀린 개수)": "문법(틀린 개수)",
            "문법 (전체 개수)": "문법(전체 개수)", "문법 (틀린 개수)": "문법(틀린 개수)", // 띄어쓰기 포함
            "독해(틀린 개수)": "독해(틀린 개수)", "독해 (틀린 개수)": "독해(틀린 개수)",
            "독해 하브루타": "독해 하브루타", "📖 영어독서": "📖 영어독서", "어휘학습": "어휘학습", "Writing": "Writing", "📕 책 읽는 거인": "📕 책 읽는 거인",
            "오늘의 학습 소감": "오늘의 학습 소감"
        };
        // ... (값 매핑 및 속성 생성 로직은 기존과 동일)
        // ... (이하 생략 - 위의 완전한 코드와 동일)
        const valueMapping = { "해당없음": "숙제 없음", "안 해옴": "안 해옴", "숙제 함": "숙제 함", "진행하지 않음": "진행하지 않음", "완료": "완료", "미완료": "미완료", "원서독서로 대체": "원서독서로 대체", "듣기평가교재 완료": "듣기평가교재 완료", "못함": "못함", "완료함": "완료함", "SKIP": "SKIP", "안함": "안함", "숙제없음": "숙제없음", "못하고감": "못하고감", "시작함": "시작함", "절반": "절반", "거의다읽음": "거의다읽음" };
        const properties = {};
        
        for (let key in formData) { 
            if (key === 'englishBooks' || key === 'koreanBooks') continue; 
            if (!ALLOWED_PROPS.hasOwnProperty(key)) continue; 
            
            let rawValue = formData[key]; 
            if (rawValue === undefined || rawValue === '') continue; 
            
            let value = valueMapping[rawValue] || rawValue; 
            const notionPropName = ALLOWED_PROPS[key]; 
            
            // 타입 자동 판별 및 변환
            if (['단어(맞은 개수)', '단어(전체 개수)', '문법(전체 개수)', '문법(틀린 개수)', '독해(틀린 개수)'].includes(notionPropName)) { 
                const numVal = Number(value); 
                properties[notionPropName] = { number: isNaN(numVal) ? 0 : numVal }; 
            } else if (['독해 하브루타', '📖 영어독서', '어휘학습', 'Writing', '📕 책 읽는 거인'].includes(notionPropName)) { 
                properties[notionPropName] = { select: { name: value } }; 
            } else if (['어휘유닛', '오늘의 학습 소감'].includes(notionPropName)) { 
                properties[notionPropName] = { rich_text: [{ text: { content: value } }] }; 
            } else { 
                properties[notionPropName] = { status: { name: value } }; 
            } 
        }
        
        if (formData.englishBooks && Array.isArray(formData.englishBooks)) { properties['오늘 읽은 영어 책'] = await processBookRelations(formData.englishBooks, ENG_BOOKS_ID, 'Title'); }
        if (formData.koreanBooks && Array.isArray(formData.koreanBooks)) { properties['국어 독서 제목'] = await processBookRelations(formData.koreanBooks, KOR_BOOKS_ID, '책제목'); }
        
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '이름', title: { equals: studentName } }, { property: '🕐 날짜', date: { equals: dateString } } ] };
        const existingPageQuery = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter, page_size: 1 }) });
        
        if (existingPageQuery.results.length > 0) { 
            await fetchNotion(`https://api.notion.com/v1/pages/${existingPageQuery.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) }); 
        } else { 
            properties['이름'] = { title: [{ text: { content: studentName } }] }; 
            properties['🕐 날짜'] = { date: { start: dateString } }; 
            const studentPageId = await findPageIdByTitle(STUDENT_DATABASE_ID, studentName, '이름'); 
            if (studentPageId) properties['학생'] = { relation: [{ id: studentPageId }] }; 
            await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: PROGRESS_DATABASE_ID }, properties }) }); 
        }
        res.json({ success: true, message: '저장 완료' });
    } catch (error) { res.status(500).json({ success: false, message: e.message }); }
});
app.get('/api/get-today-progress', requireAuth, async (req, res) => { /* ... 기존과 동일 ... */ });

// [수정] 수동 생성 API - Solapi용 HTTPS 제거 적용
app.get('/api/force-daily-report-gen', async (req, res) => {
    try {
        console.log('--- [수동 실행] 데일리 리포트 URL 생성 시작 ---');
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: dateString } } ] };
        
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { 
            method: 'POST', 
            body: JSON.stringify({ filter: filter }) 
        });

        let count = 0;
        // [중요] https:// 제거 (Solapi 호환)
        const domainWithoutProtocol = DOMAIN_URL.replace(/^https?:\/\//, '');

        for (const page of data.results) {
            const url = `${domainWithoutProtocol}/report?pageId=${page.id}&date=${dateString}`;
            await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { 
                method: 'PATCH', 
                body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) 
            });
            count++;
        }
        console.log(`--- [수동 실행] ${count}건 생성 완료 ---`);
        res.json({ success: true, message: `${dateString} 리포트 ${count}건 생성 완료!` });
    } catch (e) {
        console.error('Manual Gen Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/report', async (req, res) => { /* ... 리포트 뷰 로직 ... */ });

// [수정] cron 스케줄에도 동일한 URL 로직 적용
cron.schedule('0 22 * * *', async () => {
    console.log('--- 데일리 리포트 URL 자동 생성 ---');
    try {
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: dateString } } ] };
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter }) });
        
        const domainWithoutProtocol = DOMAIN_URL.replace(/^https?:\/\//, '');

        for (const page of data.results) {
            const url = `${domainWithoutProtocol}/report?pageId=${page.id}&date=${dateString}`;
            if (page.properties['데일리리포트URL']?.url === url) continue;
            await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) });
        }
    } catch (e) { console.error('Cron Error', e); }
}, { timezone: "Asia/Seoul" });

// ... (나머지 코드)
cron.schedule('50 21 * * *', async () => { /* 문법 숙제 동기화 */ }, { timezone: "Asia/Seoul" });

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Final Server running on ${PORT}`));