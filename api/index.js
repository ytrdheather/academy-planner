import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs'; // 1. 리포트 템플릿 파일을 읽기 위해 'fs' 모듈 추가
import cron from 'node-cron'; // 2. 스케줄링(자동화)을 위해 'node-cron' 모듈 추가
import { GoogleGenerativeAI } from '@google/generative-ai'; // 3. Gemini AI 연결을 위해 모듈 추가

// --- .env 파일에서 환경 변수 로드 ---
const {
  JWT_SECRET = 'dev-only-secret-readitude-2025',
  NOTION_ACCESS_TOKEN,
  STUDENT_DATABASE_ID,
  PROGRESS_DATABASE_ID,
  KOR_BOOKS_ID,
  ENG_BOOKS_ID,
  GEMINI_API_KEY, // AI 요약 기능용 API 키
  MONTHLY_REPORT_DB_ID, // 월간 리포트 저장용 DB ID
  GRAMMAR_DB_ID, // 문법 숙제 관리 DB ID
  //  [수정] localhost -> 실제 서비스 주소로 기본값 변경
  DOMAIN_URL = 'https://readitude.onrender.com' // 배포 시 .env 변수로 대체됨
} = process.env;

const PORT = process.env.PORT || 5001; // Render의 PORT 또는 로컬 5001

// --- 기본 설정 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const publicPath = path.join(__dirname, '../public');

// [신규] Gemini AI 클라이언트 설정
let genAI;
let geminiModel;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-09-2025' });
  console.log(' Gemini AI가 성공적으로 연결되었습니다.');
} else {
  console.warn(' GEMINI_API_KEY가 .env 파일에 없습니다. AI 요약 기능이 비활성화됩니다.');
}

// (교사 계정 정보는 변경 없음)
const userAccounts = {
  'manager': { password: 'rdtd112!@', role: 'manager', name: '원장 헤더쌤' },
  'teacher1': { password: 'rdtd112!@', role: 'manager', name: '조이쌤' },
  'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '주디쌤' },
  'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '소영쌤' },
  'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '레일라쌤' },
  'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '제니쌤' },
  'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '릴리쌤' }
};

// --- [신규] Notion API 호출 래퍼 (에러 핸들링 및 재시도) ---
async function fetchNotion(url, options) {
  const headers = {
    'Authorization': `Bearer ${NOTION_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorData = await response.json();
    console.error(`Notion API Error (${url}):`, JSON.stringify(errorData, null, 2));
    throw new Error(errorData.message || `Notion API Error: ${response.status}`);
  }
  return response.json();
}

// --- Helper Functions (기존 함수들) ---
function generateToken(userData) { return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; } }

// [신규] 헬퍼 함수: 롤업 또는 속성에서 간단한 텍스트 추출
const getSimpleText = (prop) => {
  if (!prop) return '';
  // [수정] 코멘트 잘림 버그 해결 (여러 개의 텍스트 조각을 \n으로 합침)
  if (prop.type === 'rich_text') {
    return prop.rich_text.map(t => t.plain_text).join('\n');
  }
  if (prop.type === 'title' && prop.title.length > 0) return prop.title[0].plain_text;
  if (prop.type === 'select' && prop.select) return prop.select.name;
  return '';
};

async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
  if (!NOTION_ACCESS_TOKEN || !title || !databaseId) return null;
  try {
    const isTitleProp = ['Title', '책제목', '이름'].includes(titlePropertyName);
    let filterBody;
    if (titlePropertyName === '반이름') {
      filterBody = { property: titlePropertyName, select: { equals: title } };
    } else if (isTitleProp) {
      filterBody = { property: titlePropertyName, title: { contains: title } };
    } else {
      filterBody = { property: titlePropertyName, rich_text: { contains: title } };
    }

    const data = await fetchNotion(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ filter: filterBody, page_size: 1 })
    });
    return data.results[0]?.id || null;
  } catch (error) {
    console.error(`Error finding page ID for title "${title}" in DB ${databaseId}:`, error);
    return null;
  }
}

// --- 미들웨어 (기존과 동일) ---
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

// --- 페이지 라우트 (기존과 동일) ---
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));


// --- [신규] 헬퍼 함수: KST 기준 '오늘'의 시작과 끝, 날짜 문자열 반환 ---
function getKSTDayRange(dateString) {
  // dateString이 없으면 KST 기준 '오늘'을 사용
  const kstNow = dateString ? new Date(dateString) : new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  
  // 'YYYY-MM-DD' 형식의 문자열 생성 (KST 기준)
  const kstDateString = kstNow.toISOString().split('T')[0];
  
  // KST 기준의 시작과 끝
  // (Notion API는 ISO 8601 형식의 UTC 또는 오프셋 포함 문자열을 선호)
  const start = new Date(`${kstDateString}T00:00:00.000+09:00`);
  const end = new Date(`${kstDateString}T23:59:59.999+09:00`);
  
  return {
    start: start.toISOString(), // UTC로 변환된 값 (예: "2025-11-09T15:00:00.000Z")
    end: end.toISOString(),   // UTC로 변환된 값 (예: "2025-11-10T14:59:59.999Z")
    dateString: kstDateString  // URL용 (예: "2025-11-10")
  };
}

// [유지] 헬퍼 함수: 날짜를 'YYYY년 MM월 DD일 (요일)' 형식으로 변환 ---
function getKoreanDate(dateString) {
  const date = new Date(dateString);
  const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' };
  return new Intl.DateTimeFormat('ko-KR', options).format(date);
}

// --- [공통] 헬퍼 함수: 롤업 데이터 추출 (수정됨) ---
const getRollupValue = (prop, isNumber = false) => {
  if (!prop?.rollup) return isNumber ? null : '';
  if (prop.rollup.type === 'number') return prop.rollup.number;
  if (prop.rollup.type === 'array' && prop.rollup.array.length > 0) {
    const firstItem = prop.rollup.array[0];
    if (!firstItem) return isNumber ? null : '';
    if (firstItem.type === 'title' && firstItem.title.length > 0) return firstItem.title[0].plain_text;
    if (firstItem.type === 'rich_text' && firstItem.rich_text.length > 0) return firstItem.rich_text[0].plain_text;
    if (firstItem.type === 'number') return firstItem.number;
    if (firstItem.type === 'relation') return ''; // 관계형 자체는 빈값 처리
    if (firstItem.type === 'select' && firstItem.select) return firstItem.select.name; // '선택' 속성 롤업 추가
    if (firstItem.type === 'formula') {
      if (firstItem.formula.type === 'string') return firstItem.formula.string;
      if (firstItem.formula.type === 'number') return firstItem.formula.number;
    }
  }
  if (prop.rollup.type === 'formula') {
    if (prop.rollup.formula.type === 'number') return prop.rollup.formula.number;
    if (prop.rollup.formula.type === 'string') return prop.rollup.formula.string;
  }
  return isNumber ? null : '';
};

// =======================================================================
// [기능 분리 1: 데일리 대시보드용 파서]
// '어제 잘 되던' 원본 코드로 완벽하게 복구된 함수입니다.
// (속성 이름: ⭕, 1️⃣, 📰, 📖, ❤ 등)
// =======================================================================
async function parseDailyReportData(page) {
  const props = page.properties;
  const studentName = props['이름']?.title?.[0]?.plain_text || '학생';
  const pageDate = props['🕐 날짜']?.date?.start || getKSTDayRange().dateString;

  let assignedTeachers = [];
  if (props['담당쌤']?.rollup?.array) {
    assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text || item.rich_text?.[0]?.plain_text))].filter(Boolean);
  }

  // 1. 숙제 및 테스트
  // [수정] '수행율' 속성도 'formula.string'으로 읽어옵니다.
  const performanceRateString = props['수행율']?.formula?.string || '0%';
  const performanceRate = parseFloat(performanceRateString.replace('%', '')) || 0;

  const homework = {
    grammar: props['⭕ 지난 문법 숙제 검사']?.status?.name || '해당 없음',
    vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '해당 없음',
    readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '해당 없음',
    summary: props['4️⃣ Summary 숙제']?.status?.name || '해당 없음',
    diary: props['6️⃣ 영어일기 or 개인 독해서']?.status?.name || '해당 없음'
  };

  const tests = {
    vocabUnit: props['어휘유닛']?.rich_text?.[0]?.plain_text || '',
    vocabCorrect: props['단어 (맞은 개수)']?.number ?? null,
    vocabTotal: props['단어 (전체 개수)']?.number ?? null,
    // [수정] 'formula.string'으로 읽어옵니다. (원본 복구)
    vocabScore: props['📰 단어 테스트 점수']?.formula?.string || 'N/A', // N/A 또는 점수(%)
    readingWrong: props['독해 (틀린 개수)']?.number ?? null,
    readingResult: props['📚 독해 해석 시험 결과']?.formula?.string || 'N/A', // PASS, FAIL, N/A
    havruta: props['독해 하브루타']?.select?.name || '숙제없음',
    grammarTotal: props['문법 (전체 개수)']?.number ?? null,
    grammarWrong: props['문법 (틀린 개수)']?.number ?? null,
    // [수정] 'formula.string'으로 읽어옵니다. (원본 복구)
    grammarScore: props['📑 문법 시험 점수']?.formula?.string || 'N/A' // N/A 또는 점수(%)
  };

  // 2. 리스닝
  const listening = {
    study: props['영어 더빙 학습 완료']?.status?.name || '진행하지 않음',
    workbook: props['더빙 워크북 완료']?.status?.name || '진행하지 않음'
  };

  // 3. 독서
  const reading = {
    readingStatus: props['📖 영어독서']?.select?.name || '',
    vocabStatus: props['어휘학습']?.select?.name || '',
    bookTitle: getRollupValue(props['📖 책제목 (롤업)']) || '읽은 책 없음',
    bookRelationId: props['오늘 읽은 영어 책']?.relation?.[0]?.id || '',
    bookSeries: getRollupValue(props['시리즈이름']),
    bookAR: getRollupValue(props['AR'], true),
    bookLexile: getRollupValue(props['Lexile'], true),
    writingStatus: props['Writing']?.select?.name || 'N/A'
  };

  // --- 4. 문법 DB에서 진도/숙제 내용 가져오기 ---
  const grammarClassName = getRollupValue(props['문법클래스']) || null;
  let grammarTopic = '진도 해당 없음';
  let grammarHomework = '숙제 내용 없음';

  if (grammarClassName && GRAMMAR_DB_ID) {
    try {
      const grammarDbData = await fetchNotion(`https://api.notion.com/v1/databases/${GRAMMAR_DB_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            property: '반이름',
            select: { equals: grammarClassName }
          },
          page_size: 1
        })
      });

      if (grammarDbData.results.length > 0) {
        const grammarProps = grammarDbData.results[0].properties;
        grammarTopic = getSimpleText(grammarProps['문법 진도 내용']) || '진도 해당 없음';
        grammarHomework = getSimpleText(grammarProps['문법 과제 내용']) || '숙제 내용 없음';
      }
    } catch (e) {
      console.error(`[문법 DB 조회 오류] (반이름: ${grammarClassName}):`, e.message);
    }
  }

  // 4. 코멘트
  const comment = {
    // [수정] 코멘트 잘림 버그 해결 (getSimpleText 사용)
    teacherComment: getSimpleText(props['❤ Today\'s Notice!']) || '오늘의 코멘트가 없습니다.',
    grammarClass: grammarClassName || '진도 해당 없음',
    grammarTopic: grammarTopic,
    grammarHomework: grammarHomework
  };

  // 5. 월간 리포트용 학생 ID (관계형)
  const studentRelationId = props['학생']?.relation?.[0]?.id || null;

  return {
    pageId: page.id,
    studentName,
    studentRelationId, // 월간 리포트 통계용
    date: pageDate,
    teachers: assignedTeachers,
    completionRate: Math.round(performanceRate),
    homework,
    tests,
    listening,
    reading,
    comment
  };
}

