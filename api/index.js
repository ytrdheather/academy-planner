import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUncachableNotionClient } from '../notion-client.js';
import { Client } from '@notionhq/client';

// JWT 시크릿 키 (프로덕션에서 필수)
const JWT_SECRET = process.env.JWT_SECRET;
const DEV_SECRET = 'dev-only-secret-readitude-2025'; // 고정된 개발용 시크릿

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  console.warn('⚠️ 개발 환경: JWT_SECRET이 설정되지 않음. 고정된 개발용 시크릿 사용.');
}

// 기존에 잘 작동하던 getAccessToken 함수
async function getAccessToken() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  const connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=notion',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Notion not connected');
  }
  return accessToken;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// 다중 사용자 계정 설정 (환경변수로 관리 예정)
const userAccounts = {
  // 매니저 (전체 관리)
  'manager': { password: 'rdtd112!@', role: 'manager', name: '매니저', assignedStudents: 'all' },
  
  // 선생님 4명 (담당 학생만)
  'teacher1': { password: 'rdtd112!@', role: 'teacher', name: '선생님1', assignedStudents: [] },
  'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '선생님2', assignedStudents: [] },
  'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '선생님3', assignedStudents: [] },
  'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '선생님4', assignedStudents: [] },
  
  // 아르바이트생 2명 (제한적 권한)
  'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '아르바이트1', assignedStudents: [] },
  'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '아르바이트2', assignedStudents: [] }
};

// JWT 토큰 생성 함수
function generateToken(userId, userInfo) {
  const secret = JWT_SECRET || DEV_SECRET;
  return jwt.sign({
    userId: userId,
    role: userInfo.role,
    name: userInfo.name,
    assignedStudents: userInfo.assignedStudents
  }, secret, { expiresIn: '24h' });
}

// JWT 토큰 검증 함수
function verifyToken(token) {
  try {
    const secret = JWT_SECRET || DEV_SECRET;
    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
}

// 미들웨어 설정
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://vercel.app', 'https://*.vercel.app'] 
    : ['http://localhost:3000', 'http://localhost:5000'],
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 정적 파일 서빙 (Vercel용)
app.use(express.static(path.join(__dirname, '../public')));

// JWT 기반 사용자 인증 미들웨어
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.auth_token;
  
  if (!token) {
    return res.status(401).json({ error: '인증 토큰이 필요합니다' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다' });
  }
  
  req.user = decoded;
  next();
}

// 권한별 데이터 필터링 함수
function filterStudentsByRole(userRole, userName, assignedStudents, data) {
  if (userRole === 'manager') {
    return data; // 매니저는 모든 데이터 접근
  } else if (userRole === 'teacher') {
    // 선생님은 담당 학생만 (현재는 임시로 모든 데이터)
    return data;
  } else if (userRole === 'assistant') {
    // 아르바이트는 제한된 데이터 (최근 15건)
    return data.slice(0, 15);
  }
  return [];
}

// 날짜별 데이터 필터링 함수
function filterDataByDate(data, period, startDate, endDate) {
  if (!period || period === 'all') return data;
  
  const now = new Date();
  let filterDate;
  
  if (period === 'today') {
    filterDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return data.filter(item => new Date(item.date) >= filterDate);
  } else if (period === 'week') {
    filterDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return data.filter(item => new Date(item.date) >= filterDate);
  } else if (period === 'month') {
    filterDate = new Date(now.getFullYear(), now.getMonth(), 1);
    return data.filter(item => new Date(item.date) >= filterDate);
  } else if (period === 'custom' && startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return data.filter(item => {
      const itemDate = new Date(item.date);
      return itemDate >= start && itemDate <= end;
    });
  }
  
  return data;
}

// 메인 페이지 (학생 로그인)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views/login.html'));
});

