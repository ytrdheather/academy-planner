import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUncachableNotionClient } from '../notion-client.js';

// JWT 시크릿 키 (프로덕션에서 필수)
const JWT_SECRET = process.env.JWT_SECRET;
const DEV_SECRET = 'dev-only-secret-readitude-2025'; // 고정된 개발용 시크릿

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  console.warn('⚠️ 개발 환경: JWT_SECRET이 설정되지 않음. 고정된 개발용 시크릿 사용.');
}

// getAccessToken 함수 추가 (notion-client.js에서 가져오기)
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

// 환경 변수 검증 (선택사항)
const requiredEnvVars = {
  STUDENT_DATABASE_ID: '학생 로그인 정보 데이터베이스',
  PROGRESS_DATABASE_ID: '학습 진도 데이터베이스'
};

const missingVars = Object.keys(requiredEnvVars).filter(key => !process.env[key]);
if (missingVars.length > 0 && process.env.NODE_ENV !== 'production') {
  console.log('⚠️  개발 환경: 일부 환경 변수가 설정되지 않았습니다 (기본값 사용):');
  missingVars.forEach(varName => {
    console.log(`   ${varName}: ${requiredEnvVars[varName]}`);
  });
}

// JWT 기반 사용자 인증 미들웨어
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.auth_token;
  
  if (!token) {
    return res.status(401).json({ 
      error: '인증이 필요합니다. 로그인해주세요.',
      redirect: '/teacher-login'
    });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ 
      error: '유효하지 않은 토큰입니다. 다시 로그인해주세요.',
      redirect: '/teacher-login'
    });
  }
  
  // 사용자 정보를 req에 저장
  req.user = decoded;
  next();
}

// 권한 확인 함수
function hasPermission(userRole, requiredRole) {
  const roleHierarchy = {
    'manager': 3,
    'teacher': 2,
    'assistant': 1
  };
  return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
}

// 담당 학생 필터링 함수
function filterStudentsByRole(userRole, assignedStudents, allData) {
  if (userRole === 'manager') {
    // 매니저는 모든 학생 접근 가능
    return allData;
  } else if (userRole === 'teacher') {
    // 선생님은 담당 학생만 (일단 전체 반환 - Notion에서 담당강사 필드로 필터링 예정)
    return allData;
  } else {
    // 아르바이트생은 제한적 접근
    return allData;
  }
}

// 라우터 설정

// 홈페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views/login.html'));
});

// 학생 로그인 처리
app.post('/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  
  console.log('학생 로그인 시도:', { studentId, password: '***' });
  
  try {
    const notion = await getUncachableNotionClient();
    console.log('Notion 클라이언트 타입:', typeof notion, notion && notion.constructor && notion.constructor.name);
    
    // Notion 클라이언트가 제대로 생성되었는지 확인
    if (!notion || typeof notion.databases?.query !== 'function') {
      console.error('Notion 클라이언트가 올바르지 않음:', notion);
      // 임시 데이터로 테스트 가능하게 함
      if (studentId === 'test' && studentPassword === 'test') {
        const token = generateToken('test_student', {
          role: 'student',
          name: 'Test 원장',
          assignedStudents: []
        });
        
        return res.json({ 
          success: true, 
          message: '임시 로그인 성공',
          token: token,
          studentInfo: {
            studentId: 'test',
            studentName: 'Test 원장',
            studentRealName: 'Test 원장'
          }
        });
      } else {
        return res.json({ success: false, message: 'Notion 연결 오류. 관리자에게 문의하세요.' });
      }
    }

    // 실제 Notion 데이터베이스 조회
    const databaseId = process.env.STUDENT_DATABASE_ID;
    if (!databaseId) {
      console.error('STUDENT_DATABASE_ID 환경변수가 설정되지 않았습니다');
      return res.json({ success: false, message: '데이터베이스 설정 오류. 관리자에게 문의하세요.' });
    }

    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "학생 ID",
        rich_text: {
          equals: studentId
        }
      }
    });

    console.log('Notion 응답 길이:', response.results.length);

    if (response.results.length === 0) {
      console.log('학생을 찾을 수 없음:', studentId);
      return res.json({ success: false, message: '존재하지 않는 학생 ID입니다.' });
    }

    const student = response.results[0];
    const storedPassword = student.properties["비밀번호"]?.rich_text?.[0]?.text?.content;
    const studentName = student.properties["학생명"]?.title?.[0]?.text?.content || studentId;
    const studentRealName = student.properties["실명"]?.rich_text?.[0]?.text?.content || studentName;

    console.log('저장된 비밀번호:', storedPassword ? '***' : 'null');

    if (storedPassword !== studentPassword) {
      console.log('비밀번호 불일치');
      return res.json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }

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
      message: '로그인 성공',
      token: token,
      studentInfo: {
        studentId: studentId,
        studentName: studentName,
        studentRealName: studentRealName
      }
    });

  } catch (error) {
    console.error('로그인 처리 오류:', error);
    res.json({ success: false, message: '로그인 처리 중 오류가 발생했습니다.' });
  }
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