// =======================================================================
// [기능 분리 2: 월간 리포트 통계용 파서]
// '월간 리포트' 통계에만 필요한 속성을 읽어오는 새 함수입니다.
// (속성 이름: 수행율, 📰..., 🕐 날짜 등)
// =======================================================================
function parseMonthlyStatsData(page) {
  const props = page.properties;
  
  // 1. 날짜
  const pageDate = props['🕐 날짜']?.date?.start || null;
  
  // 2. 학생 ID
  const studentRelationId = props['학생']?.relation?.[0]?.id || null;

  // 3. 숙제 수행율 (0점 포함)
  const performanceRateString = props['수행율']?.formula?.string || '0%';
  const completionRate = parseFloat(performanceRateString.replace('%', '')) || 0; // 0%는 0으로

  // 4. 어휘/문법 점수 (0점은 N/A로)
  const vocabScoreString = props['📰 단어 테스트 점수']?.formula?.string || 'N/A';
  const grammarScoreString = props['📑 문법 시험 점수']?.formula?.string || 'N/A';

  // 5. 독해 결과
  const readingResult = props['📚 독해 해석 시험 결과']?.formula?.string || 'N/A'; // PASS, FAIL, N/A

  // 6. 읽은 책
  const bookTitle = getRollupValue(props['📖 책제목 (롤업)']) || '읽은 책 없음';
  
  // 7. 코멘트
  // [수정] 코멘트 잘림 버그 해결 (getSimpleText 사용)
  const teacherComment = getSimpleText(props['❤ Today\'s Notice!']) || '';

  // [수정] 통계 계산 로직 (숙제 0점 포함 / 시험 0점 제외)
  
  // 'N/A' 또는 null이 아닌 실제 점수만 숫자로 변환
  const parseScore = (scoreString) => {
    if (scoreString === 'N/A' || scoreString === null || scoreString === undefined) {
      return null; // 통계 계산에서 제외
    }
    const score = parseFloat(scoreString.replace('%', ''));
    if (isNaN(score)) {
      return null; // "PASS" 같은 문자열이 숫자로 변환 실패 시 제외
    }
    // 0점('시험 안 봄')은 제외, 0%('수행율')는 포함
    // -> 이 함수는 점수만 다루므로 0점은 제외
    if (score === 0) {
      return null; 
    }
    return score;
  };
  
  const vocabScore = parseScore(vocabScoreString);
  const grammarScore = parseScore(grammarScoreString);

  return {
    studentRelationId,
    date: pageDate,
    completionRate: completionRate, // 0점 포함
    vocabScore: vocabScore,     // 0점 제외 (null)
    grammarScore: grammarScore, // 0점 제외 (null)
    readingResult: readingResult,
    bookTitle: bookTitle,
    teacherComment: teacherComment
  };
}


// --- [공통] 데이터 조회 함수 (파서를 위 함수로 교체) ---
async function fetchProgressData(req, res, parseFunction) {
  const { period = 'today', date, teacher } = req.query;
  if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) {
    throw new Error('서버 환경 변수가 설정되지 않았습니다.');
  }

  // [수정] '오늘' 또는 '특정 날짜'의 KST 범위를 가져오도록 수정
  const filterConditions = [];
  if (period === 'specific_date' && date) {
    // '날짜 지정'
    const { start, end } = getKSTDayRange(date);
    filterConditions.push({ property: '🕐 날짜', date: { on_or_after: start } });
    filterConditions.push({ property: '🕐 날짜', date: { on_or_before: end } });
  } else { 
    // 기본값 'today'
    const { start, end } = getKSTDayRange(); // 오늘 KST 범위
    filterConditions.push({ property: '🕐 날짜', date: { on_or_after: start } });
    filterConditions.push({ property: '🕐 날짜', date: { on_or_before: end } });
  }

  const pages = [];
  let hasMore = true;
  let startCursor = undefined;
  while (hasMore) {
    const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: filterConditions.length > 0 ? { and: filterConditions } : undefined,
        sorts: [{ property: '🕐 날짜', direction: 'descending' }, { property: '이름', direction: 'ascending' }],
        page_size: 100, start_cursor: startCursor
      })
    });
    pages.push(...data.results);
    hasMore = data.has_more; startCursor = data.next_cursor;
  }

  // [수정] parseFunction이 동기/비동기일 수 있으므로 Promise.all()로 안전하게 처리
  const parsedData = await Promise.all(pages.map(parseFunction));
  return parsedData;
}

// --- API 라우트 (데이터 조회를 통합 파서로 변경) ---

app.get('/api/daily-report-data', requireAuth, async (req, res) => {
  try {
    // [수정] "데일리 대시보드"용 파서를 명시적으로 사용
    const data = await fetchProgressData(req, res, parseDailyReportData);
    res.json(data);
  } catch (error) {
    console.error('데일리 리포트 데이터 로드 오류:', error);
    res.status(500).json({ message: error.message || '서버 오류' });
  }
});

// 업데이트 API (진도 관리 DB) - (기존과 동일)
app.post('/api/update-homework', requireAuth, async (req, res) => {
  const { pageId, propertyName, newValue, propertyType } = req.body;
  if (!pageId || !propertyName || newValue === undefined) { return res.status(400).json({ success: false, message: '필수 정보 누락' }); }

  try {
    if (!NOTION_ACCESS_TOKEN) { throw new Error('서버 토큰 오류'); }
    let notionUpdatePayload;
    switch (propertyType) {
      case 'number':
        const numValue = Number(newValue);
        notionUpdatePayload = { number: (isNaN(numValue) || newValue === '' || newValue === null) ? null : numValue };
        break;
      case 'rich_text':
        notionUpdatePayload = { rich_text: [{ text: { content: newValue || '' } }] };
        break;
      case 'select':
        if (newValue === null || newValue === '숙제없음' || newValue === '') { notionUpdatePayload = { select: null }; }
        else { notionUpdatePayload = { select: { name: newValue } }; }
        break;
      case 'relation':
        if (newValue === null || newValue === '') { notionUpdatePayload = { relation: [] }; }
        else { notionUpdatePayload = { relation: [{ id: newValue }] }; }
        break;
      case 'status': default:
        if (newValue === null || newValue === '숙제 없음' || newValue === '진행하지 않음' || newValue === '해당 없음') {
          const defaultStatusName = (newValue === '진행하지 않음') ? "진행하지 않음" : (newValue === '해당 없음' ? "해당 없음" : "숙제 없음");
          notionUpdatePayload = { status: { name: defaultStatusName } };
        } else { notionUpdatePayload = { status: { name: newValue } }; }
        break;
    }
    
    // [수정] URL 버그 수정 (notion.com 추가)
    await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { [propertyName]: notionUpdatePayload } })
    });
    
    res.json({ success: true, message: '업데이트 성공' });
  } catch (error) {
    console.error(`숙제 업데이트 처리 중 오류 (PageID: ${pageId}):`, error);
    res.status(500).json({ success: false, message: error.message || '서버 내부 오류' });
  }
});