// Vercel 호환 학생 로그인 처리
app.post('/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  
  console.log('학생 로그인 시도:', { studentId, password: '***' });
  
  try {
    // Vercel 호환: 직접 NOTION_ACCESS_TOKEN 사용 또는 Replit 커넥터 폴백
    let accessToken;
    
    if (process.env.NOTION_ACCESS_TOKEN) {
      // Vercel 배포용: 직접 토큰 사용
      accessToken = process.env.NOTION_ACCESS_TOKEN;
      console.log('Vercel 모드: NOTION_ACCESS_TOKEN 사용');
    } else {
      // Replit 개발용: 커넥터 사용
      accessToken = await getAccessToken();
      console.log('Replit 모드: 커넥터 사용');
    }
    
    // 환경변수에서 데이터베이스 ID 가져오기
    const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID || process.env.NOTION_DATABASE;
    
    if (!STUDENT_DB_ID) {
      console.error('학생 데이터베이스 ID가 설정되지 않았습니다');
      return res.json({ success: false, message: '데이터베이스 설정 오류. 관리자에게 문의하세요.' });
    }
    
    console.log('학생 DB ID:', STUDENT_DB_ID);
    
    const restResponse = await fetch(`https://api.notion.com/v1/databases/${STUDENT_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: '학생 ID',
              rich_text: {
                equals: studentId
              }
            },
            {
              property: '비밀번호',
              rich_text: {
                equals: studentPassword.toString()
              }
            }
          ]
        }
      })
    });
    
    if (!restResponse.ok) {
      const errorText = await restResponse.text();
      console.error('로그인 API 오류:', errorText);
      throw new Error(`로그인 API 호출 실패: ${restResponse.status}`);
    }
    
    const response = await restResponse.json();
    console.log('노션 응답 길이:', response.results.length);

    if (response.results.length > 0) {
      // 학생 데이터베이스의 모든 필드 확인 (디버깅용)
      console.log('학생 데이터베이스 필드들:', Object.keys(response.results[0].properties));
      
      // 실제 이름 필드 찾기 ('이름', 'Name', '학생이름' 등 시도)
      const studentRecord = response.results[0].properties;
      let realName = null;
      
      // 가능한 이름 필드들 시도
      const nameFields = ['이름', 'Name', '학생이름', '학생 이름', '성명'];
      for (const field of nameFields) {
        if (studentRecord[field]?.rich_text?.[0]?.plain_text) {
          realName = studentRecord[field].rich_text[0].plain_text;
          console.log(`찾은 이름 필드: ${field} = ${realName}`);
          break;
        }
        if (studentRecord[field]?.title?.[0]?.plain_text) {
          realName = studentRecord[field].title[0].plain_text;
          console.log(`찾은 이름 필드 (title): ${field} = ${realName}`);
          break;
        }
      }
      
      const studentName = realName || studentId;
      const studentRealName = realName || studentId;
      
      // JWT 토큰 생성
      const token = generateToken(studentId, {
        role: 'student',
        name: studentName,
        realName: studentRealName,
        assignedStudents: []
      });

      console.log('로그인 성공:', studentId);

      res.json({ 
        success: true, 
        message: '로그인 성공!',
        token: token,
        studentInfo: {
          studentId: studentId,
          studentName: studentName,
          studentRealName: studentRealName
        }
      });
    } else {
      console.log('아이디 또는 비밀번호 불일치');
      res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) {
    console.error('로그인 오류:', error);
    res.json({ success: false, message: '로그인 중 오류가 발생했습니다.' });
  }
});

// 학생 로그아웃
app.post('/logout', (req, res) => {
  res.json({ success: true, message: '로그아웃 되었습니다.' });
});

// 학생 플래너 페이지
app.get('/planner', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views/planner.html'));
});

// 학생 정보 API (JWT 기반)
app.get('/api/student-info', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const decoded = verifyToken(token);
  
  if (!decoded || decoded.role !== 'student') {
    return res.status(401).json({ error: '학생 인증이 필요합니다' });
  }
  
  res.json({
    studentId: decoded.userId,
    studentName: decoded.name || decoded.userId,
    studentRealName: decoded.realName || decoded.name || decoded.userId
  });
});

// 선생님 로그인 페이지
app.get('/teacher-login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views/teacher-login.html'));
});

// 선생님 로그인 처리 (JWT 기반)
app.post('/teacher-login', async (req, res) => {
  const { teacherId, teacherPassword } = req.body;
  
  // 사용자 계정 확인
  const userAccount = userAccounts[teacherId];
  
  if (userAccount && teacherPassword === userAccount.password) {
    // JWT 토큰 생성
    const token = generateToken(teacherId, userAccount);
    
    console.log(`로그인 성공: ${userAccount.name} (${userAccount.role})`);
    
    res.json({ 
      success: true, 
      message: '로그인 성공',
      token: token,
      userInfo: {
        userId: teacherId,
        userName: userAccount.name,
        userRole: userAccount.role,
        assignedStudents: userAccount.assignedStudents
      }
    });
  } else {
    console.log(`로그인 실패: ${teacherId}`);
    res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
});

// 선생님 로그아웃 (JWT는 클라이언트에서 토큰 삭제)
app.post('/teacher-logout', (req, res) => {
  res.json({ success: true, message: '로그아웃 되었습니다.' });
});

// 선생님 대시보드
app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views/teacher.html'));
});

// 사용자 정보 조회 API (JWT 기반)
app.get('/api/user-info', requireAuth, (req, res) => {
  res.json({
    userId: req.user.userId,
    userName: req.user.name,
    userRole: req.user.role,
    assignedStudents: req.user.assignedStudents
  });
});

// Vercel 배포용 기본 handler
export default app;

// 로컬 개발환경에서만 실행
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`학습 플래너 서버가 포트 ${PORT}에서 실행 중입니다!`);
    console.log(`학생용: http://localhost:${PORT}`);
    console.log(`선생님용: http://localhost:${PORT}/teacher`);
    
    // Notion 연결 상태 확인
    console.log('처우 Notion 연결 상태를 확인중...');
    getAccessToken()
      .then(() => console.log('✓ Notion 연결 성공!'))
      .catch(err => console.error('✗ Notion 연결 실패:', err.message));
  });
}