import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

// --- 기본 설정 ---
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-readitude-2025';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 5001;
const userAccounts = {
  'manager': { password: 'rdtd112!@', role: 'manager', name: '매니저' },
  'teacher1': { password: 'rdtd112!@', role: 'teacher', name: '선생님1' },
  'teacher2': { password: 'rdtd112!@', role: 'teacher', name: '선생님2' },
  'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '선생님3' },
  'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '선생님4' },
  'assistant1': { password: 'rdtd112!@', role: 'assistant', name: '아르바이트1' },
  'assistant2': { password: 'rdtd112!@', role: 'assistant', name: '아르바이트2' }
};

// --- Helper Functions ---
function generateToken(userData) { return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; } }
async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
  const accessToken = process.env.NOTION_ACCESS_TOKEN;
  if (!accessToken || !title || !databaseId) return null;
  try {
    const isTitleProp = ['Title', '책제목', '이름'].includes(titlePropertyName);
    const filterBody = {
      property: titlePropertyName,
      [isTitleProp ? 'title' : 'rich_text']: { contains: title }
    };
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: filterBody, page_size: 1 })
    });
    if (!response.ok) { console.error(await response.text()); return null; };
    const data = await response.json();
    return data.results[0]?.id || null;
  } catch (error) {
    console.error(`Error finding page ID for title "${title}":`, error);
    return null;
  }
}

// --- 미들웨어 ---
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

