import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

// --- 기본 설정 ---
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-readitude-2025';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 5001;
const userAccounts = {
 'manager': { password: 'rdtd112!@', role: 'manager', name: '원장 헤더쌤' },
 'teacher1': { password: 'rdtd112!@', role: 'manager', name: '조이쌤' },
 'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '주디쌤' },
 'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '소영쌤' },
 'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '레일라쌤' },
 'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '제니쌤' },
 'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '릴리쌤' }
};
const publicPath = path.join(__dirname, '../public');

// --- Helper Functions ---
function generateToken(userData) { return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; } }
async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
  const accessToken = process.env.NOTION_ACCESS_TOKEN;
  if (!accessToken || !title || !databaseId) return null;
  try {
    const isTitleProp = ['Title', '책제목', '이름'].includes(titlePropertyName);
    const filterQueryPart = isTitleProp ? { title: { contains: title } } : { rich_text: { contains: title } };
    const filterBody = { property: titlePropertyName, ...filterQueryPart };
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: filterBody, page_size: 1 })
    });
    if (!response.ok) { console.error("Notion API Error (findPageIdByTitle):", await response.text()); return null; };
    const data = await response.json();
    return data.results[0]?.id || null;
  } catch (error) {
    console.error(`Error finding page ID for title "${title}" in DB ${databaseId}:`, error);
    return null;
  }
}

// --- 미들웨어 ---
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

// --- 페이지 라우트 ---
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));


// --- [공통] 헬퍼 함수: 롤업 데이터 추출 ---
const getRollupValue = (prop, isNumber = false) => {
    if (!prop?.rollup) return isNumber ? null : '';
    if (prop.rollup.type === 'number') return prop.rollup.number;
    if (prop.rollup.type === 'array' && prop.rollup.array.length > 0) {
        const firstItem = prop.rollup.array[0];
        if (!firstItem) return isNumber ? null : '';
        if (firstItem.type === 'title' && firstItem.title.length > 0) return firstItem.title[0].plain_text;
        if (firstItem.type === 'rich_text' && firstItem.rich_text.length > 0) return firstItem.rich_text[0].plain_text;
        if (firstItem.type === 'number') return firstItem.number;
        if (firstItem.type === 'relation') return ''; // 관계형 자체는 빈값 처리 (relation 배열 확인 불필요)
        if (firstItem.type === 'formula') {
            if (firstItem.formula.type === 'string') return firstItem.formula.string;
            if (firstItem.formula.type === 'number') return firstItem.formula.number;
        }
    }
    if (prop.rollup.type === 'formula') { // 롤업 속성 자체가 수식인 경우
        if (prop.rollup.formula.type === 'number') return prop.rollup.formula.number;
        if (prop.rollup.formula.type === 'string') return prop.rollup.formula.string;
    }
    return isNumber ? null : '';
};

// --- 헬퍼 함수: 리스닝 현황 파싱 ---
function parseListeningPageData(page) {
    const props = page.properties;
    const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
    const pageDate = props['🕐 날짜']?.date?.start || '날짜없음';
    let assignedTeachers = [];
    if (props['담당쌤']?.rollup?.array) {
        assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text || item.rich_text?.[0]?.plain_text))].filter(Boolean);
    }
    return {
        pageId: page.id, studentName, date: pageDate, teachers: assignedTeachers,
        listeningTextbook: getRollupValue(props['🎧 리스닝 교재 (롤업)']), // 롤업 속성 사용
        listeningStudy: props['영어 더빙 학습 완료']?.status?.name || '진행하지 않음',
        listeningWorkbook: props['더빙 워크북 완료']?.status?.name || '진행하지 않음'
    };
}

// --- 헬퍼 함수: 원서 독서 현황 파싱 ---
function parseReadingPageData(page) {
    const props = page.properties;
    const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
    const pageDate = props['🕐 날짜']?.date?.start || '날짜없음';
    let assignedTeachers = [];
    if (props['담당쌤']?.rollup?.array) {
        assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text || item.rich_text?.[0]?.plain_text))].filter(Boolean);
    }
    return {
        pageId: page.id, studentName, date: pageDate, teachers: assignedTeachers,
        readingStatus: props['📖 영어독서']?.select?.name || '',
        vocabStatus: props['어휘학습']?.select?.name || '',
        bookTitle: getRollupValue(props['📖 책제목 (롤업)']),
        bookRelationId: props['오늘 읽은 영어 책']?.relation?.[0]?.id || '',
        bookSeries: getRollupValue(props['시리즈이름']),
        bookAR: getRollupValue(props['AR'], true),
        bookLexile: getRollupValue(props['Lexile'], true),
        writingStatus: props['Writing']?.select?.name || '',
    };
}

