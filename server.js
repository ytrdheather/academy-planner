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
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'readitude-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24시간
}));

// 학생 데이터베이스 ID (원생 관리)
const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID || '25409320bce2807697ede3f1c1b62ada';
const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID || '25409320bce2807697ede3f1c1b62ada'; // 동일한 DB에서 시작

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
    const notion = await getUncachableNotionClient();
    
    // 학생 정보 조회
    const response = await notion.databases.query({
      database_id: STUDENT_DB_ID,
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
            number: {
              equals: parseInt(password)
            }
          }
        ]
      }
    });

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

// 전체 학생 진도 조회 (선생님용)
app.get('/api/student-progress', async (req, res) => {
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
app.get('/api/student-progress/:studentId', async (req, res) => {
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 학습 플래너 서버가 포트 ${PORT}에서 실행 중입니다!`);
  console.log(`📝 학생용: http://localhost:${PORT}`);
  console.log(`👩‍🏫 선생님용: http://localhost:${PORT}/teacher`);
});