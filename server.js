import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUncachableNotionClient } from './notion-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5000;

// 미들웨어 설정
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5000',
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'readitude-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24시간
  }
}));

// 환경 변수 검증 (필수)
const requiredEnvVars = {
  STUDENT_DATABASE_ID: '학생 로그인 정보 데이터베이스',
  PROGRESS_DATABASE_ID: '학습 진도 데이터베이스',
  TEACHER_ACCESS_TOKEN: '선생님 접근 토큰'
};

const missingVars = Object.keys(requiredEnvVars).filter(key => !process.env[key]);
if (missingVars.length > 0 && process.env.NODE_ENV === 'production') {
  console.error('❌ 프로덕션 환경에서 필수 환경 변수가 설정되지 않았습니다:');
  missingVars.forEach(key => {
    console.error(`   ${key}: ${requiredEnvVars[key]}`);
  });
  console.error('   이 변수들을 설정한 후 서버를 다시 시작하세요.');
  process.exit(1);
} else if (missingVars.length > 0) {
  console.warn('⚠️  개발 환경: 일부 환경 변수가 설정되지 않았습니다 (기본값 사용):');
  missingVars.forEach(key => {
    console.warn(`   ${key}: ${requiredEnvVars[key]}`);
  });
}

// 학생 데이터베이스 ID (원생 관리)
const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID || '25409320bce280f8ace1ddcdd022b360';
const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID || '25409320bce2807697ede3f1c1b62ada';
const BOOK_LIST_DB_ID = process.env.BOOK_LIST_DATABASE_ID || '9ef2bbaeec19466daa0d0c0677b9eb90';
const SAYU_BOOK_DB_ID = process.env.SAYU_BOOK_DATABASE_ID || 'cf82d56634574d7e83d893fbf1b1a4e3';

// 로그인 페이지
app.get('/', (req, res) => {
  if (req.session.studentId) {
    return res.redirect('/planner');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// 학습 플래너 페이지
app.get('/planner', (req, res) => {
  if (!req.session.studentId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'views', 'planner.html'));
});

// 선생님 페이지
app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'teacher.html'));
});