// --- [공통] 데이터 조회 함수 ---
async function fetchProgressData(req, parseFunction) {
    const { period = 'today', date, teacher } = req.query;
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
    if (!accessToken || !PROGRESS_DB_ID) { throw new Error('서버 환경 변수가 설정되지 않았습니다.'); }

    const filterConditions = [];
    const today = new Date();

    if (period === 'specific_date' && date) {
        filterConditions.push({ property: '🕐 날짜', date: { equals: date } });
    } else { // 기본값 'today'
        const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        filterConditions.push({ property: '🕐 날짜', date: { equals: todayStr } });
    }

    const pages = [];
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
        const response = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({
                filter: filterConditions.length > 0 ? { and: filterConditions } : undefined,
                sorts: [{ property: '🕐 날짜', direction: 'descending' }, { property: '이름', direction: 'ascending' }],
                page_size: 100, start_cursor: startCursor
            })
        });
        if (!response.ok) { const errorText = await response.text(); throw new Error(`DB 조회 오류: ${response.status} - ${errorText}`); }
        const data = await response.json(); pages.push(...data.results);
        hasMore = data.has_more; startCursor = data.next_cursor;
    }

    const parsedData = pages.map(parseFunction);

    let filteredData = parsedData;
    if (teacher && teacher !== '') { filteredData = filteredData.filter(item => item.teachers.includes(teacher)); }
    if (req.user.role === 'teacher') { filteredData = filteredData.filter(item => item.teachers.includes(req.user.name)); }

    return filteredData;
}

// --- API 라우트 ---

// 숙제 현황 조회 API
app.get('/api/homework-status', requireAuth, async (req, res) => {
    try {
        const parseHomeworkTestData = (page) => { // 파싱 함수 내부 정의
            const props = page.properties;
            const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
            const pageDate = props['🕐 날짜']?.date?.start || '날짜없음';
            let assignedTeachers = [];
            if (props['담당쌤']?.rollup?.array) { assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text || item.rich_text?.[0]?.plain_text))].filter(Boolean); }
            const performanceRateString = props['수행율']?.formula?.string || '0%';
            const performanceRate = parseFloat(performanceRateString.replace('%', '')) || 0;
            const homeworkStatuses = {
                grammarHomework: props['⭕ 지난 문법 숙제 검사']?.status?.name || '-',
                vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '-',
                readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '-',
                summary: props['4️⃣ Summary 숙제']?.status?.name || '-',
                readingHomework: props['5️⃣ 매일 독해 숙제']?.status?.name || '-',
                diary: props['6️⃣ 영어일기 or 개인 독해서']?.status?.name || '-'
            };
            const testResults = {
                vocabUnit: props['어휘유닛']?.rich_text?.[0]?.plain_text || '',
                vocabCorrect: props['단어 (맞은 개수)']?.number ?? null,
                vocabTotal: props['단어 (전체 개수)']?.number ?? null,
                vocabScore: props['📰 단어 테스트 점수']?.formula?.string || '',
                readingWrong: props['독해 (틀린 개수)']?.number ?? null,
                readingResult: props['📚 독해 해석 시험 결과']?.formula?.string || '',
                havruta: props['독해 하브루타']?.select?.name || '숙제없음',
                grammarTotal: props['문법 (전체 개수)']?.number ?? null,
                grammarWrong: props['문법 (틀린 개수)']?.number ?? null,
                grammarScore: props['📑 문법 시험 점수']?.formula?.string || ''
            };
            return { pageId: page.id, studentName, date: pageDate, teachers: assignedTeachers, completionRate: Math.round(performanceRate), ...homeworkStatuses, ...testResults };
        };
        const data = await fetchProgressData(req, parseHomeworkTestData); // 공통 함수 호출
        res.json(data);
    } catch (error) { console.error('숙제 및 테스트 현황 로드 오류:', error); res.status(500).json({ message: error.message || '서버 오류' }); }
});

// 리스닝 현황 조회 API
app.get('/api/listening-status', requireAuth, async (req, res) => {
    try {
        const data = await fetchProgressData(req, parseListeningPageData); // 공통 함수 호출
        res.json(data);
    } catch (error) { console.error('리스닝 현황 로드 오류:', error); res.status(500).json({ message: error.message || '서버 오류' }); }
});