// --- 나머지 API 라우트 (기존과 동일) ---
app.get('/api/teachers', requireAuth, async (req, res) => {
  try {
    const teacherNames = Object.values(userAccounts).filter(acc => acc.role === 'teacher' || acc.role === 'manager').map(acc => acc.name);
    const teacherOptions = teacherNames.map((name, index) => ({ id: `t${index}`, name: name }));
    res.json(teacherOptions);
  } catch (error) { console.error('강사 목록 로드 오류:', error); res.status(500).json([]); }
});

app.post('/teacher-login', async (req, res) => {
  try {
    const { teacherId, teacherPassword } = req.body;
    if (!teacherId || !teacherPassword) { return res.status(400).json({ success: false, message: '아이디와 비밀번호를 모두 입력해주세요.' }); }
    if (!userAccounts[teacherId]) { return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' }); }
    const userAccount = userAccounts[teacherId];
    if (userAccount.password === teacherPassword) {
      const tokenPayload = { loginId: teacherId, name: userAccount.name, role: userAccount.role };
      const token = generateToken(tokenPayload);
      res.json({ success: true, message: '로그인 성공', token });
    } else {
      res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) { console.error('선생님 로그인 처리 중 예외 발생:', error); res.status(500).json({ success: false, message: '서버 내부 오류로 로그인 처리에 실패했습니다.' }); }
});

app.get('/api/teacher/user-info', requireAuth, (req, res) => {
  if (!req.user) { return res.status(401).json({ error: '인증 실패' }); }
  res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId });
});

// [수정] 학생 플래너가 호출하는 /api/student-info 복구
app.get('/api/student-info', requireAuth, (req, res) => {
  if (!req.user || req.user.role !== 'student') {
    return res.status(401).json({ error: '학생 인증이 필요합니다' });
  }
  // planner.html이 기대하는 studentName, studentRealName을 반환
  res.json({ 
    studentId: req.user.userId, 
    studentName: req.user.name, 
    studentRealName: req.user.name 
  });
});

app.post('/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  try {
    if (!NOTION_ACCESS_TOKEN || !STUDENT_DATABASE_ID) { return res.status(500).json({ success: false, message: '서버 설정 오류.' }); }
    const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({ filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] } })
    });
    if (data.results.length > 0) {
      const studentRecord = data.results[0].properties;
      const realName = studentRecord['이름']?.title?.[0]?.plain_text || studentId;
      const token = generateToken({ userId: studentId, role: 'student', name: realName });
      // [수정] 'userName'을 제거하고 'token'만 반환 (원본 '잘 되던' 코드 복구)
      res.json({ success: true, message: '로그인 성공!', token });
    } else {
      res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) { console.error('로그인 오류:', error); res.status(500).json({ success: false, message: '로그인 중 오류가 발생했습니다.' }); }
});

// =======================================================================
// [ !!!!! 문제의 API !!!!! ]
// =======================================================================

app.get('/api/search-books', requireAuth, async (req, res) => {
  const { query } = req.query;
  try {
    if (!NOTION_ACCESS_TOKEN || !ENG_BOOKS_ID) { throw new Error('Server config error for Eng Books.'); }
    const data = await fetchNotion(`https://api.notion.com/v1/databases/${ENG_BOOKS_ID}/query`, {
      method: 'POST',
      // [확인] 'Title' 속성은 'title' 타입이 맞습니다. (findPageIdByTitle 근거)
      body: JSON.stringify({ filter: { property: 'Title', title: { contains: query } }, page_size: 10 })
    });
    const books = data.results.map(page => { 
      const props = page.properties; 
      return { 
        id: page.id, 
        title: props.Title?.title?.[0]?.plain_text, // 'title'에서 읽기
        author: props.Author?.rich_text?.[0]?.plain_text, 
        level: props.Level?.select?.name 
      }; 
    });
    res.json(books);
  } catch (error) { console.error('English book search API error:', error); res.status(500).json([]); }
});

app.get('/api/search-sayu-books', requireAuth, async (req, res) => {
  const { query } = req.query;
  try {
    if (!NOTION_ACCESS_TOKEN || !KOR_BOOKS_ID) { throw new Error('Server config error for Kor Books.'); }
    const data = await fetchNotion(`https://api.notion.com/v1/databases/${KOR_BOOKS_ID}/query`, {
      method: 'POST',
      // [수정] '책제목' 속성의 타입은 'rich_text'가 아닌 'title'입니다.
      body: JSON.stringify({ filter: { property: '책제목', title: { contains: query } }, page_size: 10 })
    });
    const books = data.results.map(page => { 
      const props = page.properties; 
      return { 
        id: page.id, 
        // [수정] 'rich_text'가 아닌 'title' 속성에서 값을 읽어옵니다.
        title: props.책제목?.title?.[0]?.plain_text, 
        author: props.지은이?.rich_text?.[0]?.plain_text, 
        publisher: props.출판사?.rich_text?.[0]?.plain_text 
      }; 
    });
    res.json(books);
  } catch (error) { console.error('Korean book search API error:', error); res.status(500).json([]); }
});

// =======================================================================
// [ / !!!!! 문제의 API !!!!! ]
// =======================================================================