// 로그인 처리
app.post('/login', async (req, res) => {
  const { studentId, password } = req.body;
  
  try {
    console.log('🔍 로그인 시도:', studentId);
    console.log('📊 사용중인 데이터베이스 ID:', STUDENT_DB_ID);
    
    const notion = await getUncachableNotionClient();
    console.log('✅ Notion 클라이언트 생성 성공:', typeof notion, !!notion.databases);
    console.log('🔍 Notion 클라이언트 구조:', Object.keys(notion));
    console.log('📋 databases 객체 타입:', typeof notion.databases);
    console.log('📋 databases 객체 메서드:', Object.keys(notion.databases));
    console.log('📋 query 메서드 존재?', typeof notion.databases.query);
    
    // 학생 정보 조회 - 다양한 방법 시도
    let response;
    
    console.log('🔍 데이터베이스 조회 방법들 확인:');
    console.log('- notion.databases.query:', typeof notion.databases.query);
    console.log('- notion.search:', typeof notion.search);
    
    try {
      // 방법 1: 표준 query 시도
      if (notion.databases.query) {
        console.log('🔄 방법 1: databases.query 사용');
        response = await notion.databases.query({
          database_id: STUDENT_DB_ID,
          filter: {
            and: [
              {
                property: '학생 ID',
                rich_text: { equals: studentId }
              },
              {
                property: '비밀번호',
                rich_text: { equals: password.toString() }
              }
            ]
          }
        });
      } else {
        // 방법 2: search로 페이지 찾기
        console.log('🔄 방법 2: search로 페이지 찾기');
        response = await notion.search({
          query: studentId,
          filter: {
            value: 'page',
            property: 'object'
          },
          page_size: 10
        });
        
        console.log('🔍 검색 결과:', response.results.length, '개');
        
        // 검색 결과에서 해당 데이터베이스의 페이지만 필터링
        const filteredResults = response.results.filter(page => {
          return page.parent && page.parent.database_id === STUDENT_DB_ID;
        });
        
        console.log('🎯 필터링된 결과:', filteredResults.length, '개');
        response.results = filteredResults;
      }
    } catch (methodError) {
      console.error('🚨 메서드 실행 오류:', methodError.message);
      throw methodError;
    }

    if (response.results.length > 0) {
      req.session.studentId = studentId;
      req.session.studentName = response.results[0].properties['학생 ID']?.rich_text?.[0]?.plain_text || studentId;
      res.json({ success: true, message: '로그인 성공!' });
    } else {
      res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) {
    console.error('로그인 오류:', error);
    res.json({ success: false, message: '로그인 중 오류가 발생했습니다.' });
  }
});

// 로그아웃
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// 학습 데이터 저장
app.post('/save-progress', async (req, res) => {
  if (!req.session.studentId) {
    return res.json({ success: false, message: '로그인이 필요합니다.' });
  }

  try {
    const notion = await getUncachableNotionClient();
    const formData = req.body;
    
    // 오늘 날짜로 새 항목 생성
    const today = new Date().toISOString().split('T')[0];
    
    const properties = {
      '학생 ID': {
        rich_text: [{ text: { content: req.session.studentId } }]
      },
      '날짜': {
        date: { start: today }
      }
    };

    // 폼 데이터를 Notion 속성으로 변환
    if (formData['어휘정답']) {
      properties['어휘정답'] = { number: parseInt(formData['어휘정답']) || 0 };
    }
    if (formData['어휘총문제']) {
      properties['어휘총문제'] = { number: parseInt(formData['어휘총문제']) || 0 };
    }
    if (formData['문법 전체 개수']) {
      properties['문법 전체 개수'] = { number: parseInt(formData['문법 전체 개수']) || 0 };
    }
    if (formData['문법숙제오답']) {
      properties['문법숙제오답'] = { number: parseInt(formData['문법숙제오답']) || 0 };
    }
    if (formData['독해오답갯수']) {
      properties['독해오답갯수'] = { number: parseInt(formData['독해오답갯수']) || 0 };
    }
    if (formData['독해하브루타']) {
      properties['독해하브루타'] = { select: { name: formData['독해하브루타'] } };
    }
    if (formData['영어 더빙 학습 완료']) {
      properties['영어 더빙 학습 완료'] = { status: { name: formData['영어 더빙 학습 완료'] } };
    }
    if (formData['더빙 워크북 완료']) {
      properties['더빙 워크북 완료'] = { status: { name: formData['더빙 워크북 완료'] } };
    }
    if (formData['📖 영어독서']) {
      properties['📖 영어독서'] = { select: { name: formData['📖 영어독서'] } };
    }
    if (formData['어휘학습']) {
      properties['어휘학습'] = { select: { name: formData['어휘학습'] } };
    }
    if (formData['Writing']) {
      properties['Writing'] = { select: { name: formData['Writing'] } };
    }
    if (formData['오늘 읽은 영어 책']) {
      properties['오늘 읽은 영어 책'] = { rich_text: [{ text: { content: formData['오늘 읽은 영어 책'] } }] };
    }
    if (formData['📕 책 읽는 거인']) {
      properties['📕 책 읽는 거인'] = { select: { name: formData['📕 책 읽는 거인'] } };
    }
    if (formData['3독 독서 제목']) {
      properties['3독 독서 제목'] = { rich_text: [{ text: { content: formData['3독 독서 제목'] } }] };
    }
    if (formData['오늘의 학습 소감']) {
      properties['오늘의 학습 소감'] = { rich_text: [{ text: { content: formData['오늘의 학습 소감'] } }] };
    }

    // Notion 데이터베이스에 새 페이지 생성
    await notion.pages.create({
      parent: { database_id: PROGRESS_DB_ID },
      properties: properties
    });

    res.json({ success: true, message: '학습 데이터가 성공적으로 저장되었습니다!' });
  } catch (error) {
    console.error('저장 오류:', error);
    res.json({ success: false, message: '저장 중 오류가 발생했습니다.' });
  }
});

// 선생님 인증 미들웨어
function requireTeacherAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const validToken = process.env.TEACHER_ACCESS_TOKEN || 'dev-teacher-token';
  
  if (!authHeader || authHeader !== `Bearer ${validToken}`) {
    return res.status(401).json({ 
      error: '선생님 인증이 필요합니다.',
      hint: process.env.NODE_ENV !== 'production' ? 'Bearer dev-teacher-token 헤더를 추가하세요' : undefined
    });
  }
  next();
}