// 원서 독서 현황 조회 API
app.get('/api/reading-status', requireAuth, async (req, res) => {
    try {
        const data = await fetchProgressData(req, parseReadingPageData); // 공통 함수 호출
        res.json(data);
    } catch (error) { console.error('원서 독서 현황 로드 오류:', error); res.status(500).json({ message: error.message || '서버 오류' }); }
});


// 개별 학생 리스닝 현황 조회 API
app.get('/api/listening-status/:pageId', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        if (!accessToken) { throw new Error('서버 토큰 오류'); }
        const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Notion-Version': '2022-06-28' }
        });
        if (!response.ok) { throw new Error(await response.text()); }
        const pageData = await response.json();
        res.json(parseListeningPageData(pageData));
    } catch (error) { console.error(`개별 학생 리스닝 조회 오류 (PageID: ${pageId}):`, error); res.status(500).json({ message: error.message || '서버 내부 오류' }); }
});


// 개별 학생 원서 독서 현황 조회 API
app.get('/api/reading-status/:pageId', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        if (!accessToken) { throw new Error('서버 토큰 오류'); }
        const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Notion-Version': '2022-06-28' }
        });
        if (!response.ok) { throw new Error(await response.text()); }
        const pageData = await response.json();
        res.json(parseReadingPageData(pageData));
    } catch (error) { console.error(`개별 학생 독서 조회 오류 (PageID: ${pageId}):`, error); res.status(500).json({ message: error.message || '서버 내부 오류' }); }
});


// 업데이트 API
app.post('/api/update-homework', requireAuth, async (req, res) => {
  const { pageId, propertyName, newValue, propertyType } = req.body;
  if (!pageId || !propertyName || newValue === undefined) { return res.status(400).json({ success: false, message: '필수 정보 누락' }); }
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    if (!accessToken) { throw new Error('서버 토큰 오류'); }
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
            if (newValue === null || newValue === '숙제 없음' || newValue === '진행하지 않음') {
                const defaultStatusName = (newValue === '진행하지 않음') ? "진행하지 않음" : "숙제 없음";
                notionUpdatePayload = { status: { name: defaultStatusName } };
            } else { notionUpdatePayload = { status: { name: newValue } }; }
            break;
    }
    const propertiesToUpdate = { [propertyName]: notionUpdatePayload };
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ properties: propertiesToUpdate })
    });
    if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.message || `Notion API 업데이트 실패 (${response.status})`); }
    res.json({ success: true, message: '업데이트 성공' });
  } catch (error) { console.error(`숙제 업데이트 처리 중 오류 (PageID: ${pageId}):`, error); res.status(500).json({ success: false, message: error.message || '서버 내부 오류' }); }
});

// 개별 학생 수행율 새로고침 API
app.get('/api/student-homework/:pageId', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        if (!accessToken) { throw new Error('Server token error.'); }
        const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Notion-Version': '2022-06-28' }
        });
        if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.message || `Notion Page Fetch Failed (${response.status})`); }
        const pageData = await response.json();
        const props = pageData.properties;
        const performanceRateString = props['수행율']?.formula?.string || '0%';
        const performanceRate = parseFloat(performanceRateString.replace('%', '')) || 0;
        const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
        res.json({ success: true, pageId: pageId, studentName: studentName, completionRate: Math.round(performanceRate) });
    } catch (error) { console.error(`Error fetching individual student status (PageID: ${pageId}):`, error); res.status(500).json({ success: false, message: error.message || 'Server internal error.' }); }
});


// --- 나머지 API 라우트 ---
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

