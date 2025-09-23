import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUncachableNotionClient } from './notion-client.js';

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

// 데이터베이스 ID를 Notion 형식으로 변환하는 함수
function formatNotionId(id) {
  // 대시가 없는 경우 Notion 형식으로 변환 (8-4-4-4-12)
  if (id && !id.includes('-') && id.length === 32) {
    return `${id.substring(0, 8)}-${id.substring(8, 12)}-${id.substring(12, 16)}-${id.substring(16, 20)}-${id.substring(20, 32)}`;
  }
  return id;
}

// 학생 데이터베이스 ID (원생 관리)  
const STUDENT_DB_ID = formatNotionId(process.env.STUDENT_DATABASE_ID || '25409320bce280f8ace1ddcdd022b360');
const PROGRESS_DB_ID = formatNotionId(process.env.PROGRESS_DATABASE_ID || '25409320bce2807697ede3f1c1b62ada');
const BOOK_LIST_DB_ID = formatNotionId(process.env.BOOK_LIST_DATABASE_ID || '9ef2bbaeec19466daa0d0c0677b9eb90');
const SAYU_BOOK_DB_ID = formatNotionId(process.env.SAYU_BOOK_DATABASE_ID || 'cf82d56634574d7e83d893fbf1b1a4e3');

// 데이터베이스 연결 확인 완료

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
    // 학생 정보 조회 - REST API 직접 호출
    const accessToken = await getAccessToken();
    
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
                equals: password.toString()
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