// --- 페이지를 보여주는 라우트 ---
const publicPath = path.join(__dirname, '../public');
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));
// 1. 로그인한 선생님의 정보를 알려주는 API
app.get('/api/teachers', requireAuth, async (req, res) => {
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        const TEACHER_DB_ID = process.env.TEACHER_DB_ID;
        if (!accessToken || !TEACHER_DB_ID) {
            throw new Error('서버에 선생님 DB ID가 설정되지 않았습니다.');
        }

        const response = await fetch(`https://api.notion.com/v1/databases/${TEACHER_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Notion-Version': '2022-06-28'
            },
            body: JSON.stringify({
                filter: {
                    or: [
                        {
                            property: '권한',
                            rich_text: {
                                equals: 'teacher'
                            }
                        },
                        {
                            property: '권한',
                            rich_text: {
                                equals: 'manager'
                            }
                        }
                    ]
                }
            })
        });

        if (!response.ok) {
            console.error('Notion API 응답 오류:', await response.json());
            throw new Error('Notion에서 강사 목록을 가져오는 데 실패했습니다.');
        }

        const data = await response.json();
        
        const teachers = data.results.map(page => {
            const props = page.properties;
            return {
                id: page.id,
                name: props['이름']?.title[0]?.plain_text || '이름 없음'
            };
        });

        res.json(teachers);

    } catch (error) {
        console.error('강사 목록 로드 오류:', error);
        res.status(500).json({ message: '서버에서 강사 목록을 처리하는 중 오류가 발생했습니다.' });
    }
});

// 3. 학생들의 숙제 현황 데이터를 Notion에서 가져오는 API
app.get('/api/homework-status', requireAuth, async (req, res) => {
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
        if (!accessToken || !PROGRESS_DB_ID) {
            throw new Error('서버 환경 변수가 설정되지 않았습니다.');
        }

        const { period, startDate, endDate, teacher } = req.query;
        const filterConditions = [];

        if (period === 'today') {
            const today = new Date().toISOString().split('T')[0];
            filterConditions.push({ property: '🕐 날짜', date: { equals: today } });
        } else if (startDate && endDate) {
            filterConditions.push({
                and: [
                    { property: '🕐 날짜', date: { on_or_after: startDate } },
                    { property: '🕐 날짜', date: { on_or_before: endDate } }
                ]
            });
        }

        if (teacher && teacher !== 'all') {
            filterConditions.push({ property: '담당쌤', relation: { contains: teacher } });
        }

        const response = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({
                filter: filterConditions.length > 0 ? { and: filterConditions } : undefined,
                sorts: [{ property: '🕐 날짜', direction: 'descending' }]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Notion API Error: ${errorData.message}`);
        }

        const data = await response.json();

        const homeworkStatus = data.results.map(page => {
            const props = page.properties;
            const teacherNames = props['담당쌤']?.relation?.map(rel => rel.title).flat() || [];

            return {
                pageId: page.id,
                studentId: props['이름']?.title[0]?.plain_text || '이름 없음',
                date: props['🕐 날짜']?.date?.start || '날짜없음',
                teachers: teacherNames,
                completionRate: props['수행율']?.formula?.number || 0,
                grammarHomework: props['⭕ 지난 문법 숙제 검사']?.status?.name || '숙제 없음',
                vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '숙제 없음',
                readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '숙제 없음',
                summary: props['4️⃣ Summary 숙제']?.status?.name || '숙제 없음',
                readingHomework: props['5️⃣ 매일 독해 숙제']?.status?.name || '숙제 없음',
                diary: props['6️⃣ 영어 일기(초등) / 개인 독해서 (중고등)']?.status?.name || '숙제 없음'
            };
        });
        res.json(homeworkStatus);
    } catch (error) {
        console.error('숙제 현황 로드 오류:', error);
        res.status(500).json({ message: '서버에서 숙제 현황 데이터를 처리하는 중 오류가 발생했습니다.' });
    }
});
// --- API 라우트 ---
app.post('/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  console.log('학생 로그인 시도:', { studentId });
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID;
    if (!accessToken || !STUDENT_DB_ID) { return res.status(500).json({ success: false, message: '서버 설정 오류.' }); }

    const restResponse = await fetch(`https://api.notion.com/v1/databases/${STUDENT_DB_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        filter: { and: [{ property: '학생 ID', rich_text: { equals: studentId } }, { property: '비밀번호', rich_text: { equals: studentPassword.toString() } }] }
      })
    });
    if (!restResponse.ok) throw new Error(`Notion API Error: ${restResponse.status}`);
    
    const response = await restResponse.json();
    if (response.results.length > 0) {
      const studentRecord = response.results[0].properties;
      const realName = studentRecord['이름']?.title?.[0]?.plain_text || studentId;
      const token = generateToken({ userId: studentId, role: 'student', name: realName });
      res.json({ success: true, message: '로그인 성공!', token });
    } else {
      res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) {
    console.error('로그인 오류:', error);
    res.status(500).json({ success: false, message: '로그인 중 오류가 발생했습니다.' });
  }
});
app.post('/teacher-login', async (req, res) => {
    const { teacherId, teacherPassword } = req.body;
    const userAccount = userAccounts[teacherId];
    if (userAccount && teacherPassword === userAccount.password) {
        const token = generateToken({ loginId: teacherId, name: userAccount.name, role: userAccount.role });
        res.json({ success: true, message: '로그인 성공', token });
    } else {
        res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
});
app.get('/api/student-info', requireAuth, (req, res) => {
  if (!req.user || req.user.role !== 'student') { return res.status(401).json({ error: '학생 인증이 필요합니다' }); }
  res.json({ studentId: req.user.userId, studentName: req.user.name, studentRealName: req.user.name });
});
app.get('/api/search-books', async (req, res) => {
  const { query } = req.query;
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const ENG_BOOKS_ID = process.env.ENG_BOOKS_ID;
    if (!accessToken || !ENG_BOOKS_ID) { throw new Error('서버 설정 오류'); }
    const response = await fetch(`https://api.notion.com/v1/databases/${ENG_BOOKS_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: 'Title', title: { contains: query } }, page_size: 10 })
    });
    if (!response.ok) throw new Error(`Notion API Error: ${response.status}`);
    const data = await response.json();
    const books = data.results.map(page => {
      const props = page.properties;
      return { id: page.id, title: props.Title?.title?.[0]?.plain_text, author: props.Author?.rich_text?.[0]?.plain_text, level: props.Level?.select?.name };
    });
    res.json(books);
  } catch (error) {
    console.error('영어책 검색 API 오류:', error);
    res.status(500).json([]);
  }
});
app.get('/api/search-sayu-books', async (req, res) => {
  const { query } = req.query;
  try {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;
    const KOR_BOOKS_ID = process.env.KOR_BOOKS_ID;
    if (!accessToken || !KOR_BOOKS_ID) { throw new Error('서버 설정 오류'); }
    const response = await fetch(`https://api.notion.com/v1/databases/${KOR_BOOKS_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: '책제목', rich_text: { contains: query } }, page_size: 10 })
    });
    if (!response.ok) throw new Error(`Notion API Error: ${response.status}`);
    const data = await response.json();
    const books = data.results.map(page => {
      const props = page.properties;
      return { id: page.id, title: props.책제목?.rich_text?.[0]?.plain_text, author: props.지은이?.rich_text?.[0]?.plain_text, publisher: props.출판사?.rich_text?.[0]?.plain_text };
    });
    res.json(books);
  } catch (error) {
    console.error('국어책 검색 API 오류:', error);
    res.status(500).json([]);
  }
});
app.post('/save-progress', requireAuth, async (req, res) => {
    const formData = req.body;
    const studentName = req.user.name;
    const today = new Date().toISOString().split('T')[0]; // 오늘 날짜 ('YYYY-MM-DD' 형식)

    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
        if (!accessToken || !PROGRESS_DB_ID) { throw new Error('서버 설정 오류'); }

        // --- 1. 오늘 날짜와 학생 이름으로 기존 기록이 있는지 먼저 검색 ---
        const searchResponse = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: '이름', title: { equals: studentName } },
                        { property: '🕐 날짜', date: { equals: today } }
                    ]
                }
            })
        });

        if (!searchResponse.ok) {
            console.error('Notion 검색 API 오류:', await searchResponse.json());
            throw new Error('기존 데이터 검색에 실패했습니다.');
        }
        
        const searchData = await searchResponse.json();
        const existingPageId = searchData.results[0]?.id || null;

        // --- 2. 기존 기록의 유무에 따라 로직 분기 ---
        if (existingPageId) {
            // [업데이트] 기존 기록이 있으면 내용을 업데이트합니다.
            
            // 업데이트할 properties 객체를 새로 만듭니다.
            const properties = {}; 

            // Heather님의 기존 데이터 처리 로직을 그대로 사용합니다.
            const propertyNameMap = { "영어 더빙 학습": "영어 더빙 학습 완료", "더빙 워크북": "더빙 워크북 완료", "완료 여부": "📕 책 읽는 거인", "오늘의 소감": "오늘의 학습 소감" };
            const numberProps = ["단어 (맞은 개수)", "단어 (전체 개수)", "문법 (전체 개수)", "문법 (틀린 개수)", "독해 (틀린 개수)"]; 
            const selectProps = ["독해 하브루타", "📖 영어독서", "어휘학습", "Writing", "📕 책 읽는 거인"];
            const textProps = ["어휘유닛", "오늘의 학습 소감"];
            
            for (let key in formData) {
                const value = formData[key];
                const notionPropName = propertyNameMap[key] || key;
                if (!value || ['해당없음', '진행하지 않음', '숙제없음', 'SKIP', ''].includes(value)) { continue; }

                if (key === '오늘 읽은 영어 책 ID') {
                    properties['오늘 읽은 영어 책'] = { relation: [{ id: value }] };
                } else if (key === '국어 독서 제목') { 
                    const bookPageId = await findPageIdByTitle(process.env.KOR_BOOKS_ID, value, '책제목');
                    if (bookPageId) { properties['국어 독서 제목'] = { relation: [{ id: bookPageId }] }; }
                } else if (numberProps.includes(notionPropName)) {
                    properties[notionPropName] = { number: Number(value) };
                } else if (selectProps.includes(notionPropName)) {
                    properties[notionPropName] = { select: { name: value } };
                } else if (textProps.includes(notionPropName)) {
                    properties[notionPropName] = { rich_text: [{ text: { content: value } }] };
                } else if (key !== '오늘 읽은 영어 책') {
                    properties[notionPropName] = { status: { name: value } };
                }
            }

            // PATCH 요청으로 기존 페이지를 업데이트합니다.
            const updateResponse = await fetch(`https://api.notion.com/v1/pages/${existingPageId}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
                body: JSON.stringify({ properties: properties })
            });
            
            if (!updateResponse.ok) {
                const errorData = await updateResponse.json();
                console.error('Notion 업데이트 API 오류:', errorData);
                throw new Error(`Notion API Error: ${errorData.message}`);
            }

            res.json({ success: true, message: '오늘의 학습 내용이 성공적으로 업데이트되었습니다!' });

        } else {
            // [에러 처리] 기존 기록이 없으면, 요청하신 메시지를 출력합니다.
            console.warn(`[주의] ${today} 날짜의 ${studentName} 학생 기록이 없어서 저장을 거부했습니다.`);
            res.status(404).json({ success: false, message: "선생님에게 스터디 플래너 에러라고 알려주세요!" });
        }
        
    } catch (error) {
        console.error('학습일지 저장 오류:', error);
        res.status(500).json({ success: false, message: '저장 중 서버에 문제가 발생했습니다.' });
    }
});
app.get('/api/homework-status', requireAuth, async (req, res) => {
    try {
        const accessToken = process.env.NOTION_ACCESS_TOKEN;
        const PROGRESS_DB_ID = process.env.PROGRESS_DATABASE_ID;
        if (!accessToken || !PROGRESS_DB_ID) {
            throw new Error('서버 환경 변수가 설정되지 않았습니다.');
        }

        // --- 필터 조건 구성 ---
        const { period, startDate, endDate, teacher } = req.query;
        const filterConditions = [];

        // 1. 기간 필터
        if (period === 'today') {
            const today = new Date().toISOString().split('T')[0];
            filterConditions.push({ property: '🕐 날짜', date: { equals: today } });
        }
        // (week, month 등 다른 기간 필터는 필요시 추가)
        else if (startDate && endDate) {
            filterConditions.push({
                and: [
                    { property: '🕐 날짜', date: { on_or_after: startDate } },
                    { property: '🕐 날짜', date: { on_or_before: endDate } }
                ]
            });
        }

        // 2. 담당쌤 필터 (관계형 속성 필터링)
        if (teacher && teacher !== 'all') {
            filterConditions.push({ property: '담당쌤', relation: { contains: teacher } });
        }

        // --- Notion API 호출 ---
        const response = await fetch(`https://api.notion.com/v1/databases/${PROGRESS_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Notion-Version': '2022-06-28'
            },
            body: JSON.stringify({
                filter: { and: filterConditions },
                sorts: [{ property: '🕐 날짜', direction: 'descending' }]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Notion API 오류:', errorData);
            throw new Error('Notion에서 데이터를 가져오는 데 실패했습니다.');
        }

        const data = await response.json();

        // --- 프론트엔드로 보낼 데이터 가공 ---
        const homeworkStatus = data.results.map(page => {
            const props = page.properties;
            
            // 관계형 데이터에서 담당쌤 이름 추출
            const teacherNames = props['담당쌤']?.relation?.map(rel => rel.title) || [];

            return {
                pageId: page.id,
                studentId: props['이름']?.title[0]?.plain_text || '이름 없음',
                date: props['🕐 날짜']?.date?.start || '날짜없음',
                teachers: teacherNames, // 가공된 담당쌤 이름 배열
                completionRate: props['수행율']?.formula?.number || 0,
                grammarHomework: props['⭕ 지난 문법 숙제 검사']?.status?.name || '숙제 없음',
                vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '숙제 없음',
                readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '숙제 없음',
                summary: props['4️⃣ Summary 숙제']?.status?.name || '숙제 없음',
                readingHomework: props['5️⃣ 매일 독해 숙제']?.status?.name || '숙제 없음',
                diary: props['6️⃣ 영어 일기(초등) / 개인 독해서 (중고등)']?.status?.name || '숙제 없음'
            };
        });

        res.json(homeworkStatus);

    } catch (error) {
        console.error('숙제 현황 로드 오류:', error);
        res.status(500).json({ message: '서버에서 숙제 현황 데이터를 처리하는 중 오류가 발생했습니다.' });
    }
});


// --- 서버 실행 ---
app.listen(PORT, '127.0.0.1', () => { 
  console.log(`✅ 최종 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});