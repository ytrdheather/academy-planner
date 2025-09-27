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

// ===== 정적 파일 및 페이지 라우팅 =====
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

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

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ===== API 엔드포인트들 =====

// 1. 학생 로그인 API
app.post('/api/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  if (!STUDENT_DB_