// 전체 학생 진도 조회 (권한별 필터링)
app.get('/api/student-progress', requireAuth, async (req, res) => {
  try {
    const userRole = req.user.role;
    const userName = req.user.name;
    const assignedStudents = req.user.assignedStudents;
    
    console.log(`${userName}(${userRole}) 진도 조회 시작...`);
    
    const notion = await getUncachableNotionClient();
    console.log('Notion 클라이언트 타입:', typeof notion, notion && notion.constructor && notion.constructor.name);
    
    // Notion 클라이언트가 제대로 생성되었는지 확인
    if (!notion || typeof notion.databases?.query !== 'function') {
      console.error('Notion 클라이언트가 올바르지 않음:', notion);
      
      // 권한별 임시 데이터 반환
      const sampleData = [
        {
          id: 'temp1',
          studentId: 'Test 원장',
          date: '2025-09-25',
          vocabScore: 85,
          grammarScore: 90,
          readingResult: 'pass',
          englishReading: '완료함',
          bookTitle: 'Harry Potter',
          feeling: '오늘 영어 공부가 재미있었어요!',
          assignedTeacher: '선생님1'
        },
        {
          id: 'temp2',
          studentId: 'Test 원장',
          date: '2025-09-24',
          vocabScore: 78,
          grammarScore: 82,
          readingResult: 'pass',
          englishReading: '완료함',
          bookTitle: 'Charlotte\'s Web',
          feeling: '단어가 조금 어려웠지만 열심히 했어요.',
          assignedTeacher: '선생님1'
        },
        {
          id: 'temp3',
          studentId: '김민수',
          date: '2025-09-25',
          vocabScore: 92,
          grammarScore: 88,
          readingResult: 'pass',
          englishReading: '완료함',
          bookTitle: 'The Little Prince',
          feeling: '오늘도 열심히 공부했어요!',
          assignedTeacher: '선생님2'
        }
      ];
      
      return res.json(filterStudentsByRole(userRole, assignedStudents, sampleData));
    }

    const databaseId = process.env.PROGRESS_DATABASE_ID;
    if (!databaseId) {
      console.error('PROGRESS_DATABASE_ID 환경변수가 설정되지 않았습니다');
      return res.json({ error: '데이터베이스 설정 오류. 관리자에게 문의하세요.' });
    }

    const response = await notion.databases.query({
      database_id: databaseId,
      sorts: [
        {
          property: '날짜',
          direction: 'descending'
        }
      ]
    });

    console.log(`Notion에서 ${response.results.length}개 레코드 조회됨`);

    const progressData = response.results.map(page => {
      const properties = page.properties;
      
      return {
        id: page.id,
        studentId: properties['학생 ID']?.title?.[0]?.text?.content || 
                  properties['학생 ID']?.rich_text?.[0]?.text?.content || '',
        date: properties['날짜']?.date?.start || '',
        vocabScore: properties['단어 점수']?.number || 0,
        grammarScore: properties['문법 점수']?.number || 0,
        readingResult: properties['독서 결과']?.select?.name || '',
        englishReading: properties['영어 읽기']?.rich_text?.[0]?.text?.content || '',
        bookTitle: properties['책 제목']?.rich_text?.[0]?.text?.content || '',
        feeling: properties['느낀점']?.rich_text?.[0]?.text?.content || '',
        assignedTeacher: properties['담당강사']?.rich_text?.[0]?.text?.content || ''
      };
    });

    // 권한별 데이터 필터링
    const filteredData = filterStudentsByRole(userRole, assignedStudents, progressData);
    
    // 활동 로그 기록
    console.log(`${userName}(${userRole})이 ${filteredData.length}건의 진도 데이터를 조회했습니다.`);
    
    res.json(filteredData);
  } catch (error) {
    console.error('전체 진도 조회 오류:', error);
    // 에러 발생시에도 권한별 임시 데이터 반환
    const errorSampleData = [
      {
        id: 'temp1',
        studentId: 'Test 원장',
        date: '2025-09-25',
        vocabScore: 85,
        grammarScore: 90,
        readingResult: 'pass',
        englishReading: '완료함',
        bookTitle: 'Harry Potter',
        feeling: '오늘 영어 공부가 재미있었어요!',
        assignedTeacher: '선생님1'
      }
    ];
    res.json(filterStudentsByRole(req.user.role, req.user.assignedStudents, errorSampleData));
  }
});

// 기타 API 엔드포인트들 (기존과 동일하지만 JWT 기반으로 수정)

// 로컬 개발용 서버 시작 (Replit 환경에서만)
if (process.env.REPLIT_DEPLOYMENT || (!process.env.VERCEL && process.env.NODE_ENV !== 'production')) {
  app.listen(PORT, () => {
    console.log(`학습 플래너 서버가 포트 ${PORT}에서 실행 중입니다!`);
    console.log(`학생용: http://localhost:${PORT}`);
    console.log(`선생님용: http://localhost:${PORT}/teacher`);
    console.log('처우 Notion 연결 상태를 확인중...');
    
    // Notion 연결 테스트
    getUncachableNotionClient()
      .then(() => console.log('✓ Notion 연결 성공!'))
      .catch(err => console.log('⚠️ Notion 연결 오류:', err.message));
  });
} else {
  console.log('버셀 서버리스 모드: Express 앱이 export됨');
}

// Vercel 서버리스 함수로 export
export default app;