// [수정] 학생 플래너 저장 (Find or Create -> Find and Update)
app.post('/save-progress', requireAuth, async (req, res) => {
  const formData = req.body;
  const studentName = req.user.name;
  const { dateString } = getKSTDayRange(); // KST 기준 오늘 날짜

  try {
    if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) { throw new Error('Server config error.'); }

    // --- 1. 오늘 날짜와 학생 이름으로 기존 기록이 있는지 먼저 검색 ---
    const { start, end } = getKSTDayRange();
    const searchResponse = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: '이름', title: { equals: studentName } },
            { property: '🕐 날짜', date: { on_or_after: start } },
            { property: '🕐 날짜', date: { on_or_before: end } }
          ]
        },
        page_size: 1
      })
    });

    const existingPageId = searchResponse.results[0]?.id || null;

    // --- 2. 폼 데이터 -> 노션 속성 이름으로 매핑 ---
    const properties = {};
    const propertyNameMap = {
      "⭕ 지난 문법 숙제 검사": "⭕ 지난 문법 숙제 검사",
      "1️⃣ 어휘 클카 암기 숙제": "1️⃣ 어휘 클카 암기 숙제",
      "2️⃣ 독해 단어 클카 숙제": "2️⃣ 독해 단어 클카 숙제",
      "4️⃣ Summary 숙제": "4️⃣ Summary 숙제",
      "5️⃣ 매일 독해 숙제": "5️⃣ 매일 독해 숙제",
      "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 영어일기 or 개인 독해서",
      "단어 (맞은 개수)": "단어 (맞은 개수)",
      "단어 (전체 개수)": "단어 (전체 개수)",
      "어휘유닛": "어휘유닛",
      "문법 (전체 개수)": "문법 (전체 개수)",
      "문법 (틀린 개수)": "문법 (틀린 개수)",
      "독해 (틀린 개수)": "독해 (틀린 개수)",
      "독해 하브루타": "독해 하브루타",
      "영어 더빙 학습 완료": "영어 더빙 학습 완료",
      "더빙 워크북 완료": "더빙 워크북 완료",
      "오늘 읽은 영어 책 ID": "오늘 읽은 영어 책", // ID는 relation으로 특별 처리
      "📖 영어독서": "📖 영어독서",
      "어휘학습": "어휘학습",
      "Writing": "Writing",
      "국어 독서 제목": "국어 독서 제목", // relation으로 특별 처리
      "📕 책 읽는 거인": "📕 책 읽는 거인",
      "오늘의 학습 소감": "오늘의 학습 소감"
    };
    
    const numberProps = ["단어 (맞은 개수)", "단어 (전체 개수)", "문법 (전체 개수)", "문법 (틀린 개수)", "독해 (틀린 개수)"];
    const selectProps = ["독해 하브루타", "📖 영어독서", "어휘학습", "Writing", "📕 책 읽는 거인"];
    const textProps = ["어휘유닛", "오늘의 학습 소감"];
    const statusProps = [
      "⭕ 지난 문법 숙제 검사", "1️⃣ 어휘 클카 암기 숙제", "2️⃣ 독해 단어 클카 숙제", 
      "4️⃣ Summary 숙제", "5️⃣ 매일 독해 숙제", "6️⃣ 영어일기 or 개인 독해서",
      "영어 더빙 학습 완료", "더빙 워크북 완료"
    ];

    for (let key in formData) {
      const value = formData[key];
      const notionPropName = propertyNameMap[key] || null; // 매핑된 이름 찾기

      if (!notionPropName || value === null || value === undefined || value === '') {
        // '해당없음' 등 빈 값으로 해석되는 경우 (기존 로직과 약간 다름, 빈 값은 무시)
        if (value === '해당없음' || value === '진행하지 않음' || value === '숙제없음') {
           // (의도적으로) 빈 값으로 남겨두어 업데이트에서 제외하거나,
           // Notion에서 기본값으로 처리하도록 둘 수 있습니다.
           // 여기서는 'null'이 아닌 유효한 기본값으로 처리합니다.
           if (statusProps.includes(notionPropName)) {
             properties[notionPropName] = { status: { name: value } };
           } else if (selectProps.includes(notionPropName)) {
             properties[notionPropName] = { select: { name: value } };
           }
        }
        continue; // 매핑되지 않거나 빈 값은 건너뛰기
      }

      // --- 타입별로 Notion 페이로드 생성 ---
      if (key === '오늘 읽은 영어 책 ID') {
        properties['오늘 읽은 영어 책'] = { relation: [{ id: value }] };
      } 
      else if (key === '국어 독서 제목') {
        // 국어책은 Title로 검색하여 ID를 찾아야 함
        // [확인] findPageIdByTitle이 '책제목'을 'title' 속성으로 올바르게 검색합니다.
        const bookPageId = await findPageIdByTitle(KOR_BOOKS_ID, value, '책제목');
        if (bookPageId) { properties['국어 독서 제목'] = { relation: [{ id: bookPageId }] }; }
      } 
      else if (numberProps.includes(notionPropName)) {
        properties[notionPropName] = { number: Number(value) };
      } 
      else if (selectProps.includes(notionPropName)) {
        properties[notionPropName] = { select: { name: value } };
      } 
      else if (textProps.includes(notionPropName)) {
        properties[notionPropName] = { rich_text: [{ text: { content: value } }] };
      } 
      else if (statusProps.includes(notionPropName)) {
        properties[notionPropName] = { status: { name: value } };
      }
    }

    // --- 3. 기존 페이지 ID 유무에 따라 [생성] 또는 [업데이트] ---
    if (existingPageId) {
      // [업데이트]
      await fetchNotion(`https://api.notion.com/v1/pages/${existingPageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: properties })
      });
      res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 업데이트되었습니다!' });
    } else {
      // [생성]
      // 생성 시에는 '이름'과 '날짜'가 필수입니다.
      properties['이름'] = { title: [{ text: { content: studentName } }] };
      properties['🕐 날짜'] = { date: { start: dateString } };
      
      await fetchNotion('https://api.notion.com/v1/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: PROGRESS_DATABASE_ID },
          properties: properties
        })
      });
      res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 저장되었습니다!' });
    }

  } catch (error) {
    console.error('Error saving student progress:', error);
    res.status(500).json({ success: false, message: '저장 중 서버 오류 발생.' });
  }
});


// =======================================================================
// [신규] 데일리 리포트 동적 생성 API
// =======================================================================

let reportTemplate = '';
try {
  reportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'dailyreport.html'), 'utf-8');
  console.log(' dailyreport.html 템플릿을 성공적으로 불러왔습니다.');
} catch (e) {
  console.error(' dailyreport.html 템플릿 파일을 읽을 수 없습니다.', e);
}

// [신규] 월간 리포트 템플릿 로드
let monthlyReportTemplate = '';
try {
  monthlyReportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'monthlyreport.html'), 'utf-8');
  console.log(' monthlyreport.html 템플릿을 성공적으로 불러왔습니다.');
} catch (e) {
  console.error(' monthlyreport.html 템플릿 파일을 읽을 수 없습니다.', e);
}


function getReportColors(statusOrScore, type) {
  // #5bb3ac (초록), #72aaa6 (회청), #ffde59 (노랑), #ff5757 (빨강)
  const colors = {
    green: '#5bb3ac',
    teal: '#72aaa6',
    yellow: '#ffde59',
    red: '#ff5757',
    gray: '#9ca3af'
  };

  if (type === 'hw_summary') { // 숙제 수행율 (숫자 %)
    const score = parseInt(statusOrScore) || 0;
    if (score >= 90) return colors.green;
    if (score >= 80) return colors.teal;
    if (score >= 70) return colors.yellow;
    return colors.red;
  }
  if (type === 'test_score') { // 문법/어휘 (N/A 또는 숫자 %)
    if (statusOrScore === 'N/A' || statusOrScore === null) return colors.gray; // [수정] null 체크
    const score = parseInt(statusOrScore) || 0;
    if (score >= 80) return colors.green;
    if (score >= 70) return colors.teal;
    if (score >= 50) return colors.yellow;
    return colors.red;
  }
  if (type === 'test_status') { // 독해 (PASS/FAIL/N/A)
    if (statusOrScore === 'PASS') return colors.green;
    if (statusOrScore === 'FAIL') return colors.red;
    return colors.gray; // N/A
  }
  if (type === 'status') { // 리스닝, 독서 (완료/미완료/N/A)
    if (statusOrScore === '완료' || statusOrScore === '완료함') return colors.green;
    if (statusOrScore === '미완료' || statusOrScore === '못함') return colors.red;
    return colors.gray; // N/A, 진행하지 않음 등
  }
  if (type === 'hw_detail') { // 숙제 상세 (숙제 함/안 해옴/해당 없음)
    if (statusOrScore === '숙제 함') return '완료'; // 텍스트 반환
    if (statusOrScore === '안 해옴') return '미완료'; // 텍스트 반환
    return '해당 없음'; // 텍스트 반환
  }
  return colors.gray;
}

function getHwDetailColor(status) {
  if (status === '완료') return '#5bb3ac'; // green
  if (status === '미완료') return '#ff5757'; // red
  return '#9ca3af'; // gray
}


function fillReportTemplate(template, data) {
  const { tests, homework, listening, reading, comment } = data;
 
  // HW 상세 포맷팅
  const hwGrammarStatus = getReportColors(homework.grammar, 'hw_detail');
  const hwVocabStatus = getReportColors(homework.vocabCards, 'hw_detail');
  const hwReadingCardStatus = getReportColors(homework.readingCards, 'hw_detail');
  const hwSummaryStatus = getReportColors(homework.summary, 'hw_detail');
  const hwDiaryStatus = getReportColors(homework.diary, 'hw_detail');

  const replacements = {
    '{{STUDENT_NAME}}': data.studentName,
    '{{REPORT_DATE}}': getKoreanDate(data.date),
    '{{TEACHER_COMMENT}}': comment.teacherComment || '오늘의 코멘트가 없습니다.',
   
    '{{HW_SCORE}}': formatReportValue(data.completionRate, 'percent'),
    '{{HW_SCORE_COLOR}}': getReportColors(data.completionRate, 'hw_summary'),
   
    '{{GRAMMAR_SCORE}}': formatReportValue(tests.grammarScore, 'score'),
    '{{GRAMMAR_SCORE_COLOR}}': getReportColors(tests.grammarScore, 'test_score'),
   
    '{{VOCAB_SCORE}}': formatReportValue(tests.vocabScore, 'score'),
    '{{VOCAB_SCORE_COLOR}}': getReportColors(tests.vocabScore, 'test_score'),
   
    '{{READING_TEST_STATUS}}': formatReportValue(tests.readingResult, 'status'),
    '{{READING_TEST_COLOR}}': getReportColors(tests.readingResult, 'test_status'),
   
    '{{LISTENING_STATUS}}': formatReportValue(listening.study, 'listen_status'),
    '{{LISTENING_COLOR}}': getReportColors(listening.study, 'status'),

    '{{READING_BOOK_STATUS}}': formatReportValue(reading.readingStatus, 'read_status'),
    '{{READING_BOOK_COLOR}}': getReportColors(reading.readingStatus, 'status'),

    '{{GRAMMAR_CLASS_TOPIC}}': comment.grammarTopic || '진도 해당 없음',
    '{{GRAMMAR_HW_DETAIL}}': comment.grammarHomework || '숙제 내용 없음',

    '{{HW_GRAMMAR_STATUS}}': hwGrammarStatus,
    '{{HW_GRAMMAR_COLOR}}': getHwDetailColor(hwGrammarStatus),
    '{{HW_VOCAB_STATUS}}': hwVocabStatus,
    '{{HW_VOCAB_COLOR}}': getHwDetailColor(hwVocabStatus),
    '{{HW_READING_CARD_STATUS}}': hwReadingCardStatus,
    '{{HW_READING_CARD_COLOR}}': getHwDetailColor(hwReadingCardStatus),
    '{{HW_SUMMARY_STATUS}}': hwSummaryStatus,
    '{{HW_SUMMARY_COLOR}}': getHwDetailColor(hwSummaryStatus),
    '{{HW_DIARY_STATUS}}': hwDiaryStatus,
    '{{HW_DIARY_COLOR}}': getHwDetailColor(hwDiaryStatus),

    '{{BOOK_TITLE}}': reading.bookTitle || '읽은 책 없음',
    '{{BOOK_LEVEL}}': (reading.bookAR || reading.bookLexile) ? `${reading.bookAR || 'N/A'} / ${reading.bookLexile || 'N/A'}` : 'N/A',
    '{{WRITING_STATUS}}': reading.writingStatus || 'N/A'
  };

  return template.replace(new RegExp(Object.keys(replacements).join('|'), 'g'), (match) => {
    const value = replacements[match];
    // [수정] 코멘트에서 \n을 <br>로 변경
    if (match === '{{TEACHER_COMMENT}}') {
      return (value || '').replace(/\n/g, '<br>');
    }
    return value !== null && value !== undefined ? value : '';
  });
}

function formatReportValue(value, type) {
  if (value === null || value === undefined) value = 'N/A';

  if (type === 'score' && value !== 'N/A') {
    return `${parseInt(value) || 0}<span class="text-2xl text-gray-500">점</span>`;
  }
  if (type === 'percent' && value !== 'N/A') {
    return `${parseInt(value) || 0}%`;
  }
  if (type === 'listen_status') {
    if (value === '완료') return '완료';
    if (value === '미완료') return '미완료';
    return 'N/A';
  }
  if (type === 'read_status') {
    if (value === '완료함') return '완료';
    if (value === '못함') return '미완료';
    return 'N/A';
  }
  return value; // 'N/A', 'PASS', 'FAIL' 등
}

app.get('/report', async (req, res) => {
  const { pageId, date } = req.query;
 
  if (!pageId || !date) {
    return res.status(400).send('필수 정보(pageId, date)가 누락되었습니다.');
  }
  if (!reportTemplate) {
    return res.status(500).send('서버 오류: 리포트 템플릿을 읽을 수 없습니다.');
  }

  try {
    const pageData = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
    const parsedData = await parseDailyReportData(pageData);
    const finalHtml = fillReportTemplate(reportTemplate, parsedData);
    res.send(finalHtml);
  } catch (error) {
    console.error(`리포트 생성 오류 (PageID: ${pageId}):`, error);
    res.status(500).send(`리포트 생성 중 오류가 발생했습니다: ${error.message}`);
  }
});

// =======================================================================
// [신규] 월간 리포트 동적 생성 API (View)
// =======================================================================
app.get('/monthly-report', async (req, res) => {
  const { studentId, month } = req.query; // (예: studentId=..., month=2025-10)

  if (!studentId || !month) {
    return res.status(400).send('필수 정보(studentId, month)가 누락되었습니다.');
  }
  if (!monthlyReportTemplate) {
    return res.status(500).send('서버 오류: 월간 리포트 템플릿을 읽을 수 없습니다.');
  }
  if (!MONTHLY_REPORT_DB_ID || !PROGRESS_DATABASE_ID || !STUDENT_DATABASE_ID) {
    return res.status(500).send('서버 오류: DB 환경변수가 설정되지 않았습니다.');
  }

  try {
    // --- 1. '월간 리포트 DB'에서 통계 및 AI 요약 조회 ---
    const reportQuery = await fetchNotion(`https://api.notion.com/v1/databases/${MONTHLY_REPORT_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: '학생', relation: { contains: studentId } },
            { property: '리포트 월', rich_text: { equals: month } }
          ]
        },
        page_size: 1
      })
    });

    if (reportQuery.results.length === 0) {
      return res.status(404).send(`[${month}]월 리포트 데이터를 찾을 수 없습니다. (DB 조회 실패)`);
    }

    const reportData = reportQuery.results[0].properties;
    
    // --- 1-B. '학생 명부 DB'에서 학생 이름 조회 (신규 추가) ---
    const studentRelationId = reportData['학생']?.relation?.[0]?.id;
    if (!studentRelationId) {
      const studentNameFromTitle = reportData['이름']?.title?.[0]?.plain_text.split(' - ')[0] || '학생';
      console.warn(`[월간 리포트 렌더링] ${month}월 ${studentId} 리포트에 '학생' 관계형 ID가 없습니다. Title에서 이름을 대신 사용합니다: ${studentNameFromTitle}`);
      
      const statsOnly = {
        hwAvg: reportData['숙제수행율(평균)']?.number || 0,
        vocabAvg: reportData['어휘점수(평균)']?.number || 0,
        grammarAvg: reportData['문법점수(평균)']?.number || 0,
        totalBooks: reportData['총 읽은 권수']?.number || 0,
        aiSummary: reportData['AI 요약']?.rich_text?.[0]?.plain_text || '월간 요약 코멘트가 없습니다.',
        readingPassRate: reportData['독해 통과율(%)']?.number || 0
      };
      return renderMonthlyReportHTML(res, monthlyReportTemplate, studentNameFromTitle, month, statsOnly, [], 0);
    }
   
    const studentPage = await fetchNotion(`https://api.notion.com/v1/pages/${studentRelationId}`);
    const studentName = studentPage.properties['이름']?.title?.[0]?.plain_text || '학생';
   
    const stats = {
      hwAvg: reportData['숙제수행율(평균)']?.number || 0,
      vocabAvg: reportData['어휘점수(평균)']?.number || 0,
      grammarAvg: reportData['문법점수(평균)']?.number || 0,
      totalBooks: reportData['총 읽은 권수']?.number || 0,
      aiSummary: reportData['AI 요약']?.rich_text?.[0]?.plain_text || '월간 요약 코멘트가 없습니다.',
      readingPassRate: reportData['독해 통과율(%)']?.number || 0
    };

    // --- 2. '진도 관리 DB'에서 출석일수, 독서 목록 (상세) 조회 ---
    const [year, monthNum] = month.split('-').map(Number);
    const firstDay = new Date(year, monthNum - 1, 1).toISOString().split('T')[0];
    const lastDay = new Date(year, monthNum, 0).toISOString().split('T')[0];

    const progressQuery = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: '이름', title: { equals: studentName } },
            { property: '🕐 날짜', date: { on_or_after: firstDay } },
            { property: '🕐 날짜', date: { on_or_before: lastDay } }
          ]
        },
        page_size: 100
      })
    });

    // [수정] 데일리 파서를 사용하여 독서 목록 등을 가져옴
    const monthPages = await Promise.all(progressQuery.results.map(parseDailyReportData));
    const attendanceDays = monthPages.length; // 출석일수

    // --- 3. 템플릿에 데이터 주입 (별도 함수로 분리) ---
    renderMonthlyReportHTML(res, monthlyReportTemplate, studentName, month, stats, monthPages, attendanceDays);

  } catch (error) {
    console.error(`월간 리포트 렌더링 오류 (studentId: ${studentId}, month: ${month}):`, error);
    res.status(500).send(`월간 리포트 렌더링 중 오류가 발생했습니다: ${error.message}`);
  }
});