app.post('/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID;
    if (!accessToken || !STUDENT_DB_ID) { return res.status(500).json({ success: false, message: '서버 설정 오류.' }); }
    const restResponse = await fetch(`https://api.notion.com/v1/databases/${STUDENT_DB_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] } })
    });
    if (!restResponse.ok) throw new Error(`Notion API Error: ${restResponse.status}`);
    const response = await restResponse.json();
    if (response.results.length > 0) {
      const studentRecord = response.results[0].properties;
      const realName = studentRecord['이름']?.title?.[0]?.plain_text || studentId;
      const token = generateToken({ userId: studentId, role: 'student', name: realName });
      res.json({ success: true, message: '로그인 성공!', token });
    } else {
      res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) { console.error('로그인 오류:', error); res.status(500).json({ success: false, message: '로그인 중 오류가 발생했습니다.' }); }
});

app.get('/api/search-books', requireAuth, async (req, res) => {
  const { query } = req.query;
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const ENG_BOOKS_ID = process.env.ENG_BOOKS_ID;
    if (!accessToken || !ENG_BOOKS_ID) { throw new Error('Server config error for Eng Books.'); }
    const response = await fetch(`https://api.notion.com/v1/databases/${ENG_BOOKS_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: 'Title', title: { contains: query } }, page_size: 10 })
    });
    if (!response.ok) throw new Error(`Notion API Error: ${response.status}`);
    const data = await response.json();
    const books = data.results.map(page => { const props = page.properties; return { id: page.id, title: props.Title?.title?.[0]?.plain_text, author: props.Author?.rich_text?.[0]?.plain_text, level: props.Level?.select?.name }; });
    res.json(books);
  } catch (error) { console.error('English book search API error:', error); res.status(500).json([]); }
});

app.get('/api/search-sayu-books', requireAuth, async (req, res) => {
  const { query } = req.query;
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const KOR_BOOKS_ID = process.env.KOR_BOOKS_ID;
    if (!accessToken || !KOR_BOOKS_ID) { throw new Error('Server config error for Kor Books.'); }
    const response = await fetch(`https://api.notion.com/v1/databases/${KOR_BOOKS_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: '책제목', rich_text: { contains: query } }, page_size: 10 })
    });
    if (!response.ok) throw new Error(`Notion API Error: ${response.status}`);
    const data = await response.json();
    const books = data.results.map(page => { const props = page.properties; return { id: page.id, title: props.책제목?.rich_text?.[0]?.plain_text, author: props.지은이?.rich_text?.[0]?.plain_text, publisher: props.출판사?.rich_text?.[0]?.plain_text }; });
    res.json(books);
  } catch (error) { console.error('Korean book search API error:', error); res.status(500).json([]); }
});

app.post('/save-progress', requireAuth, async (req, res) => {
  const formData = req.body;
  const studentName = req.user.name;
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
    if (!accessToken || !PROGRESS_DB_ID) { throw new Error('Server config error.'); }
    const properties = {
      '이름': { title: [{ text: { content: studentName } }] },
      '🕐 날짜': { date: { start: new Date().toISOString().split('T')[0] } },
    };
    const propertyNameMap = { "영어 더빙 학습": "영어 더빙 학습 완료", "더빙 워크북": "더빙 워크북 완료", "완료 여부": "📕 책 읽는 거인", "오늘의 소감": "오늘의 학습 소감" };
    const numberProps = ["어휘정답", "어휘총문제", "문법 전체 개수", "문법숙제오답", "독해오답갯수"];
    const selectProps = ["독해 하브루타", "영어독서", "어휘학습", "Writing", "📕 책 읽는 거인"];
    const textProps = ["어휘유닛", "오늘의 학습 소감"];
    for (let key in formData) {
      const value = formData[key];
      const notionPropName = propertyNameMap[key] || key;
      if (!value || ['해당없음', '진행하지 않음', '숙제없음', 'SKIP'].includes(value)) { continue; }
      if (numberProps.includes(notionPropName)) { properties[notionPropName] = { number: Number(value) }; }
      else if (selectProps.includes(notionPropName)) { properties[notionPropName] = { select: { name: value } }; }
      else if (textProps.includes(notionPropName)) { properties[notionPropName] = { rich_text: [{ text: { content: value } }] }; }
      else if (key === '오늘 읽은 영어 책') {
        const bookPageId = await findPageIdByTitle(process.env.ENG_BOOKS_ID, value, 'Title');
        if (bookPageId) { properties[notionPropName] = { relation: [{ id: bookPageId }] }; }
      }
      else if (key === '3독 독서 제목') {
        const bookPageId = await findPageIdByTitle(process.env.KOR_BOOKS_ID, value, '책제목');
        if (bookPageId) { properties[notionPropName] = { relation: [{ id: bookPageId }] }; }
      }
      else { properties[notionPropName] = { status: { name: value } }; }
    }
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ parent: { database_id: PROGRESS_DB_ID }, properties: properties })
    });
    if (!response.ok) { const errorData = await response.json(); throw new Error(`Notion API Error: ${errorData.message}`); }
    res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 저장되었습니다!' });
  } catch (error) { console.error('Error saving student progress:', error); res.status(500).json({ success: false, message: '저장 중 서버 오류 발생.' }); }
});

// --- 서버 실행 ---
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 최종 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

