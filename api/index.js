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
const publicPath = path.join(__dirname, '../public');
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));


// --- API 라우트 ---

// [수정됨] 숙제 현황 조회 (문법 점수 데이터 포함)
app.get('/api/homework-status', requireAuth, async (req, res) => {
  console.log(`숙제 및 테스트 현황 조회 시작: ${req.user.name} (${req.user.role})`);
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
    if (!accessToken || !PROGRESS_DB_ID) { throw new Error('서버 환경 변수가 설정되지 않았습니다.'); }

    const { period = 'today', startDate, endDate, teacher } = req.query;
    const filterConditions = [];
    const today = new Date();
    // (날짜 필터 로직...)
    if (period === 'today') {
        const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0]; // KST 기준 Today
        filterConditions.push({ property: '🕐 날짜', date: { equals: todayStr } });
    } else if (period === 'week') {
        const day = today.getDay();
        const diffToMonday = (day === 0 ? -6 : 1) - day; // 1 (Monday) - day
        const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diffToMonday);
        const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
        filterConditions.push({ property: '🕐 날짜', date: { on_or_after: monday.toISOString().split('T')[0], on_or_before: sunday.toISOString().split('T')[0] } });
    } else if (period === 'month') {
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        filterConditions.push({ property: '🕐 날짜', date: { on_or_after: firstDay.toISOString().split('T')[0], on_or_before: lastDay.toISOString().split('T')[0] } });
    } else if (period === 'custom' && startDate && endDate) {
        filterConditions.push({ property: '🕐 날짜', date: { on_or_after: startDate, on_or_before: endDate } });
    } else {
        const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0]; // KST 기준 Today
        filterConditions.push({ property: '🕐 날짜', date: { equals: todayStr } });
    }
    console.log(`날짜 필터 (${period}):`, JSON.stringify(filterConditions));

    // (페이지네이션 로직...)
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
    console.log(`Notion에서 총 ${pages.length}개 데이터 조회 완료`);

    // 데이터 처리 (문법 점수 속성 추가)
    const combinedData = pages.map(page => {
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
        // 테스트 결과 데이터 추출
        const testResults = {
            vocabUnit: props['어휘유닛']?.rich_text?.[0]?.plain_text || '',
            vocabCorrect: props['단어 (맞은 개수)']?.number ?? null,
            vocabTotal: props['단어 (전체 개수)']?.number ?? null,
            vocabScore: props['📰 단어 테스트 점수']?.formula?.string || '',
            readingWrong: props['독해 (틀린 개수)']?.number ?? null,
            readingResult: props['📚 독해 해석 시험 결과']?.formula?.string || '',
            havruta: props['독해 하브루타']?.select?.name || '숙제없음',
            // 문법 점수 추가
            grammarTotal: props['문법 (전체 개수)']?.number ?? null,
            grammarWrong: props['문법 (틀린 개수)']?.number ?? null,
            grammarScore: props['📑 문법 시험 점수']?.formula?.string || '' // 실제 속성 이름 확인!
        };
        return { pageId: page.id, studentName, date: pageDate, teachers: assignedTeachers, completionRate: Math.round(performanceRate), ...homeworkStatuses, ...testResults };
    });

    // (필터링 로직...)
    let filteredData = combinedData;
    if (teacher && teacher !== '') { filteredData = filteredData.filter(item => item.teachers.includes(teacher)); }
    if (req.user.role === 'teacher') { filteredData = filteredData.filter(item => item.teachers.includes(req.user.name)); }
    res.json(filteredData);
 } catch (error) { console.error('숙제 및 테스트 현황 로드 오류:', error); res.status(500).json({ message: '서버 오류' }); }
});