// [신규] 월간 리포트 HTML 렌더링 헬퍼 함수
function renderMonthlyReportHTML(res, template, studentName, month, stats, monthPages, attendanceDays) {
  const [year, monthNum] = month.split('-').map(Number);
  const firstDay = new Date(year, monthNum - 1, 1).toISOString().split('T')[0];
  const lastDay = new Date(year, monthNum, 0).toISOString().split('T')[0];
  const totalDaysInMonth = new Date(year, monthNum, 0).getDate();

  // 독서 목록 (중복 제거)
  const bookSet = new Set();
  const bookListHtml = monthPages
    .map(p => p.reading) // [수정] monthPages는 이미 parseDailyReportData를 거쳤음
    .filter(r => r.bookTitle && r.bookTitle !== '읽은 책 없음')
    .map(r => {
      const series = r.bookSeries || '';
      const ar = r.bookAR || 'N/A';
      const lexile = r.bookLexile || 'N/A';
      const title = r.bookTitle;
      const bookKey = `${series}|${title}|${ar}|${lexile}`;
      return { key: bookKey, series, title, ar, lexile };
    })
    .filter(book => {
      if (bookSet.has(book.key)) return false;
      bookSet.add(book.key);
      return true;
    })
    .map(book => {
      const seriesText = book.series ? `[${book.series}] ` : '';
      return `<li>${seriesText}${book.title} (AR ${book.ar} / Lexile ${book.lexile})</li>`;
    })
    .join('\n') || '<li class="text-gray-500 font-normal">이번 달에 읽은 원서가 없습니다.</li>';

  // RT-Check Point (숙제 점수) 및 경고/칭찬 메시지
  const hwScore = Math.round(stats.hwAvg);
  const rtNotice = {};
  if (hwScore < 70) {
    rtNotice.bgColor = 'bg-red-50';
    rtNotice.borderColor = 'border-red-400';
    rtNotice.titleColor = 'text-red-900';
    rtNotice.textColor = 'text-red-800';
    rtNotice.title = ' RT-Check Point 경고';
  } else {
    rtNotice.bgColor = 'bg-green-50';
    rtNotice.borderColor = 'border-green-400';
    rtNotice.titleColor = 'text-green-900';
    rtNotice.textColor = 'text-green-800';
    rtNotice.title = ' RT-Check Point 칭찬';
  }

  // 테스트 점수 색상
  const vocabScoreColor = (stats.vocabAvg < 80) ? 'text-red-600' : 'text-teal-600';
  const grammarScoreColor = (stats.grammarAvg < 80) ? 'text-red-600' : 'text-teal-600';
  const readingPassRateColor = (stats.readingPassRate < 80) ? 'text-red-600' : 'text-teal-600';

  const replacements = {
    '{{STUDENT_NAME}}': studentName,
    '{{REPORT_MONTH}}': `${year}년 ${monthNum}월`,
    '{{START_DATE}}': firstDay,
    '{{END_DATE}}': lastDay,
   
    // RT-Check Point (숙제)
    '{{HW_AVG_SCORE}}': hwScore,
    '{{HW_SCORE_COLOR}}': (hwScore < 70) ? 'text-red-600' : 'text-teal-600',
    '{{RT_NOTICE_BG_COLOR}}': rtNotice.bgColor,
    '{{RT_NOTICE_BORDER_COLOR}}': rtNotice.borderColor,
    '{{RT_NOTICE_TITLE_COLOR}}': rtNotice.titleColor,
    '{{RT_NOTICE_TEXT_COLOR}}': rtNotice.textColor,
    '{{RT_NOTICE_TITLE}}': rtNotice.title,
   
    // AI 요약
    '{{AI_SUMMARY}}': (stats.aiSummary || '').replace(/\n/g, '<br>'), // [수정] \n -> <br>
   
    // 월간 통계
    '{{ATTENDANCE_DAYS}}': attendanceDays,
    '{{TOTAL_DAYS_IN_MONTH}}': totalDaysInMonth,
    '{{VOCAB_AVG_SCORE}}': Math.round(stats.vocabAvg),
    '{{VOCAB_SCORE_COLOR}}': vocabScoreColor,
    '{{GRAMMAR_AVG_SCORE}}': Math.round(stats.grammarAvg),
    '{{GRAMMAR_SCORE_COLOR}}': grammarScoreColor,
    '{{READING_PASS_RATE}}': Math.round(stats.readingPassRate),
    '{{READING_PASS_RATE_COLOR}}': readingPassRateColor,
    '{{TOTAL_BOOKS_READ}}': stats.totalBooks,
   
    // 독서 목록
    '{{BOOK_LIST_HTML}}': bookListHtml,
  };

  let html = template.replace(new RegExp(Object.keys(replacements).join('|'), 'g'), (match) => {
    return replacements[match];
  });

  res.send(html);
}


