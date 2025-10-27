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

app.get('/api/teachers', requireAuth, async (req, res) => {
  console.log(`강사 목록 조회 시작: ${req.user.name} (${req.user.role})`);
  try {
    const teacherNames = Object.values(userAccounts)
                             .filter(acc => acc.role === 'teacher' || acc.role === 'manager')
                             .map(acc => acc.name);
    const teacherOptions = teacherNames.map((name, index) => ({ id: `t${index}`, name: name }));
    console.log(`코드에서 강사 목록 ${teacherOptions.length}명 조회 완료:`, teacherNames);
    res.json(teacherOptions);
  } catch (error) {
    console.error('강사 목록 로드 오류:', error);
    res.status(500).json([]);
  }
});

app.post('/teacher-login', async (req, res) => {
  console.log('선생님 로그인 시도:', req.body.teacherId);
  try {
    const { teacherId, teacherPassword } = req.body;
    const userAccount = userAccounts[teacherId];
    if (userAccount && teacherPassword === userAccount.password) {
        const token = generateToken({ loginId: teacherId, name: userAccount.name, role: userAccount.role });
        console.log(`로그인 성공: ${userAccount.name} (${userAccount.role})`);
        res.json({ success: true, message: '로그인 성공', token });
    } else {
        console.log(`로그인 실패: ${teacherId} (ID 또는 비밀번호 불일치)`);
        res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) {
      console.error('선생님 로그인 처리 중 심각한 오류:', error);
      res.status(500).json({ success: false, message: '서버 내부 오류로 로그인 처리에 실패했습니다.' });
  }
});

app.get('/api/teacher/user-info', requireAuth, (req, res) => {
  if (!req.user) { return res.status(401).json({ error: '인증 실패' }); }
  res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId });
});
app.get('/api/user-info', requireAuth, (req, res) => {
    res.json({ userId: req.user.userId || req.user.loginId, userName: req.user.name, userRole: req.user.role });
});

app.get('/api/homework-status', requireAuth, async (req, res) => {
  console.log(`숙제 현황 조회 시작: ${req.user.name} (${req.user.role})`);
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
    if (!accessToken || !PROGRESS_DB_ID) { throw new Error('서버 환경 변수가 설정되지 않았습니다.'); }

    const { period = 'today', startDate, endDate, teacher } = req.query;
    const filterConditions = [];

    const today = new Date();
    if (period === 'today') {
        const todayStr = today.toISOString().split('T')[0];
        filterConditions.push({ property: '🕐 날짜', date: { equals: todayStr } });
    } else if (period === 'week') {
        const day = today.getDay();
        const diffToMonday = (day === 0 ? -6 : 1) - day;
        const monday = new Date(today);
        monday.setDate(today.getDate() + diffToMonday);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        filterConditions.push({ property: '🕐 날짜', date: { on_or_after: monday.toISOString().split('T')[0], on_or_before: sunday.toISOString().split('T')[0] } });
    } else if (period === 'month') {
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        filterConditions.push({ property: '🕐 날짜', date: { on_or_after: firstDay.toISOString().split('T')[0], on_or_before: lastDay.toISOString().split('T')[0] } });
    } else if (period === 'custom' && startDate && endDate) {
        filterConditions.push({ property: '🕐 날짜', date: { on_or_after: startDate, on_or_before: endDate } });
    } else {
        const todayStr = today.toISOString().split('T')[0];
        filterConditions.push({ property: '🕐 날짜', date: { equals: todayStr } });
    }
    console.log(`날짜 필터 (${period}):`, JSON.stringify(filterConditions));

    const pages = [];
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
        const response = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({
                filter: filterConditions.length > 0 ? { and: filterConditions } : undefined,
                sorts: [{ property: '🕐 날짜', direction: 'descending' }],
                page_size: 100,
                start_cursor: startCursor
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`진도 관리 DB 조회 오류: ${response.status} - ${errorText}`);
        }
        const data = await response.json();
        pages.push(...data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
    }
    console.log(`Notion에서 총 ${pages.length}개 데이터 조회 완료`);

    console.log("\n--- 첫 3개 데이터의 '이름' 속성 확인 ---");
    pages.slice(0, 3).forEach((page, index) => {
        console.log(`[데이터 ${index + 1}] props['이름'] 객체 전체:`, JSON.stringify(page.properties['이름'], null, 2));
        const nameValue = page.properties['이름']?.title?.[0]?.plain_text;
        console.log(`[데이터 ${index + 1}] 추출된 이름 값:`, nameValue);
    });
    console.log("---------------------------------------\n");

    const homeworkData = pages.map(page => {
        const props = page.properties;
        const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
        const pageDate = props['🕐 날짜']?.date?.start || '날짜없음';
        let assignedTeachers = [];
        const teacherRollup = props['담당쌤']?.rollup;
        if (teacherRollup?.type === 'array' && teacherRollup.array.length > 0) {
             teacherRollup.array.forEach(item => {
                 if(item.type === 'multi_select') { assignedTeachers.push(...item.multi_select.map(t => t.name)); }
                 else if (item.type === 'title') { assignedTeachers.push(item.title?.[0]?.plain_text || ''); }
                 else if (item.type === 'rich_text') { assignedTeachers.push(item.rich_text?.[0]?.plain_text || ''); }
             });
        }
        assignedTeachers = [...new Set(assignedTeachers)].filter(Boolean);
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
        return { pageId: page.id, studentName: studentName, date: pageDate, teachers: assignedTeachers, completionRate: Math.round(performanceRate), ...homeworkStatuses };
    });

    let filteredData = homeworkData;
    if (teacher && teacher !== 'all') {
        filteredData = filteredData.filter(item => item.teachers.includes(teacher));
        console.log(`담당쌤 필터 "${teacher}" 적용 후: ${filteredData.length}개`);
    }
    if (req.user.role === 'teacher') {
        filteredData = filteredData.filter(item => item.teachers.includes(req.user.name));
        console.log(`Teacher ${req.user.name} 담당 데이터: ${filteredData.length}개`);
    }
    res.json(filteredData);
  } catch (error) {
    console.error('숙제 현황 로드 오류:', error);
    res.status(500).json({ message: '서버 오류' });
  }
});

app.post('/login', async (req, res) => { /* ... 이전 최종본과 동일 ... */ });
app.get('/api/search-books', requireAuth, async (req, res) => { /* ... 이전 최종본과 동일 ... */ });
app.get('/api/search-sayu-books', requireAuth, async (req, res) => { /* ... 이전 최종본과 동일 ... */ });
app.post('/save-progress', requireAuth, async (req, res) => { /* ... 이전 최종본과 동일 ... */ });
app.post('/api/update-homework', requireAuth, async (req, res) => { res.json({ success: true, message: '임시 응답' }); });


// --- 서버 실행 ---
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 최종 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});