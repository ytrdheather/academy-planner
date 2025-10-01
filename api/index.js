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
  'manager': { password: 'rdtd112!@', role: 'manager', name: '매니저' },
  'teacher1': { password: 'rdtd112!@', role: 'teacher', name: '선생님1' },
  'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '선생님2' },
  'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '선생님3' },
  'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '선생님4' },
  'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '아르바이트1' },
  'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '아르바이트2' }
};

// --- Helper Functions ---
function generateToken(userData) {
  return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (error) { return null; }
}
async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
  const accessToken = process.env.NOTION_ACCESS_TOKEN;
  if (!accessToken || !title || !databaseId) return null;
  try {
    const isTitleProp = ['Title', '책제목', '이름'].includes(titlePropertyName);
    const filterBody = {
      property: titlePropertyName,
      [isTitleProp ? 'title' : 'rich_text']: { contains: title }
    };
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: filterBody, page_size: 1 })
    });
    if (!response.ok) { console.error(await response.text()); return null; }
    const data = await response.json();
    return data.results[0]?.id || null;
  } catch (error) {
    console.error(`Error finding page ID for title "${title}":`, error);
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
// 1. 선생님 목록 조회
app.get('/api/teachers', requireAuth, async (req, res) => {
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const TEACHER_DB_ID = process.env.TEACHER_DB_ID;
    if (!accessToken || !TEACHER_DB_ID) {
      throw new Error('서버에 선생님 DB ID가 설정되지 않았습니다.');
    }

    const response = await fetch(`https://api.notion.com/v1/databases/${TEACHER_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        filter: {
          or: [
            { property: '권한', rich_text: { equals: 'teacher' } },
            { property: '권한', rich_text: { equals: 'manager' } }
          ]
        }
      })
    });

    if (!response.ok) {
      console.error('Notion API 응답 오류:', await response.text());
      throw new Error('Notion에서 강사 목록을 가져오는 데 실패했습니다.');
    }

    const data = await response.json();
    const teachers = data.results.map(page => {
      const props = page.properties;
      return {
        id: page.id,
        name: props['이름']?.title[0]?.plain_text || '이름 없음'
      };
    });

    res.json(teachers);
  } catch (error) {
    console.error('강사 목록 로드 오류:', error);
    res.status(500).json({ message: '서버에서 강사 목록을 처리하는 중 오류가 발생했습니다.' });
  }
});

// 2. 로그인한 선생님 사용자 정보
app.get('/api/teacher/user-info', requireAuth, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: '인증 실패' });
  }
  res.json({
    userName: req.user.name,
    userRole: req.user.role,
    loginId: req.user.loginId
  });
});

// 3. 학생들의 숙제 현황 (기간 필터 반영)
app.get('/api/homework-status', requireAuth, async (req, res) => {
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
    if (!accessToken || !PROGRESS_DB_ID) {
      throw new Error('서버 환경 변수가 설정되지 않았습니다.');
    }

    const { period, startDate, endDate, teacher } = req.query;
    const filterConditions = [];

    const today = new Date();

   if (period === 'today') {
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
  filterConditions.push({
    and: [
      { property: '🕐 날짜', date: { on_or_after: todayStr } },
      { property: '🕐 날짜', date: { on_or_before: todayStr } }
    ]
  });
} else if (period === 'week') {
      const day = today.getDay(); // 0=일, 1=월
      const diffToMonday = (day === 0 ? -6 : 1) - day;
      const monday = new Date(today);
      monday.setDate(today.getDate() + diffToMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);

      filterConditions.push({
        and: [
          { property: '🕐 날짜', date: { on_or_after: monday.toISOString().split('T')[0] } },
          { property: '🕐 날짜', date: { on_or_before: sunday.toISOString().split('T')[0] } }
        ]
      });
    } else if (period === 'month') {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      filterConditions.push({
        and: [
          { property: '🕐 날짜', date: { on_or_after: firstDay.toISOString().split('T')[0] } },
          { property: '🕐 날짜', date: { on_or_before: lastDay.toISOString().split('T')[0] } }
        ]
      });
    } else if (period === 'custom' && startDate && endDate) {
      filterConditions.push({
        and: [
          { property: '🕐 날짜', date: { on_or_after: startDate } },
          { property: '🕐 날짜', date: { on_or_before: endDate } }
        ]
      });
    }

    if (teacher && teacher !== 'all') {
      filterConditions.push({ property: '담당쌤', relation: { contains: teacher } });
    }

    const response = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        filter: filterConditions.length > 0 ? { and: filterConditions } : undefined,
        sorts: [{ property: '🕐 날짜', direction: 'descending' }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Notion API Error: ${errorData.message}`);
    }

    const data = await response.json();
    const homeworkStatus = data.results.map(page => {
      const props = page.properties;
      return {
        pageId: page.id,
        studentId: props['이름']?.title[0]?.plain_text || '이름 없음',
        date: props['🕐 날짜']?.date?.start || '날짜없음',
        teachers: props['담당쌤']?.relation?.map(rel => rel.id) || [], // 🔥 title 대신 id
        completionRate: props['수행율']?.formula?.number || 0,
        grammarHomework: props['⭕ 지난 문법 숙제 검사']?.status?.name || '숙제 없음',
        vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '숙제 없음',
        readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '숙제 없음',
        summary: props['4️⃣ Summary 숙제']?.status?.name || '숙제 없음',
        readingHomework: props['5️⃣ 매일 독해 숙제']?.status?.name || '숙제 없음',
        diary: props['6️⃣ 영어 일기(초등) / 개인 독해서 (중고등)']?.status?.name || '숙제 없음'
      };
    });
    res.json(homeworkStatus);
  } catch (error) {
    console.error('숙제 현황 로드 오류:', error);
    res.status(500).json({ message: '서버에서 숙제 현황 데이터를 처리하는 중 오류가 발생했습니다.' });
  }
});

// --- 로그인 관련 API ---
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
      body: JSON.stringify({
        filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] }
      })
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
  } catch (error) {
    console.error('로그인 오류:', error);
    res.status(500).json({ success: false, message: '로그인 중 오류가 발생했습니다.' });
  }
});

app.post('/teacher-login', async (req, res) => {
  const { teacherId, teacherPassword } = req.body;
  const userAccount = userAccounts[teacherId];
  if (userAccount && teacherPassword === userAccount.password) {
    const token = generateToken({ loginId: teacherId, name: userAccount.name, role: userAccount.role });
    res.json({ success: true, message: '로그인 성공', token });
  } else {
    res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
});

// 학생 인증 테스트용
app.get('/api/student-info', requireAuth, (req, res) => {
  if (!req.user || req.user.role !== 'student') {
    return res.status(401).json({ error: '학생 인증이 필요합니다' });
  }
  res.json({ studentId: req.user.userId, studentName: req.user.name, studentRealName: req.user.name });
});

// --- 서버 실행 ---
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 최종 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