// [수정됨] 업데이트 API (숫자, 텍스트, 선택 타입 처리)
app.post('/api/update-homework', requireAuth, async (req, res) => {
  const { pageId, propertyName, newValue, propertyType } = req.body;
  console.log(`Notion 업데이트 요청: ${req.user.name} - PageID: ${pageId}, 속성: ${propertyName}, 새 값: ${newValue}, 타입: ${propertyType}`);
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
             if (newValue === null || newValue === '숙제없음') {
                 notionUpdatePayload = { select: null }; // 선택 해제
             } else {
                 notionUpdatePayload = { select: { name: newValue } };
             }
            break;
        case 'status': default:
             if (newValue === null || newValue === '숙제 없음') {
                 // Notion '상태' 속성은 null을 허용하지 않는 경우가 많음. 기본 그룹의 첫 번째 옵션으로 설정하거나,
                 // 'Not started'에 해당하는 이름(예: '숙제 없음')을 보내야 함
                 notionUpdatePayload = { status: { name: "숙제 없음" } }; // Notion에 '숙제 없음' 상태가 있다고 가정
             } else {
                 notionUpdatePayload = { status: { name: newValue } };
             }
            break;
    }
    const propertiesToUpdate = { [propertyName]: notionUpdatePayload };
    console.log("Sending update to Notion:", JSON.stringify({ properties: propertiesToUpdate }));
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ properties: propertiesToUpdate })
    });
    if (!response.ok) { const errorData = await response.json(); console.error(`Notion 업데이트 API 오류 (PageID: ${pageId}):`, errorData); throw new Error(errorData.message || `Notion API 업데이트 실패 (${response.status})`); }
    res.json({ success: true, message: '업데이트 성공' });
  } catch (error) { console.error(`숙제 업데이트 처리 중 오류 (PageID: ${pageId}):`, error); res.status(500).json({ success: false, message: error.message || '서버 내부 오류' }); }
});

// 개별 학생 정보 새로고침 API
app.get('/api/student-homework/:pageId', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    console.log(`Individual student status request: PageID=${pageId}`);
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        if (!accessToken) { throw new Error('Server token error.'); }
        const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Notion-Version': '2022-06-28' }
        });
        if (!response.ok) { const errorData = await response.json(); console.error(`Notion Page Fetch API Error (PageID: ${pageId}):`, errorData); throw new Error(errorData.message || `Notion Page Fetch Failed (${response.status})`); }
        const pageData = await response.json();
        const props = pageData.properties;
        const performanceRateString = props['수행율']?.formula?.string || '0%';
        const performanceRate = parseFloat(performanceRateString.replace('%', '')) || 0;
        const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
        console.log(`Individual student status fetched (PageID: ${pageId}): Rate=${performanceRate}%`);
        res.json({ success: true, pageId: pageId, studentName: studentName, completionRate: Math.round(performanceRate) });
    } catch (error) {
        console.error(`Error fetching individual student status (PageID: ${pageId}):`, error);
        res.status(500).json({ success: false, message: error.message || 'Server internal error.' });
    }
});


// --- 나머지 API 라우트 ---
app.get('/api/teachers', requireAuth, async (req, res) => {
  console.log(`강사 목록 조회 시작: ${req.user.name} (${req.user.role})`);
  try {
    const teacherNames = Object.values(userAccounts).filter(acc => acc.role === 'teacher' || acc.role === 'manager').map(acc => acc.name);
    const teacherOptions = teacherNames.map((name, index) => ({ id: `t${index}`, name: name }));
    console.log(`코드에서 강사 목록 ${teacherOptions.length}명 조회 완료:`, teacherNames);
    res.json(teacherOptions);
  } catch (error) { console.error('강사 목록 로드 오류:', error); res.status(500).json([]); }
});

app.post('/teacher-login', async (req, res) => {
  console.log('선생님 로그인 시도:', req.body.teacherId);
  try {
    const { teacherId, teacherPassword } = req.body;
    if (!teacherId || !teacherPassword) { return res.status(400).json({ success: false, message: '아이디와 비밀번호를 모두 입력해주세요.' }); }
    if (!userAccounts[teacherId]) { return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' }); }
    const userAccount = userAccounts[teacherId];
    if (userAccount.password === teacherPassword) {
        const tokenPayload = { loginId: teacherId, name: userAccount.name, role: userAccount.role };
        const token = generateToken(tokenPayload);
        console.log(`로그인 성공: ${userAccount.name} (${userAccount.role})`);
        res.json({ success: true, message: '로그인 성공', token });
    } else {
        console.log(`로그인 실패: ${teacherId} (비밀번호 불일치)`);
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
  console.log('학생 로그인 시도:', { studentId });
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
    if (!response.ok) { const errorData = await response.json(); console.error('Notion Save API Error:', errorData); throw new Error(`Notion API Error: ${errorData.message}`); }
    res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 저장되었습니다!' });
  } catch (error) { console.error('Error saving student progress:', error); res.status(500).json({ success: false, message: '저장 중 서버 오류 발생.' }); }
});

// --- 서버 실행 ---
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 최종 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});