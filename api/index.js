import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@notionhq/client';

// ===== 필수 환경 변수 확인 (더 안정적인 코드를 위해 추가!) =====
const requiredEnvVars = ['NOTION_TOKEN', 'STUDENT_DATABASE_ID', 'JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`❌ 필수 환경 변수가 설정되지 않았습니다: ${missingEnvVars.join(', ')}`);
  // 실제 운영 환경에서는 서버를 종료시키는 것이 안전합니다.
  // process.exit(1); 
}

// ES Modules에서 __dirname, __filename을 사용하기 위한 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express 앱 초기화
const app = express();

// Notion 클라이언트 및 JWT 시크릿 키 초기화
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const JWT_SECRET = process.env.JWT_SECRET;

// 데이터베이스 ID (Vercel 환경 변수에서 가져옴)
const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID;

// 사용자 계정 (코드 내에서 간단히 관리)
const userAccounts = {
  'manager': { password: 'rdtd112!@', role: 'manager', name: '매니저' },
  'teacher1': { password: 'rdtd112!@', role: 'teacher', name: '선생님1' },
};

// 미들웨어 설정 (body-parser 대신 express 내장 기능 사용!)
app.use(cors());
app.use(express.json()); // JSON 요청 본문 파싱
app.use(express.urlencoded({ extended: true })); // URL-encoded 요청 본문 파싱

// ===== 정적 파일 및 페이지 라우팅 =====
const publicPath = path.join(process.cwd(), 'public');

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'views', 'login.html'));
});

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

// ===== API 엔드포인트들 =====

// 1. 학생 로그인 API
app.post('/api/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  
  try {
    const response = await notion.databases.query({
      database_id: STUDENT_DB_ID,
      filter: {
        and: [
          { property: '학생 ID', rich_text: { equals: studentId } },
          { property: '비밀번호', rich_text: { equals: studentPassword } }
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

// ===== Vercel 호환을 위한 최종 핸들러 =====
export default app;
