import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@notionhq/client';

// ES Modules에서 __dirname를 사용하기 위한 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express 앱 초기화
const app = express();

// Notion 클라이언트 및 JWT 시크릿 키 초기화
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-readitude-2025';

// 데이터베이스 ID (환경 변수에서 관리)
const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID;

// 사용자 계정 (코드 내에서 간단히 관리)
const userAccounts = {
  'manager': { password: 'rdtd112!@', role: 'manager', name: '매니저' },
  'teacher1': { password: 'rdtd112!@', role: 'teacher', name: '선생님1' },
  // ... 다른 선생님 계정들
};

// 미들웨어 설정
app.use(cors());
app.use(bodyParser.json());

// ===== 정적 파일 및 페이지 라우팅 (중요!) =====
// 'public' 폴더의 파일들을 웹에서 접근 가능하게 합니다.
const publicPath = path.join(__dirname, '../../public');
app.use(express.static(publicPath));

// 기본 주소('/')로 접속하면 로그인 페이지를 보여줍니다.
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'views', 'login.html'));
});

// 각 HTML 페이지 경로를 직접 지정해줍니다.
app.get('/planner', (req, res) => {
  res.sendFile(path.join(publicPath, 'views', 'planner.html'));
});

app.get('/teacher-login', (req, res) => {
  res.sendFile(path.join(publicPath, 'views', 'teacher-login.html'));
});

app.get('/teacher-dashboard', (req, res) => {
  res.sendFile(path.join(publicPath, 'views', 'teacher-dashboard.html'));
});


// ===== JWT 함수 =====
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ===== 라우트(API 엔드포인트) 정의 =====

// 1. 학생 로그인 API
app.post('/api/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  if (!STUDENT_DB_ID) {
      return res.status(500).json({ success: false, message: '학생 DB ID가 설정되지 않았습니다.' });
  }
  try {
    const response = await notion.databases.query({
      database_id: STUDENT_DB_ID,
      filter: {
        and: [
          { property: '학생 ID', rich_text: { equals: studentId } },
          { property: '비밀번호', number: { equals: Number(studentPassword) } }
        ]
      }
    });

    if (response.results.length > 0) {
      const studentData = response.results[0].properties;
      const studentName = studentData['이름']?.title[0]?.plain_text || studentId;
      const token = generateToken({ userId: studentId, name: studentName, role: 'student' });
      res.json({ success: true, message: '로그인 성공!', token });
    } else {
      res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) {
    console.error('학생 로그인 오류:', error);
    res.status(500).json({ success: false, message: '로그인 중 서버 오류가 발생했습니다.' });
  }
});

// 2. 선생님 로그인 API
app.post('/api/teacher-login', (req, res) => {
    const { teacherId, teacherPassword } = req.body;
    const account = userAccounts[teacherId];
    if (account && account.password === teacherPassword) {
        const token = generateToken({ userId: teacherId, name: account.name, role: account.role });
        res.json({ success: true, message: '로그인 성공!', token });
    } else {
        res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.'});
    }
});


// ... (향후 다른 API들, 예를 들어 /api/homework-status 등을 여기에 추가) ...


// ===== Vercel 호환을 위한 최종 핸들러 =====
// 모든 Express 라우트를 Vercel의 서버리스 함수로 내보냅니다.
export default app;