// --- [신규] API 라우트: 월간 리포트 URL 조회 ---
app.get('/api/monthly-report-url', requireAuth, async (req, res) => {
  const { studentName, date } = req.query; // (예: 2025-11-02)

  if (!studentName || !date) {
    return res.status(400).json({ message: '학생 이름과 날짜가 필요합니다.' });
  }
  if (!MONTHLY_REPORT_DB_ID) {
    return res.status(500).json({ message: '월간 리포트 DB가 설정되지 않았습니다.' });
  }

  try {
    const requestedDate = new Date(date);
    const lastMonth = new Date(requestedDate.getFullYear(), requestedDate.getMonth() - 1, 1);
    const lastMonthString = `${lastMonth.getFullYear()}-${(lastMonth.getMonth() + 1).toString().padStart(2, '0')}`; // "2025-10"

    const data = await fetchNotion(`https://api.notion.com/v1/databases/${MONTHLY_REPORT_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: '이름', title: { contains: studentName } },
            { property: '리포트 월', rich_text: { equals: lastMonthString } }
          ]
        },
        page_size: 1
      })
    });

    const reportPage = data.results[0];
    if (reportPage) {
      const reportUrl = reportPage.properties['월간리포트URL']?.url;
      if (reportUrl) {
        res.json({ success: true, url: reportUrl });
      } else {
        res.status(404).json({ success: false, message: '리포트를 찾았으나 URL이 없습니다.' });
      }
    } else {
      res.status(404).json({ success: false, message: `[${lastMonthString}]월 리포트를 찾을 수 없습니다.` });
    }
  } catch (error) {
    console.error(`월간 리포트 URL 조회 오류 (${studentName}, ${date}):`, error);
    res.status(500).json({ message: error.message || '서버 오류' });
  }
});

// --- [신규] 10월 리포트 수동 생성용 임시 API ---
app.get('/api/manual-monthly-report-gen', async (req, res) => {
  console.log('---  [수동 월간 리포트] 생성 요청 받음 ---');
 
  const targetStudentName = "유환호";
  console.log(`[수동 월간 리포트] 타겟 학생 고정: ${targetStudentName}`);
 
  const { dateString } = getKSTDayRange(); // KST 기준 '오늘'
  const today = new Date(dateString);
  const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1); // 지난 달 1일
 
  const currentYear = lastMonthDate.getFullYear();
  const currentMonth = lastMonthDate.getMonth();
  const monthString = `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}`;
 
  console.log(`[수동 월간 리포트] ${monthString}월 리포트 생성을 시작합니다.`);

  if (!NOTION_ACCESS_TOKEN || !STUDENT_DATABASE_ID || !PROGRESS_DATABASE_ID || !MONTHLY_REPORT_DB_ID || !geminiModel) {
    console.error('[수동 월간 리포트] DB ID 또는 Gemini AI가 설정되지 않아 스케줄을 중단합니다.');
    return res.status(500).json({ success: false, message: '서버 환경변수(DB, AI)가 설정되지 않았습니다.' });
  }

  try {
    const studentQueryFilter = {
      property: '이름',
      title: { equals: targetStudentName }
    };

    const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({ filter: studentQueryFilter })
    });

    const students = studentData.results;
    console.log(`[수동 월간 리포트] 총 ${students.length}명의 학생을 대상으로 통계를 시작합니다.`);
   
    const firstDayOfMonth = new Date(currentYear, currentMonth, 1).toISOString().split('T')[0];
    const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).toISOString().split('T')[0];
   
    let successCount = 0;
    let failCount = 0;

    for (const student of students) {
      const studentPageId = student.id;
      const studentName = student.properties['이름']?.title?.[0]?.plain_text;
      if (!studentName) continue;

      try {
        console.log(`[수동 월간 리포트] ${studentName} 학생 통계 계산 중...`);

        const progressData = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
          method: 'POST',
          body: JSON.stringify({
            filter: {
              and: [
                { property: '이름', title: { equals: studentName } },
                { property: '🕐 날짜', date: { on_or_after: firstDayOfMonth } },
                { property: '🕐 날짜', date: { on_or_before: lastDayOfMonth } }
              ]
            }
          })
        });
       
        // [수정] 월간 통계용 파서 사용
        const monthPages = progressData.results.map(parseMonthlyStatsData);
       
        if (monthPages.length === 0) {
          console.log(`[수동 월간 리포트] ${studentName} 학생은 ${monthString}월 데이터가 없습니다. (스킵)`);
          continue;
        }

        // --- 통계 계산 (헤더님 최종 로직) ---
        // 1. 숙제 (0점 포함)
        const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
        // 2. 어휘 (0점 제외)
        const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== null);
        // 3. 문법 (0점 제외)
        const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== null);
        // 4. 독해 통과율
        const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');
        // 5. 독서
        const bookTitles = [...new Set(monthPages.map(p => p.bookTitle).filter(t => t && t !== '읽은 책 없음'))];
        // 6. 코멘트
        const comments = monthPages.map((p) => p.date ? `[${p.date}] ${p.teacherComment}` : p.teacherComment).filter(Boolean).join('\n');

        const stats = {
          hwAvg: hwRates.length > 0 ? Math.round(hwRates.reduce((a, b) => a + b, 0) / hwRates.length) : 0,
          vocabAvg: vocabScores.length > 0 ? Math.round(vocabScores.reduce((a, b) => a + b, 0) / vocabScores.length) : 0,
          grammarAvg: grammarScores.length > 0 ? Math.round(grammarScores.reduce((a, b) => a + b, 0) / grammarScores.length) : 0,
          readingPassRate: readingResults.length > 0 ? Math.round(readingResults.filter(r => r === 'PASS').length / readingResults.length * 100) : 0,
          totalBooks: bookTitles.length,
          bookList: bookTitles.join(', ') || '읽은 책 없음'
        };
       
        let aiSummary = 'AI 요약 기능을 사용할 수 없습니다.';
        if (geminiModel) {
          try {
            let shortName = studentName;
            if (studentName.startsWith('Test ')) {
              shortName = studentName.substring(5);
           _ } else if (studentName.length === 3 && !studentName.includes(' ')) {
              // [수정] 조사(이가) 오류 수정
              const lastChar = shortName.charCodeAt(shortName.length - 1);
              const hasBatchim = (lastChar - 0xAC00) % 28 > 0;
              shortName = studentName.substring(1); // "환호"
              // (이름이 2글자이거나 4글자 이상이면 full-name 사용) - 이 로직은 프롬프트에서 처리
            }

            // [수정] AI 프롬프트 (최신 가이드라인)
            const prompt = `
너는 '리디튜드' 학원의 선생님이야. 지금부터 너는 학생의 학부모님께 보낼 월간 리포트 총평을 "직접" 작성해야 해.

**[AI의 역할 및 톤]**
1. **가장 중요:** 너는 선생님 본인이기 때문에, **"안녕하세요, OOO 컨설턴트입니다" 혹은 "xxx쌤 입니다"라고 너 자신을 소개하는 문장을 절대로 쓰지 마.**
2. 마치 선생님이 학부모님께 카톡을 보내는 것처럼, "안녕하세요. ${shortName}의 ${currentMonth + 1}월 리포트 보내드립니다."처럼 자연스럽고 친근하게 첫인사를 시작해 줘.
3. 전체적인 톤은 **따뜻하고, 친근하며, 학생을 격려**해야 하지만, 동시에 데이터에 기반한 **전문가의 통찰력**이 느껴져야 해.
4. \`~입니다.\`와 \`~요.\`를 적절히 섞어서 부드럽지만 격식 있는 어투를 사용해 줘.
5. **가장 중요:** 학생을 지칭할 때 '${studentName} 학생' 대신 '${shortName}이는', '${shortName}이가'처럼 '${shortName}'(짧은이름)을 자연스럽게 불러주세요.
6. 한국어 이름을 쓸 때 뒤의 조사를 꼭 이름의 발음과 어울리는 것으로 올바르게 사용해 주세요. (EX: 환호이가(X) 환호가(O))

**[내용 작성 지침]**
1. **[데이터]** 아래 제공되는 [월간 통계]와 [일일 코멘트]를 **절대로 나열하지 말고,** 자연스럽게 문장 속에 녹여내 줘.
2. **[정량 평가]** "숙제 수행율 6%"처럼 부정적인 수치도 숨기지 말고 **정확히 언급**하되, "시급합니다" 같은 차가운 표현 대신 "다음 달엔 이 부분을 꼭 함께 챙겨보고 싶어요"처럼 **따뜻한 권유형**으로 표현해 줘.
3. **[정성 평가]** 월간 통계 부분에서 긍정적인 부분이 있다면, **그것을 먼저 칭찬**하면서 코멘트를 시작해 줘. (예: "이번 달에 ${shortName}이가 'Dora's Mystery' 원서를 1권 완독했네요! 정말 기특합니다.")
4. **[개선점]** 가장 아쉬웠던 점(예: 숙제 6%)을 명확히 짚어주고, "매일 꾸준히 숙제하는 습관", "어휘는 클래스 카드를 매일 5분 보기 처럼 짬짬히 해라", "문법 점수가 낮은 건 문법은 학원와서 3분 복습 처럼 개념을 빠르게 복습하도록 하겠다." 처럼 **구체적이고 쉬운 개선안**을 제시해 줘.
5. **[마무리]** 마지막은 항상 다음 달을 응원하는 격려의 메시지나, 학부모님께 드리는 감사 인사(예: "한 달간 리디튜드를 믿고 맡겨주셔서 감사합니다.")로 따뜻하게 마무리해 줘.
6. **[강조 금지]** 절대로 마크다운(\`**\` or \`*\`)을 사용하여 텍스트를 강조하지 마세요.

[월간 통계]
- 숙제 수행율(평균): ${stats.hwAvg}%
- 어휘 점수(평균): ${stats.vocabAvg}점
- 문법 점수(평균): ${stats.grammarAvg}점
- 읽은 책: ${stats.totalBooks}권 (${stats.bookList})
- 독해 통과율: ${stats.readingPassRate}%

[일일 코멘트 모음]
${comments}
`;
            const result = await geminiModel.generateContent(prompt);
            const response = await result.response;
            aiSummary = response.text();
          } catch (aiError) {
            console.error(`[수동 월간 리포트] ${studentName} 학생 AI 요약 실패:`, aiError);
            aiSummary = 'AI 요약 중 오류가 발생했습니다.';
          }
        }
       
        const reportTitle = `${studentName} - ${monthString} 월간 리포트`;
        const reportUrl = `${DOMAIN_URL}/monthly-report?studentId=${studentPageId}&month=${monthString}`;

        const existingReport = await fetchNotion(`https://api.notion.com/v1/databases/${MONTHLY_REPORT_DB_ID}/query`, {
          method: 'POST',
          body: JSON.stringify({
            filter: {
              and: [
                { property: '학생', relation: { contains: studentPageId } },
                { property: '리포트 월', rich_text: { equals: monthString } }
              ]
            },
            page_size: 1
          })
        });
       
        if (existingReport.results.length > 0) {
          const existingPageId = existingReport.results[0].id;
          await fetchNotion(`https://api.notion.com/v1/pages/${existingPageId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              properties: {
                '월간리포트URL': { url: reportUrl },
                '숙제수행율(평균)': { number: stats.hwAvg },
                '어휘점수(평균)': { number: stats.vocabAvg },
                '문법점수(평균)': { number: stats.grammarAvg },
                '총 읽은 권수': { number: stats.totalBooks },
                '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                '독해 통과율(%)': { number: stats.readingPassRate }
              }
            })
          });
          console.log(`[수동 월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '업데이트' 성공!`);
        } else {
          await fetchNotion('https://api.notion.com/v1/pages', {
            method: 'POST',
            body: JSON.stringify({
              parent: { database_id: MONTHLY_REPORT_DB_ID },
              properties: {
                '이름': { title: [{ text: { content: reportTitle } }] },
                '학생': { relation: [{ id: studentPageId }] },
                '리포트 월': { rich_text: [{ text: { content: monthString } }] },
                '월간리포트URL': { url: reportUrl },
                '숙제수행율(평균)': { number: stats.hwAvg },
                '어휘점수(평균)': { number: stats.vocabAvg },
                '문법점수(평균)': { number: stats.grammarAvg },
                '총 읽은 권수': { number: stats.totalBooks },
                '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
s              'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                '독해 통과율(%)': { number: stats.readingPassRate }
              }
            })
          });
          console.log(`[수동 월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '새로 저장' 성공!`);
        }
        successCount++;
      } catch (studentError) {
        console.error(`[수동 월간 리포트] ${studentName} 학생 처리 중 오류 발생:`, studentError.message);
        failCount++;
      }
    }
   
    console.log('---  [수동 월간 리포트] 자동화 스케줄 완료 ---');
    res.json({ success: true, message: `${monthString}월 리포트 생성을 성공적으로 완료했습니다. (성공: ${successCount}건, 실패: ${failCount}건)` });

  } catch (error) {
    console.error('---  [수동 월간 리포트] 자동화 스케줄 중 오류 발생 ---', error);
    res.status(500).json({ success: false, message: `리포트 생성 오류 발생: ${error.message}` });
  }
});


// =======================================================================
// [신규] 자동화 스케줄링 (Cron Jobs)
// =======================================================================

// --- [신규] 1. 데일리 리포트 URL 자동 생성 (매일 밤 10시) ---
cron.schedule('0 22 * * *', async () => {
  console.log('---  [데일리 리포트] 자동화 스케줄 실행 (매일 밤 10시) ---');
 
  if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) {
    console.error('[데일리 리포트] DB ID가 설정되지 않아 스케줄을 중단합니다.');
    return;
  }

  try {
    const { start, end, dateString } = getKSTDayRange(); // KST 기준 '오늘'
   
    const filter = {
      and: [
        { property: '🕐 날짜', date: { on_or_after: start } },
        { property: '🕐 날짜', date: { on_or_before: end } }
      ]
    };
   
    const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({ filter: filter })
    });
   
    const pages = data.results;
    if (!pages || pages.length === 0) {
      console.log(`[데일리 리포트] ${dateString} 날짜에 해당하는 진도 페이지가 없습니다.`);
      return;
    }

    console.log(`[데일리 리포트] 총 ${pages.length}개의 오늘 진도 페이지를 찾았습니다.`);

    for (const page of pages) {
      try {
        const pageId = page.id;
        const reportUrl = `${DOMAIN_URL}/report?pageId=${pageId}&date=${dateString}`;

        const currentUrl = page.properties['데일리리포트URL']?.url;
        if (currentUrl === reportUrl) {
          console.log(`[데일리 리포트] ${pageId} - 이미 URL이 존재합니다. (스킵)`);
          continue;
        }

        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: {
              '데일리리포트URL': { url: reportUrl }
           }
          })
        });
        console.log(`[데일리 리포트] ${pageId} - URL 저장 성공: ${reportUrl}`);
      } catch (pageError) {
        console.error(`[데일리 리포트] ${page.id} 업데이트 실패:`, pageError.message);
      }
    }
    console.log('---  [데일리 리포트] 자동화 스케줄 완료 ---');

  } catch (error) {
    console.error('---  [데일리 리포트] 자동화 스케줄 중 오류 발생 ---', error);
  }
}, {
  timezone: "Asia/Seoul"
});


// --- [신규] 2. 월간 리포트 URL 자동 생성 (매달 마지막 주 금요일 밤 9시) ---
cron.schedule('0 21 * * 5', async () => {
  console.log('---  [월간 리포트] 자동화 스케줄 실행 (매주 금요일 밤 9시) ---');
 
  const { dateString } = getKSTDayRange(); // KST 기준 '오늘'
  const today = new Date(dateString);
 
  const nextFriday = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (today.getMonth() === nextFriday.getMonth()) {
    console.log(`[월간 리포트] 오늘은 마지막 주 금요일이 아닙니다. (스킵)`);
    return;
  }
 
  console.log(' [월간 리포트] 오늘은 마지막 주 금요일입니다! 리포트 생성을 시작합니다.');

  if (!NOTION_ACCESS_TOKEN || !STUDENT_DATABASE_ID || !PROGRESS_DATABASE_ID || !MONTHLY_REPORT_DB_ID || !geminiModel) {
    console.error('[월간 리포트] DB ID 또는 Gemini AI가 설정되지 않아 스케줄을 중단합니다.');
    return;
  }

  try {
    const studentData = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
      method: 'POST'
    });
    const students = studentData.results;
    console.log(`[월간 리포트] 총 ${students.length}명의 학생을 대상으로 통계를 시작합니다.`);
   
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    const monthString = `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}`;
    const firstDayOfMonth = new Date(currentYear, currentMonth, 1).toISOString().split('T')[0];
    const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).toISOString().split('T')[0];

    for (const student of students) {
      const studentPageId = student.id;
      const studentName = student.properties['이름']?.title?.[0]?.plain_text;
      if (!studentName) continue;

      try {
        console.log(`[월간 리포트] ${studentName} 학생 통계 계산 중...`);
        const progressData = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
          method: 'POST',
          body: JSON.stringify({
            filter: {
              and: [
                { property: '이름', title: { equals: studentName } },
                { property: '🕐 날짜', date: { on_or_after: firstDayOfMonth } },
                { property: '🕐 날짜', date: { on_or_before: lastDayOfMonth } }
              ]
            }
          })
        });
       
        // [수정] 월간 통계용 파서 사용
        const monthPages = progressData.results.map(parseMonthlyStatsData);
       
        if (monthPages.length === 0) {
          console.log(`[월간 리포트] ${studentName} 학생은 ${monthString}월 데이터가 없습니다. (스킵)`);
          continue;
        }

        // --- 통계 계산 (헤더님 최종 로직) ---
        // 1. 숙제 (0점 포함)
        const hwRates = monthPages.map(p => p.completionRate).filter(r => r !== null);
        // 2. 어휘 (0점 제외)
        const vocabScores = monthPages.map(p => p.vocabScore).filter(s => s !== null);
        // 3. 문법 (0점 제외)
        const grammarScores = monthPages.map(p => p.grammarScore).filter(s => s !== null);
        // 4. 독해 통과율
        const readingResults = monthPages.map(p => p.readingResult).filter(r => r === 'PASS' || r === 'FAIL');
        // 5. 독서
        const bookTitles = [...new Set(monthPages.map(p => p.bookTitle).filter(t => t && t !== '읽은 책 없음'))];
        // 6. 코멘트
        const comments = monthPages.map((p) => p.date ? `[${p.date}] ${p.teacherComment}` : p.teacherComment).filter(Boolean).join('\n');

        const stats = {
          hwAvg: hwRates.length > 0 ? Math.round(hwRates.reduce((a, b) => a + b, 0) / hwRates.length) : 0,
          vocabAvg: vocabScores.length > 0 ? Math.round(vocabScores.reduce((a, b) => a + b, 0) / vocabScores.length) : 0,
          grammarAvg: grammarScores.length > 0 ? Math.round(grammarScores.reduce((a, b) => a + b, 0) / grammarScores.length) : 0,
          readingPassRate: readingResults.length > 0 ? Math.round(readingResults.filter(r => r === 'PASS').length / readingResults.length * 100) : 0,
          totalBooks: bookTitles.length,
          bookList: bookTitles.join(', ') || '읽은 책 없음'
        };

        // Gemini AI로 코멘트 요약
        let aiSummary = 'AI 요약 기능을 사용할 수 없습니다.';
        if (geminiModel) {
          try {
            let shortName = studentName;
            if (studentName.startsWith('Test ')) {
              shortName = studentName.substring(5);
  _         } else if (studentName.length === 3 && !studentName.includes(' ')) {
              shortName = studentName.substring(1); // "유환호" -> "환호"
            }

            // [수정] AI 프롬프트 (최신 가이드라인)
            const prompt = `
너는 '리디튜드' 학원의 선생님이야. 지금부터 너는 학생의 학부모님께 보낼 월간 리포트 총평을 "직접" 작성해야 해.

**[AI의 역할 및 톤]**
1. **가장 중요:** 너는 선생님 본인이기 때문에, **"안녕하세요, OOO 컨설턴트입니다" 혹은 "xxx쌤 입니다"라고 너 자신을 소개하는 문장을 절대로 쓰지 마.**
2. 마치 선생님이 학부모님께 카톡을 보내는 것처럼, "안녕하세요. ${shortName}의 ${currentMonth + 1}월 리포트 보내드립니다."처럼 자연스럽고 친근하게 첫인사를 시작해 줘.
3. 전체적인 톤은 **따뜻하고, 친근하며, 학생을 격려**해야 하지만, 동시에 데이터에 기반한 **전문가의 통찰력**이 느껴져야 해.
4. \`~입니다.\`와 \`~요.\`를 적절히 섞어서 부드럽지만 격식 있는 어투를 사용해 줘.
5. **가장 중요:** 학생을 지칭할 때 '${studentName} 학생' 대신 '${shortName}이는', '${shortName}이가'처럼 '${shortName}'(짧은이름)을 자연스럽게 불러주세요.
6. 한국어 이름을 쓸 때 뒤의 조사를 꼭 이름의 발음과 어울리는 것으로 올바르게 사용해 주세요. (EX: 환호이가(X) 환호가(O))

**[내용 작성 지침]**
1. **[데이터]** 아래 제공되는 [월간 통계]와 [일일 코멘트]를 **절대로 나열하지 말고,** 자연스럽게 문장 속에 녹여내 줘.
2. **[정량 평가]** "숙제 수행율 6%"처럼 부정적인 수치도 숨기지 말고 **정확히 언급**하되, "시급합니다" 같은 차가운 표현 대신 "다음 달엔 이 부분을 꼭 함께 챙겨보고 싶어요"처럼 **따뜻한 권유형**으로 표현해 줘.
3. **[정성 평가]** 월간 통계 부분에서 긍정적인 부분이 있다면, **그것을 먼저 칭찬**하면서 코멘트를 시작해 줘. (예: "이번 달에 ${shortName}이가 'Dora's Mystery' 원서를 1권 완독했네요! 정말 기특합니다.")
4. **[개선점]** 가장 아쉬웠던 점(예: 숙제 6%)을 명확히 짚어주고, "매일 꾸준히 숙제하는 습관", "어휘는 클래스 카드를 매일 5분 보기 처럼 짬짬히 해라", "문법 점수가 낮은 건 문법은 학원와서 3분 복습 처럼 개념을 빠르게 복습하도록 하겠다." 처럼 **구체적이고 쉬운 개선안**을 제시해 줘.
5. **[마무리]** 마지막은 항상 다음 달을 응원하는 격려의 메시지나, 학부모님께 드리는 감사 인사(예: "한 달간 리디튜드를 믿고 맡겨주셔서 감사합니다.")로 따뜻하게 마무리해 줘.
6. **[강조 금지]** 절대로 마크다운(\`**\` or \`*\`)을 사용하여 텍스트를 강조하지 마세요.

[월간 통계]
- 숙제 수행율(평균): ${stats.hwAvg}%
- 어휘 점수(평균): ${stats.vocabAvg}점
- 문법 점수(평균): ${stats.grammarAvg}점
- 읽은 책: ${stats.totalBooks}권 (${stats.bookList})
- 독해 통과율: ${stats.readingPassRate}%

[일일 코멘트 모음]
${comments}
`;
            const result = await geminiModel.generateContent(prompt);
            const response = await result.response;
            aiSummary = response.text();
            console.log(`[월간 리포트] ${studentName} 학생 AI 요약 성공!`);
          } catch (aiError) {
            console.error(`[월간 리포트] ${studentName} 학생 AI 요약 실패:`, aiError);
            aiSummary = 'AI 요약 중 오류가 발생했습니다.';
          }
        }

        // '월간 리포트 DB'에 새 페이지로 저장
        const reportTitle = `${studentName} - ${monthString} 월간 리포트`;
        const reportUrl = `${DOMAIN_URL}/monthly-report?studentId=${studentPageId}&month=${monthString}`;

        const existingReport = await fetchNotion(`https://api.notion.com/v1/databases/${MONTHLY_REPORT_DB_ID}/query`, {
          method: 'POST',
          body: JSON.stringify({
            filter: {
              and: [
                { property: '학생', relation: { contains: studentPageId } },
                { property: '리포트 월', rich_text: { equals: monthString } }
              ]
            },
            page_size: 1
          })
        });

        if (existingReport.results.length > 0) {
          const existingPageId = existingReport.results[0].id;
          await fetchNotion(`https://api.notion.com/v1/pages/${existingPageId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              properties: {
                '월간리포트URL': { url: reportUrl },
                '숙제수행율(평균)': { number: stats.hwAvg },
                '어휘점수(평균)': { number: stats.vocabAvg },
                '문법점수(평균)': { number: stats.grammarAvg },
                '총 읽은 권수': { number: stats.totalBooks },
                '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                '독해 통과율(%)': { number: stats.readingPassRate }
              }
            })
          });
          console.log(`[월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '업데이트' 성공!`);
        } else {
          await fetchNotion('https://api.notion.com/v1/pages', {
            method: 'POST',
            body: JSON.stringify({
              parent: { database_id: MONTHLY_REPORT_DB_ID },
              properties: {
                '이름': { title: [{ text: { content: reportTitle } }] },
                '학생': { relation: [{ id: studentPageId }] },
                '리포트 월': { rich_text: [{ text: { content: monthString } }] },
                '월간리포트URL': { url: reportUrl },
                '숙제수행율(평균)': { number: stats.hwAvg },
s               '어휘점수(평균)': { number: stats.vocabAvg },
                '문법점수(평균)': { number: stats.grammarAvg },
                '총 읽은 권수': { number: stats.totalBooks },
                '읽은 책 목록': { rich_text: [{ text: { content: stats.bookList } }] },
                'AI 요약': { rich_text: [{ text: { content: aiSummary } }] },
                '독해 통과율(%)': { number: stats.readingPassRate }
              }
            })
          });
          console.log(`[월간 리포트] ${studentName} 학생의 ${monthString}월 리포트 DB '새로 저장' 성공!`);
        }
      } catch (studentError) {
        console.error(`[월간 리포트] ${studentName} 학생 처리 중 오류 발생:`, studentError.message);
      }
    }

    console.log('---  [월간 리포트] 자동화 스케줄 완료 ---');

  } catch (error) {
    console.error('---  [월간 리포트] 자동화 스케줄 중 오류 발생 ---', error);
  }
}, {
  timezone: "Asia/Seoul"
});

// --- 서버 실행 ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`최종 서버가 ${PORT} 포트에서 실행 중입니다.`);
});