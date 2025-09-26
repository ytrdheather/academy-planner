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
    
    // 정확한 "New 학생 명부 관리" 데이터베이스 ID 사용
    const STUDENT_DB_ID = '25409320bce280f8ace1ddcdd022b360';
    
    if (!STUDENT_DB_ID) {
      console.error('학생 데이터베이스 ID가 설정되지 않았습니다');
      return res.json({ success: false, message: '데이터베이스 설정 오류. 관리자에게 문의하세요.' });
    }
    
    console.log('학생 DB ID:', STUDENT_DB_ID);
    
    // 먼저 데이터베이스 스키마 확인
    const schemaResponse = await fetch(`https://api.notion.com/v1/databases/${STUDENT_DB_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      }
    });
    
    if (schemaResponse.ok) {
      const schema = await schemaResponse.json();
      console.log('데이터베이스 속성들:', Object.keys(schema.properties));
    }
    
    // 정확한 데이터베이스와 속성명으로 로그인 처리
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

// 숙제 현황 조회 API (JWT 기반) - Manager는 전체, Teacher는 담당 학생만
app.get('/api/homework-status', requireAuth, async (req, res) => {
  console.log(`숙제 현황 조회 시작: ${req.user.name} (${req.user.role})`);
  
  try {
    // Vercel 호환: 직접 NOTION_ACCESS_TOKEN 사용 또는 Replit 커넥터 폴백
    let accessToken;
    
    if (process.env.NOTION_ACCESS_TOKEN) {
      accessToken = process.env.NOTION_ACCESS_TOKEN;
      console.log('Vercel 모드: NOTION_ACCESS_TOKEN 사용');
    } else {
      accessToken = await getAccessToken();
      console.log('Replit 모드: 커넥터 사용');
    }
    
    // 데이터베이스 ID들
    const STUDENT_DB_ID = '25409320bce280f8ace1ddcdd022b360'; // "New 학생 명부 관리"
    const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID || '25409320bce2807697ede3f1c1b62ada'; // "NEW 리디튜드 학생 진도 관리"
    
    // 오늘 날짜 (ISO 형식으로 변경)
    const now = new Date();
    const kstOffset = 9 * 60; // 한국 시간은 UTC+9
    const kstTime = new Date(now.getTime() + (kstOffset * 60 * 1000));
    const today = kstTime.toISOString().split('T')[0]; // YYYY-MM-DD 형식
    
    console.log(`오늘 날짜 필터: ${today}`);
    console.log(`진도 관리 DB ID: ${PROGRESS_DB_ID}`);

    // 1단계: "NEW 리디튜드 학생 진도 관리"에서 전체 데이터 조회 후 필터링
    console.log('진도 관리 DB 조회 시작...');
    const progressResponse = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        page_size: 100
      })
    });

    console.log(`진도 관리 DB 응답 상태: ${progressResponse.status}`);
    
    if (!progressResponse.ok) {
      const errorText = await progressResponse.text();
      console.error('진도 관리 DB 오류 응답:', errorText);
      throw new Error(`진도 관리 DB 조회 오류: ${progressResponse.status} - ${errorText}`);
    }

    const progressData = await progressResponse.json();
    console.log(`진도 관리에서 조회된 전체 학습일지: ${progressData.results.length}개`);
    
    // 데이터베이스 속성들 확인
    if (progressData.results.length > 0) {
      const firstPage = progressData.results[0];
      console.log('진도 관리 DB 속성들:', Object.keys(firstPage.properties));
    }
    
    // 오늘 날짜에 해당하는 학습일지만 필터링
    const todayProgressData = progressData.results.filter(page => {
      const pageDate = page.properties['🕐 날짜']?.date?.start;
      console.log(`학습일지 날짜: ${pageDate}, 오늘: ${today}`);
      return pageDate === today;
    });
    
    console.log(`오늘(${today}) 학습일지: ${todayProgressData.length}개`);
    
    // 오늘 학습일지가 있는 학생 ID들 추출
    const studentIdsWithProgress = todayProgressData.map(page => {
      const studentId = page.properties['이름']?.title?.[0]?.plain_text;
      console.log(`진도 관리 학생 ID: ${studentId}`);
      return studentId;
    }).filter(id => id); // null/undefined 제거

    console.log(`오늘 학습일지 작성한 학생들: ${studentIdsWithProgress.join(', ')}`);

    if (studentIdsWithProgress.length === 0) {
      console.log('오늘 학습일지 작성한 학생이 없습니다.');
      // 빈 배열 반환하여 "숙제 현황 데이터가 없습니다" 표시
      return res.json([]);
    }

    // 2단계: 진도 관리 DB에서 직접 숙제 현황 추출
    console.log('진도 관리 DB에서 숙제 상태 직접 추출 시작...');
    
    const homeworkData = todayProgressData.map(progressPage => {
      const props = progressPage.properties;
      const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';
      
      console.log(`=== ${studentName} 학생의 진도 관리 숙제 데이터 ===`);
      console.log('⭕ 지난 문법 숙제 검사 원본:', JSON.stringify(props['⭕ 지난 문법 숙제 검사']));
      console.log('1️⃣ 어휘 클카 원본:', JSON.stringify(props['1️⃣ 어휘 클카 암기 숙제']));
      console.log('2️⃣ 독해 단어 클카 원본:', JSON.stringify(props['2️⃣ 독해 단어 클카 숙제']));
      console.log('4️⃣ Summary 원본:', JSON.stringify(props['4️⃣ Summary 숙제']));
      console.log('5️⃣ 매일 독해 원본:', JSON.stringify(props['5️⃣ 매일 독해 숙제']));
      console.log('6️⃣ 영어 일기 원본:', JSON.stringify(props['6️⃣ 영어 일기(초등) / 개인 독해서 (중고등)']));
      console.log('수행율 원본:', JSON.stringify(props['수행율']));
      
      // 6가지 숙제 카테고리 상태 확인 (status 속성에서 name 추출)
      const grammarHomework = props['⭕ 지난 문법 숙제 검사']?.status?.name || '해당없음';
      const vocabCards = props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '해당없음';
      const readingCards = props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '해당없음';
      const summary = props['4️⃣ Summary 숙제']?.status?.name || '해당없음';
      const readingHomework = props['5️⃣ 매일 독해 숙제']?.status?.name || '해당없음';
      const diary = props['6️⃣ 영어 일기(초등) / 개인 독해서 (중고등)']?.status?.name || '해당없음';
      
      // 수행율 정보 (formula string에서 추출)
      const performanceRateString = props['수행율']?.formula?.string || '0%';
      const performanceRate = parseFloat(performanceRateString.replace('%', '')) || 0;
      
      // 담당쌤 정보 추출
      const assignedTeacher = props['담당쌤']?.select?.name || '미배정';
      
      console.log('추출된 값들:');
      console.log('  ⭕ 지난 문법 숙제 검사:', grammarHomework);
      console.log('  1️⃣ 어휘 클카:', vocabCards);
      console.log('  2️⃣ 독해 단어 클카:', readingCards);
      console.log('  4️⃣ Summary:', summary);
      console.log('  5️⃣ 매일 독해:', readingHomework);
      console.log('  6️⃣ 영어 일기:', diary);
      console.log('  수행율:', performanceRate);
      console.log('  담당쌤:', assignedTeacher);
      
      // 완료율 계산 ("숙제 함"이면 완료로 간주)
      const statuses = [grammarHomework, vocabCards, readingCards, summary, readingHomework, diary];
      const completedCount = statuses.filter(status => status === '숙제 함').length;
      const completionRate = Math.round((completedCount / 6) * 100);
      
      console.log(`완료 체크: ${statuses} -> 완료개수: ${completedCount}/6 = ${completionRate}%`);
      console.log('===============================');
      
      return {
        studentId: studentName,
        grammarHomework: grammarHomework,
        vocabCards: vocabCards,
        readingCards: readingCards,
        summary: summary,
        readingHomework: readingHomework,
        diary: diary,
        completionRate: performanceRate > 0 ? Math.round(performanceRate) : completionRate, // 노션 수행율이 있으면 사용, 없으면 계산값 사용
        teacher: assignedTeacher, // 실제 담당쌤 정보
        rawData: {
          name: studentName,
          performanceRate: performanceRate,
          teacher: assignedTeacher
        }
      };
    });

    // Manager는 모든 학생, Teacher는 담당 학생만 (현재는 Manager 테스트용으로 모든 데이터)
    let filteredData = homeworkData;
    
    if (req.user.role === 'manager') {
      // Manager: 모든 학생 데이터
      filteredData = homeworkData;
      console.log(`Manager ${req.user.name}: 전체 ${homeworkData.length}명 학생 조회`);
    } else if (req.user.role === 'teacher') {
      // Teacher: 담당 학생만 (현재는 임시로 모든 데이터)
      filteredData = homeworkData;
      console.log(`Teacher ${req.user.name}: ${homeworkData.length}명 학생 조회`);
    } else if (req.user.role === 'assistant') {
      // Assistant: 제한된 데이터
      filteredData = homeworkData.slice(0, 10);
      console.log(`Assistant ${req.user.name}: 제한된 ${filteredData.length}명 학생 조회`);
    }

    res.json(filteredData);

  } catch (error) {
    console.error('숙제 현황 조회 오류:', error);
    console.error('오류 상세:', error.message);
    
    // 오류 시 빈 배열 반환 (샘플 데이터 제거)
    res.json([]);
  }
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