// 전체 학생 진도 조회 (선생님용)
app.get('/api/student-progress', requireTeacherAuth, async (req, res) => {
  try {
    const notion = await getUncachableNotionClient();

    const response = await notion.databases.query({
      database_id: PROGRESS_DB_ID,
      sorts: [
        {
          property: '날짜',
          direction: 'descending'
        }
      ]
    });

    const progressData = response.results.map(page => {
      const props = page.properties;
      return {
        id: page.id,
        studentId: props['학생 ID']?.rich_text?.[0]?.plain_text || '',
        date: props['날짜']?.date?.start || '',
        vocabScore: props['📰 단어 테스트 점수']?.formula?.number || 0,
        grammarScore: props['📑 문법 시험 점수']?.formula?.number || 0,
        readingResult: props['📚 독해 해석 시험 결과']?.formula?.string || '',
        englishReading: props['📖 영어독서']?.select?.name || '',
        bookTitle: props['오늘 읽은 영어 책']?.rich_text?.[0]?.plain_text || '',
        feeling: props['오늘의 학습 소감']?.rich_text?.[0]?.plain_text || ''
      };
    });

    res.json(progressData);
  } catch (error) {
    console.error('전체 진도 조회 오류:', error);
    res.json({ error: '진도 조회 중 오류가 발생했습니다.' });
  }
});

// 특정 학생 진도 조회 (선생님용)
app.get('/api/student-progress/:studentId', requireTeacherAuth, async (req, res) => {
  try {
    const notion = await getUncachableNotionClient();
    const { studentId } = req.params;
    
    const response = await notion.databases.query({
      database_id: PROGRESS_DB_ID,
      filter: {
        property: '학생 ID',
        rich_text: {
          equals: studentId
        }
      },
      sorts: [
        {
          property: '날짜',
          direction: 'descending'
        }
      ]
    });

    const progressData = response.results.map(page => {
      const props = page.properties;
      return {
        id: page.id,
        studentId: props['학생 ID']?.rich_text?.[0]?.plain_text || '',
        date: props['날짜']?.date?.start || '',
        vocabScore: props['📰 단어 테스트 점수']?.formula?.number || 0,
        grammarScore: props['📑 문법 시험 점수']?.formula?.number || 0,
        readingResult: props['📚 독해 해석 시험 결과']?.formula?.string || '',
        englishReading: props['📖 영어독서']?.select?.name || '',
        bookTitle: props['오늘 읽은 영어 책']?.rich_text?.[0]?.plain_text || '',
        feeling: props['오늘의 학습 소감']?.rich_text?.[0]?.plain_text || ''
      };
    });

    res.json(progressData);
  } catch (error) {
    console.error('특정 학생 진도 조회 오류:', error);
    res.json({ error: '진도 조회 중 오류가 발생했습니다.' });
  }
});

// 서버 시작
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 학습 플래너 서버가 포트 ${PORT}에서 실행 중입니다!`);
  console.log(`📝 학생용: http://localhost:${PORT}`);
  console.log(`👩‍🏫 선생님용: http://localhost:${PORT}/teacher`);
  
  // Notion 연결 상태 확인
  try {
    console.log('🔗 Notion 연결 상태를 확인중...');
    const notion = await getUncachableNotionClient();
    console.log('✅ Notion 연결 성공!');
  } catch (error) {
    console.error('❌ Notion 연결 실패:', error.message);
    console.log('💡 해결 방법: Replit의 Secrets에서 Notion 연결을 확인해주세요');
  }
});