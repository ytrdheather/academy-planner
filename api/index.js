import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';

// [모듈 Import]
import { initializeMonthlyReportRoutes } from './monthlyReportModule.js';
import { initializeBookRoutes, processBookRelations } from './bookModule.js';
import { initializeExamAnalyzerRoutes } from './examAnalyzerModule.js';

const {
    JWT_SECRET = 'dev-only-secret-readitude-2025',
    NOTION_ACCESS_TOKEN,
    STUDENT_DATABASE_ID,
    PROGRESS_DATABASE_ID,
    KOR_BOOKS_ID,
    ENG_BOOKS_ID,
    GEMINI_API_KEY,
    MONTHLY_REPORT_DB_ID,
    GRAMMAR_DB_ID,
    TEXTBOOK_DB_ID,
    EXAM_DB_ID,
    QUESTION_DB_ID,
    STUDENT_RESULT_DB_ID,
    STUDENT_ANSWER_DB_ID,
} = process.env;

// [핵심] HTTPS 강제
const DOMAIN_URL = 'https://readitude.onrender.com';
const PORT = process.env.PORT || 5001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const publicPath = path.join(__dirname, '../public');

// ------------------------------------------------------------------
// [캐시 저장소] 선생님 대시보드 로딩 속도 대폭 개선용
// ------------------------------------------------------------------
const dashboardCache = {
    dailyReport: { data: null, lastFetch: 0, date: null },
    pastGrammar: { data: null, lastFetch: 0 }
};
const CACHE_DURATION = 1000 * 60; // 일일 리포트 1분 캐시
const GRAMMAR_CACHE_DURATION = 1000 * 60 * 5; // 과거 문법 5분 캐시
// ------------------------------------------------------------------

// Notion API 호출 헬퍼
async function fetchNotion(url, options = {}, retries = 3) {
    const headers = {
        'Authorization': `Bearer ${NOTION_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
    };
    
    // GET 요청일 때는 body를 제거하도록 방어코드 추가
    const fetchOptions = { ...options, headers };
    if (!fetchOptions.method || fetchOptions.method === 'GET') {
        delete fetchOptions.body;
    }

    try {
        const response = await fetch(url, fetchOptions);

        if (response.status === 409 && retries > 0) {
            console.warn(`⚠️ Notion API Conflict (409). Retrying...`);
            await new Promise(resolve => setTimeout(resolve, 500)); 
            return fetchNotion(url, options, retries - 1);
        }

        if (!response.ok) {
            const errorData = await response.json();
            console.error(`Notion API Error (${url}):`, JSON.stringify(errorData, null, 2));
            throw new Error(errorData.message || `Notion API Error: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        throw error;
    }
}

// Gemini AI 설정
let genAI, geminiModel;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        // thinking(추론) 토큰 비활성화 + 출력 상한 → 비용 캡 & 답변 잘림 방지
        generationConfig: { temperature: 0.7, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } }
    });
    console.log('✅ Gemini AI 연결됨');
}

// 선생님 계정 정보
const userAccounts = {
    'manager': { password: 'rdtd112!@', role: 'manager', name: '원장 헤더쌤' },
    'teacher1': { password: 'rdtd112!@', role: 'manager', name: '조이쌤' },
    'teacher2': { password: 'rdtd112!@', role: 'manager', name: '주디쌤' },
    'teacher3': { password: 'rdtd112!@', role: 'teacher', name: '소영쌤' },
    'teacher4': { password: 'rdtd112!@', role: 'teacher', name: '레일라쌤' },
    'manager2': { password: 'rdtd112!@', role: 'manager', name: '매니져조교' },
    'teacher5': { password: 'rdtd112!@', role: 'manager', name: '앨리스쌤' }
};

// Helper Functions
function generateToken(userData) { return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (error) { return null; } }

function getKSTTodayRange() {
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffset);
    const kstDateString = kstNow.toISOString().split('T')[0];
    const start = new Date(`${kstDateString}T00:00:00.000+09:00`);
    const end = new Date(`${kstDateString}T23:59:59.999+09:00`);
    return { start: start.toISOString(), end: end.toISOString(), dateString: kstDateString };
}

function getKoreanDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' };
    return new Intl.DateTimeFormat('ko-KR', options).format(date);
}

const getRollupArray = (prop) => {
    if (!prop?.rollup?.array) return [];
    return prop.rollup.array.map(item => {
        if (item.type === 'number') return item.number;
        if (item.type === 'select') return item.select?.name;
        if (item.type === 'title') return item.title?.[0]?.plain_text;
        if (item.type === 'rich_text') return item.rich_text?.[0]?.plain_text;
        return null;
    });
};

const getRollupValue = (prop, isNumber = false) => {
    if (!prop?.rollup) return isNumber ? null : '';
    if (prop.rollup.type === 'number') return prop.rollup.number;
    if (prop.rollup.type === 'array' && prop.rollup.array.length > 0) {
        const item = prop.rollup.array[0];
        if (item.type === 'title') return item.title[0]?.plain_text || '';
        if (item.type === 'rich_text') return item.rich_text[0]?.plain_text || '';
        if (item.type === 'number') return item.number;
        if (item.type === 'select') return item.select?.name || '';
    }
    return isNumber ? null : '';
};

const getSimpleText = (prop) => {
    if (!prop) return '';
    if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('\n');
    if (prop.type === 'title') return prop.title[0]?.plain_text || '';
    if (prop.type === 'select') return prop.select?.name || '';
    return '';
};

// 노션의 속성 이름이 살짝 달라도 키워드로 무조건 찾아오는 강력한 헬퍼 함수
const getPropByKeywords = (propsObj, keywords) => {
    const keys = Object.keys(propsObj);
    for (const k of keys) {
        if (keywords.every(word => k.includes(word))) return propsObj[k];
    }
    return null;
};

async function findPageIdByTitle(databaseId, title, titlePropertyName = 'Title') {
    if (!NOTION_ACCESS_TOKEN || !title || !databaseId) return null;
    try {
        let filterBody = { property: titlePropertyName, title: { equals: title } };
        if (titlePropertyName === '반이름') filterBody = { property: titlePropertyName, select: { equals: title } };
        else if (titlePropertyName === '책제목') filterBody = { property: titlePropertyName, rich_text: { equals: title } };

        const data = await fetchNotion(`https://api.notion.com/v1/databases/${databaseId}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: filterBody, page_size: 1 })
        });
        return data.results[0]?.id || null;
    } catch (error) { return null; }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '인증 토큰이 필요합니다' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: '유효하지 않은 토큰입니다' });
    req.user = decoded;
    next();
}

app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'views', 'login.html')));
app.get('/planner', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner-modular.html')));
app.get('/teacher-login', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher-login.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(publicPath, 'views', 'teacher.html')));

app.get('/past-grammar', (req, res) => res.sendFile(path.join(publicPath, 'views', 'past-grammar.html')));
app.get('/exam-analyzer', (req, res) => res.sendFile(path.join(publicPath, 'views', 'exam-analyzer.html')));
app.get('/student-grader', (req, res) => res.sendFile(path.join(publicPath, 'views', 'student-grader.html')));
app.get('/results-viewer', (req, res) => res.sendFile(path.join(publicPath, 'views', 'results-viewer.html')));
app.get('/student-report', (req, res) => res.sendFile(path.join(publicPath, 'views', 'student-report.html')));

app.use('/assets', express.static(path.join(publicPath, 'assets')));

initializeBookRoutes(app, fetchNotion, process.env);
try {
    initializeMonthlyReportRoutes({
        app, fetchNotion, geminiModel, requireAuth,
        dbIds: { STUDENT_DATABASE_ID, PROGRESS_DATABASE_ID, KOR_BOOKS_ID, ENG_BOOKS_ID, MONTHLY_REPORT_DB_ID, GRAMMAR_DB_ID },
        domainUrl: DOMAIN_URL, publicPath,
        getRollupValue, getSimpleText, getKSTTodayRange, getKoreanDate
    });
} catch(e) { console.error('Monthly Report Module Init Error', e); }

try {
    initializeExamAnalyzerRoutes({ app, requireAuth, fetchNotion, geminiModel, dbIds: { EXAM_DB_ID, QUESTION_DB_ID, STUDENT_RESULT_DB_ID, STUDENT_ANSWER_DB_ID } });
} catch(e) { console.error('Exam Analyzer Module Init Error', e); }

app.post('/api/generate-daily-comment', requireAuth, async (req, res) => {
    const { pageId, studentName, keywords } = req.body;
    if (!pageId || !keywords) return res.status(400).json({ success: false, message: 'Missing info' });
    if (!geminiModel) return res.status(500).json({ success: false, message: 'AI not configured' });

    try {
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsedData = await parseDailyReportData(page);

        // 성을 떼어낸 호칭 (대부분 성은 1글자). 예: 강건우 → 건우
        const givenName = (studentName && studentName.length >= 3) ? studentName.slice(1) : studentName;

        // [한국어 조사 정확도] 이름 끝글자 받침(종성) 유무로 호칭 형태를 미리 확정.
        // 받침 있으면 '이'를 붙여 부름: 재은 → 재은이는/재은이가, 없으면: 시우 → 시우는/시우가
        const lastCh = givenName.charCodeAt(givenName.length - 1);
        const hasBatchim = (lastCh >= 0xAC00 && lastCh <= 0xD7A3) && ((lastCh - 0xAC00) % 28 !== 0);
        const callName = hasBatchim ? givenName + '이' : givenName;     // 부를 때 (예: 재은이 / 시우)
        const nameTopic = hasBatchim ? givenName + '이는' : givenName + '는';  // ~는
        const nameSubj  = hasBatchim ? givenName + '이가' : givenName + '가';  // ~가
        const namePoss  = hasBatchim ? givenName + '이의' : givenName + '의';  // ~의

        // [학습 결과 브리핑 데이터] "실제로 입력된 항목만" 골라서 전달 (수식은 빈칸에도 0%/PASS를 내놓으므로 입력칸 기준으로 판별)
        const t = parsedData.tests || {};
        const resultLines = [];
        const vocabEntered = !(t.vocabCorrect === null || t.vocabCorrect === undefined) || !(t.vocabTotal === null || t.vocabTotal === undefined);
        if (vocabEntered && t.vocabScore !== null && t.vocabScore !== undefined && !isNaN(t.vocabScore)) {
            resultLines.push(`- 어휘 테스트: ${Math.round(t.vocabScore)}점` + (t.vocabUnit ? ` (범위: ${t.vocabUnit})` : ''));
        }
        const grammarScoreNum = Number(t.grammarScore);
        if (t.grammarScore !== null && t.grammarScore !== undefined && t.grammarScore !== 'N/A' && t.grammarScore !== '시험 보지 않음' && !isNaN(grammarScoreNum)) {
            resultLines.push(`- 문법 테스트: ${Math.round(grammarScoreNum)}점`);
        }
        const readingEntered = !(t.readingWrong === null || t.readingWrong === undefined);
        if (readingEntered && (t.readingResult === 'PASS' || t.readingResult === 'FAIL')) {
            resultLines.push(`- 독해 해석 시험: ${t.readingResult === 'PASS' ? '통과(PASS)' : '재시험 필요(FAIL)'} (오답 ${t.readingWrong}개)`);
        }
        if (parsedData.completionRate !== null && parsedData.completionRate !== undefined) {
            resultLines.push(`- 숙제 수행율: ${parsedData.completionRate}%`);
        }
        const resultBlock = resultLines.length ? resultLines.join('\n        ') : '(오늘 입력된 결과 없음)';

        const prompt = `
        너는 '리디튜드' 영어학원의 경력 많은 담임 선생님이다. 학부모님께 보내는 '일일 학습 코멘트'를 작성한다. "안녕하세요, ~입니다" 같은 자기소개는 절대 금지.

        [말투 — 가장 중요]
        - 너는 학습 전문가(담임 교사)다. 정중하고 담담한 문어체로 쓴다. 모든 문장을 '~습니다 / ~합니다 / ~ㅂ니다 / ~보입니다 / ~였습니다' 같은 '~니다' 체로 끝맺는다. '~요'로 끝나는 문장(~했어요, ~예요, ~네요, ~더라고요 등)은 한 문장도 쓰지 않는다. 온기는 어미가 아니라 구체적 관찰과 절제된 격려(문장 내용)로 표현한다.
        - 절대 금지(유치원 선생님·아기자기 말투): '~한답니다 / ~이에요~ / ~거예요 / ~같아요!' 류의 어미, 감탄사, 그리고 느낌표(!). 느낌표는 한 개도 쓰지 않는다.
        - 감정 과잉·미화 금지. 학부모의 감정을 대신 들뜨게 하는 표현("기대해주셔도 좋아요", "~해주셔도 좋을 것 같아요")도 금지.
        - 아래는 실제로 나왔던 나쁜 문장들이다. 이런 톤을 절대 쓰지 마라:
          (나쁨) "정말 즐거운 주제로", "무척 즐거워하는 모습이었어요", "참 기특했답니다", "멋지게 발표하는 시간을 가질 예정이니 기대해주셔도 좋을 것 같아요!", "함께 즐겁게 노력할 예정이에요", "정말 대견하답니다", "재아를 더욱 단단하게 만들어줄 거예요!"
        - 같은 내용을 전문가 톤으로 바꾼 좋은 예:
          (좋음) "'Let's go camping'을 주제로 리딩을 진행했습니다.", "자신의 생각을 글로 정리하는 활동에 적극적으로 참여했습니다.", "시간 관계상 발표는 다음 주 화요일로 예정되어 있습니다.", "다음 주부터 새 어휘 교재를 시작하며 단어 학습 습관을 잡아갈 계획입니다."
        - 원칙: 사실에 근거한 관찰 + 지도 계획을 담담하게 서술한다. 칭찬은 구체적 행동을 근거로 절제해서(좋은 예: "오답을 스스로 정리하는 모습이 인상적이었습니다.").

        [호칭 — 반드시 이 형태 그대로] "${studentName} 학생"처럼 성+학생 금지. 아래 형태만 사용하고 임의로 조사를 바꾸지 말 것:
        - 부를 때: "${callName}" / ~는: "${nameTopic}" / ~가: "${nameSubj}" / ~의: "${namePoss}"

        [글의 흐름과 분량 — 매우 중요]
        - 사람이 정성껏 손으로 쓴 편지처럼 자연스럽게 이어 써라. 접속어("그리고, ~하며, 이어서, 다만, 한편")와 맥락으로 문장을 부드럽게 연결하고, 사건은 시간·논리 순서대로 매끄럽게 정리한다.
        - 절대 금지: 뚝뚝 끊기는 단문을 나열식으로 쌓는 것, 같은 내용을 두 번 말하는 것.
        - 키워드에 담긴 내용은 하나도 빠뜨리지 말고 모두 반영하라. 각 내용을 자연스러운 문장으로 충분히 풀어써서, 완성된 코멘트가 절대 입력 키워드보다 짧아지지 않게 한다. (사실을 압축·생략 금지)

        [사실 왜곡 절대 금지]
        - 키워드에 적힌 사실을 각색하거나 부풀리지 마라. 특히 "~까지 ~해오기/풀어오기"는 '앞으로 해야 할 숙제 부여'다. 이것을 "잘 해왔다"처럼 완료된 일로 절대 바꾸지 마라. 키워드에 없는 에피소드·감정은 새로 지어내지 마라.
        - 다만 키워드에 명시된 긍정적 사실(예: "즐겁게 하였음", "흥미를 보임")은 절대 빼먹지 말고 전달하라. 표현만 호들갑 없이 담담하게: (좋음) "자신의 생각을 쓰는 활동에 흥미를 보이며 즐겁게 참여했습니다."

        [부족한 점을 전할 때 — 두 경우를 반드시 구분]
        ① 숙제를 안 해왔거나 수행율이 낮은 경우 → 쿠션어 쓰지 말고 사실대로 직설적으로 전달 + 실질적인 안내를 덧붙인다.
           예: "오늘 숙제를 해오지 않았습니다. 숙제를 집에서 하기 힘들어하면 학원에 일찍 와서 숙제를 하도록 해주세요. 혹여 일찍 오기 어렵다면 학원에서 숙제를 모두 마치고 가도록 하겠습니다."
        ② 점수가 낮거나, 이해가 부족하거나, 어려워하는 부분 → 이때만 쿠션어를 적용한다. 감싸되 얼버무리지 않는다.
           예: "점수가 낮습니다"(X) → "이번 시험에서는 아쉬움이 남았지만, 오답을 함께 정리하며 보완하고 있습니다"(O)
           예: "이해를 못 합니다"(X) → "아직 헷갈려하는 부분이 있어 다음 시간에 한 번 더 짚어줄 예정입니다"(O)

        [입력 정보]
        - 이름(제목용): ${studentName} / 호칭: ${givenName}
        - 오늘의 키워드(선생님 메모): ${keywords}
        - 오늘의 학습 결과(입력된 항목만, 이 목록에 없는 항목은 절대 언급 금지):
        ${resultBlock}

        [구성 — 이 순서와 제목을 정확히 지킬 것]
        1문단: "오늘의 리디튜더 ${studentName}의 일일 학습 리포트📑를 보내드립니다." 로 시작 → 한 줄 띄우고 → 키워드에 있는 모든 내용을, 위 [글의 흐름] 규칙에 따라 자연스럽게 이어지는 하나의 문단으로 풀어 서술한다(빠뜨리는 항목 없이, 키워드보다 짧지 않게). (키워드가 "없음"이면 이 본문은 생략하고 바로 2문단으로)
        2문단: "<📢 오늘의 학습 결과와 숙제 수행율 안내>" 제목 후, 위 [오늘의 학습 결과] 목록에 있는 항목을 하나씩 자연스러운 문장으로 브리핑한다. 점수·결과를 정확히 언급하고, 잘한 항목은 담백하게 인정, 점수가 아쉬운 항목은 쿠션어로 전달한다. 숙제 수행율이 있으면 수행율 평가로 마무리: 100%면 성실함을 담백하게 인정, 낮으면 위 ①번 규칙대로 사실을 직설적으로 전달하고 실질적 안내(학원에 일찍 와서 하기 / 남아서 마치고 가기)를 덧붙인다. 목록이 "(오늘 입력된 결과 없음)"이면 이 문단 본문은 "오늘은 별도의 테스트 없이 학습을 진행했습니다." 한 줄만.
        마무리: "<📢 오늘의 중요 전달 사항>" 제목만 출력.

        [형식] 본문만 작성. 별표(*)·따옴표(') 강조 금지.

        [예시 1 — 자연스러운 흐름과 분량의 본보기 (문장이 매끄럽게 이어지는 것을 참고)]
        오늘의 리디튜더 김지민의 일일 학습 리포트📑를 보내드립니다.

        오늘 지민이는 'Let's go camping'이라는 주제로 깊이 있는 리딩을 진행한 뒤, 읽은 내용을 바탕으로 직접 글을 써보는 시간을 가졌습니다. 특히 자신의 생각을 자유롭게 풀어 쓰는 부분에서는 흥미를 보이며 즐겁게 참여하는 모습이었습니다. 다만 처음에는 답을 단답형으로 짧게 적어, 문장을 좀 더 완성도 있게 다듬는 과정에 시간이 다소 걸렸습니다. 이 과정을 통해 표현이 한결 풍부해진 만큼 앞으로의 글쓰기가 기대되는 부분입니다. 오늘은 시간이 부족해 발표까지는 진행하지 못했으며, 발표는 다음 주 화요일에 이어서 하기로 했습니다. 또한 다음 주부터는 새로운 어휘 교재를 시작하여, 단어를 꾸준히 익히는 학습 습관을 함께 잡아갈 계획입니다.

        <📢 오늘의 학습 결과와 숙제 수행율 안내>
        오늘 어휘 테스트는 95점으로 안정적인 결과를 보였고, 독해 해석 시험도 무난히 통과했습니다. 숙제 수행율은 100%로, 맡은 분량을 꾸준히 해내고 있어 학습 태도가 믿음직스럽습니다.

        <📢 오늘의 중요 전달 사항>

        [예시 2 — 아쉬운 점이 있는 날의 톤 (점수는 쿠션어, 숙제 미이행은 직설+안내)]
        오늘의 리디튜더 박서준의 일일 학습 리포트📑를 보내드립니다.

        서준이는 오늘 새로 배운 문법 개념을 예문에 적용하는 연습을 진행했습니다. 아직 헷갈려하는 부분이 있어 다음 시간에 한 번 더 짚어줄 예정입니다.

        <📢 오늘의 학습 결과와 숙제 수행율 안내>
        오늘 문법 테스트는 68점으로 아쉬움이 남았지만, 틀린 문항을 함께 확인하며 어디서 헷갈렸는지 정리해 두었습니다. 숙제 수행율은 67%로, 오늘 독해 숙제를 해오지 않았습니다. 숙제를 집에서 하기 힘들어하면 학원에 일찍 와서 숙제를 하도록 해주세요. 일찍 오기 어렵다면 학원에서 숙제를 모두 마치고 가도록 하겠습니다.

        <📢 오늘의 중요 전달 사항>
        `;

        // 전문가 톤은 프롬프트로 잡고, temperature는 자연스러운 문장 연결을 위해 0.72로.
        const result = await geminiModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.72, maxOutputTokens: 2500, thinkingConfig: { thinkingBudget: 1024 } }
        });
        let commentText = result.response.text();

        // [신규] 반별 문법 코멘트를 인사말 바로 뒤에 "원문 그대로" 삽입 (AI 각색 방지 — 코드로 조립)
        const grammarComment = (parsedData.comment && parsedData.comment.grammarComment) ? parsedData.comment.grammarComment.trim() : '';
        if (grammarComment) {
            const greeting = `오늘의 리디튜더 ${studentName}의 일일 학습 리포트📑를 보내드립니다.`;
            const idx = commentText.indexOf(greeting);
            if (idx !== -1) {
                const after = idx + greeting.length;
                commentText = commentText.slice(0, after) + `\n\n${grammarComment}` + commentText.slice(after);
            } else {
                // 인사말을 못 찾으면 안전하게 맨 앞에 붙임
                commentText = `${greeting}\n\n${grammarComment}\n\n${commentText}`;
            }
        }
        res.json({ success: true, comment: commentText });
    } catch (error) {
        console.error('AI Comment Error:', error);
        res.status(500).json({ success: false, message: 'AI generation failed' });
    }
});

async function parseDailyReportData(page) {
    const props = page.properties;
    
    // [완벽 롤백] 이름은 절대 키워드 탐색기를 쓰지 않고 '이름' 타이틀 칸에서 정확하게 가져옵니다.
    const studentName = props['이름']?.title?.[0]?.plain_text || '학생';
    const pageDate = props['🕐 날짜']?.date?.start || getKSTTodayRange().dateString;

    let assignedTeachers = [];
    if (props['담당쌤']?.rollup?.array) {
        assignedTeachers = [...new Set(props['담당쌤'].rollup.array.flatMap(item => item.multi_select?.map(t => t.name) || item.title?.[0]?.plain_text))].filter(Boolean);
    }

    // [신규] 등원요일 (4.수업요일 롤업의 multi_select → '월수금')
    let attendanceDays = '';
    const dayRollup = props['4.수업요일']?.rollup?.array;
    if (dayRollup && dayRollup[0]?.multi_select) {
        attendanceDays = dayRollup[0].multi_select.map(d => d.name).join('');
    }

    const homework = {
        attendance: props['출석']?.checkbox || false,
        absenceReason: getSimpleText(props['결석 사유']), // [신규] 결석 사유 (있으면 결석으로 간주)
        grammar: props['⭕ 지난 문법 숙제 검사']?.status?.name || '해당 없음',
        vocabCards: props['1️⃣ 어휘 클카 암기 숙제']?.status?.name || '해당 없음',
        readingCards: props['2️⃣ 독해 단어 클카 숙제']?.status?.name || '해당 없음',
        summary: props['4️⃣ Summary 숙제']?.status?.name || '해당 없음',
        dailyReading: props['5️⃣ 독해서 풀기']?.status?.name || '해당 없음',
        diary: props['6️⃣ 부&매&일']?.status?.name || '해당 없음'
    };

    // [신규] 출결·숙제 관리 탭용: 생성된(또는 수동 입력한) 숙제 내용
    const assignedHw = {
        vocab: getSimpleText(props['어휘숙제']),
        mainR: getSimpleText(props['주독해숙제']),
        subR: getSimpleText(props['부독해숙제']),
        grammar: getSimpleText(props['문법 숙제 내용'])
    };

    const checkList = [
        homework.grammar, homework.vocabCards, homework.readingCards,
        homework.summary, homework.dailyReading, homework.diary
    ];

    let totalScore = 0; let count = 0;
    checkList.forEach(status => {
        if (!status) return;
        if (['숙제 함', '완료', '완료함'].includes(status)) { totalScore += 100; count++; } 
        else if (['안 해옴', '미완료', '못함', '못하고감'].includes(status)) { totalScore += 0; count++; }
    });

    const performanceRate = count > 0 ? Math.round(totalScore / count) : null;

    const getFormulaValue = (prop) => {
        if (!prop?.formula) return null;
        if (prop.formula.type === 'string') return prop.formula.string || null; 
        if (prop.formula.type === 'number') return prop.formula.number;
        return null;
    };

    let grammarScoreRaw = getFormulaValue(getPropByKeywords(props, ['문법', '시험', '점수']) || props['📑 문법 시험 점수']);
    if (grammarScoreRaw === 0) grammarScoreRaw = '시험 보지 않음';

    const tests = {
        vocabUnit: getSimpleText(props['어휘유닛']),
        vocabCorrect: (props['단어(맞은 개수)'] || props['단어 (맞은 개수)'])?.number ?? null,
        vocabTotal: (props['단어(전체 개수)'] || props['단어 (전체 개수)'])?.number ?? null,
        vocabScore: getFormulaValue(props['📰 단어 테스트 점수']),
        readingWrong: (props['독해(틀린 개수)'] || props['독해 (틀린 개수)'])?.number ?? null,
        readingResult: getFormulaValue(props['📚 독해 해석 시험 결과']),
        havruta: props['독해 하브루타']?.select?.name || '숙제없음',
        grammarTotal: (props['문법(전체 개수)'] || props['문법 (전체 개수)'])?.number ?? null,
        grammarWrong: (props['문법(틀린 개수)'] || props['문법 (틀린 개수)'])?.number ?? null,
        grammarScore: grammarScoreRaw 
    };

    const listening = {
        study: props['영어 더빙 학습 완료']?.status?.name || '진행하지 않음',
        workbook: props['더빙 워크북 완료']?.status?.name || '진행하지 않음',
        koreanBooks: (() => {
            const titles = getRollupArray(props['국어책제목(롤업)']);
            const ids = props['국어 독서 제목']?.relation?.map(r => r.id) || [];
            return titles.map((t, i) => ({ title: t, id: ids[i] || null }));
        })(),
        giantStatus: props['📕 책 읽는 거인']?.select?.name || ''
    };

    const engBookTitles = getRollupArray(props['📖 책제목 (롤업)']);
    const engBookARs = getRollupArray(props['AR']); 
    const engBookLexiles = getRollupArray(props['Lexile']); 
    const engBookIds = props['오늘 읽은 영어 책']?.relation?.map(r => r.id) || [];
    
    const englishBooks = engBookTitles.map((title, idx) => ({ 
        title: title, id: engBookIds[idx] || null, ar: engBookARs[idx] || null, lexile: engBookLexiles[idx] || null
    }));

    const reading = {
        readingStatus: props['📖 영어독서']?.select?.name || '',
        vocabStatus: props['어휘학습']?.select?.name || '',
        bookTitle: getRollupValue(props['📖 책제목 (롤업)']) || '읽은 책 없음',
        englishBooks: englishBooks, 
        bookSeries: getRollupValue(props['시리즈이름']),
        bookAR: getRollupValue(props['AR'], true),
        bookLexile: getRollupValue(props['Lexile'], true),
        writingStatus: props['Writing']?.select?.name || 'N/A'
    };

    const grammarClassName = getRollupValue(props['문법클래스']) || null;
    let grammarTopic = getSimpleText(props['오늘 문법 진도']);
    let grammarHomework = getSimpleText(props['문법 숙제 내용']) || getSimpleText(props['문법 과제 내용']);
    let grammarComment = getSimpleText(props['문법 코멘트']); // [신규] 반별 문법 코멘트(GRAMMAR_DB에서 투사됨)

    const grammarTestProp = getPropByKeywords(props, ['문법', '테스트', '내용']) || props['문법 테스트 내용'] || props['문법 파트'];
    let grammarTestStr = '';
    if (grammarTestProp) {
        if (grammarTestProp.type === 'multi_select' && grammarTestProp.multi_select) {
            grammarTestStr = grammarTestProp.multi_select.map(i => i.name).join(', ');
        } else if (grammarTestProp.type === 'select' && grammarTestProp.select) {
            grammarTestStr = grammarTestProp.select.name;
        } else if (grammarTestProp.type === 'rich_text' && grammarTestProp.rich_text && grammarTestProp.rich_text.length > 0) {
            grammarTestStr = grammarTestProp.rich_text[0].plain_text;
        }
    }

    const comment = {
        teacherComment: getSimpleText(props['❤ Today\'s Notice!']) || '오늘의 코멘트가 없습니다.',
        grammarClass: grammarClassName || '진도 해당 없음',
        grammarTopic: grammarTopic || '진도 해당 없음', 
        grammarTest: grammarTestStr,
        grammarHomework: grammarHomework || '숙제 내용 없음',
        grammarComment: grammarComment || '', // [신규] 반별 문법 코멘트

        studentReflection: getSimpleText(props['오늘의 학습 소감']), // [신규 추가] 학생의 학습 소감
        writeCompleted: props['작성완료']?.checkbox === true // [신규] 코멘트 작성완료 여부
    };

    return { pageId: page.id, studentName, attendanceDays, date: pageDate, teachers: assignedTeachers, completionRate: performanceRate, homework, assignedHw, tests, listening, reading, comment };
}

async function fetchProgressData(req, res, parseFunction) {
    const { period = 'today', date } = req.query;
    if (!NOTION_ACCESS_TOKEN || !PROGRESS_DATABASE_ID) throw new Error('Server config error');
    
    let dateString = date || getKSTTodayRange().dateString;
    const filter = { "and": [ { property: '🕐 날짜', date: { equals: dateString } } ] };

    const pages = [];
    let hasMore = true;
    let startCursor = undefined;
    
    while (hasMore) {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: filter,
                sorts: [{ property: '🕐 날짜', direction: 'descending' }, { property: '이름', direction: 'ascending' }],
                page_size: 100, start_cursor: startCursor
            })
        });

        pages.push(...data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
    }
    return await Promise.all(pages.map(parseFunction));
}

app.get('/api/daily-report-data', requireAuth, async (req, res) => {
    try {
        const { date, force } = req.query;
        const targetDate = date || getKSTTodayRange().dateString;

        // [수정됨] force(강제 새로고침)가 'true'가 아닐 때만 캐시를 사용합니다.
        if (force !== 'true' && dashboardCache.dailyReport.date === targetDate && 
            (Date.now() - dashboardCache.dailyReport.lastFetch < CACHE_DURATION)) {
            return res.json(dashboardCache.dailyReport.data);
        }

        const data = await fetchProgressData(req, res, parseDailyReportData);
        
        // 새로 가져온 데이터 캐싱 저장
        dashboardCache.dailyReport = { data, lastFetch: Date.now(), date: targetDate };
        
        res.json(data);
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// [신규 추가] 특정 학생 1명의 데이터만 노션에서 새로 긁어오는 API
app.get('/api/single-student-report', requireAuth, async (req, res) => {
    const { pageId } = req.query;
    if (!pageId) return res.status(400).json({ success: false, message: 'Page ID missing' });
    try {
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsedData = await parseDailyReportData(page);
        res.json({ success: true, data: parsedData });
    } catch (error) {
        console.error('Single fetch error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/get-today-progress', requireAuth, async (req, res) => {
    const studentName = req.user.name;
    const { date } = req.query;
    
    try {
        const dateString = date || getKSTTodayRange().dateString;
        const filter = { "and": [ { property: '이름', title: { equals: studentName } }, { property: '🕐 날짜', date: { equals: dateString } } ] };
        
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter, page_size: 1 }) });

        if (query.results.length === 0) return res.json({ success: true, progress: null });
        const props = query.results[0].properties;
        const progress = {};
        
        for (const [key, value] of Object.entries(props)) { 
            if (value.type === 'title') progress[key] = value.title[0]?.plain_text; 
            else if (value.type === 'rich_text') progress[key] = value.rich_text[0]?.plain_text; 
            else if (value.type === 'number') progress[key] = value.number; 
            else if (value.type === 'select') progress[key] = value.select?.name; 
            else if (value.type === 'status') progress[key] = value.status?.name;
            else if (value.type === 'files') progress[key] = value.files?.[0]?.external?.url || value.files?.[0]?.file?.url || '';
        }
        const engBookTitles = getRollupArray(props['📖 책제목 (롤업)']); const engBookARs = getRollupArray(props['AR']); const engBookLexiles = getRollupArray(props['Lexile']); const engBookIds = props['오늘 읽은 영어 책']?.relation?.map(r => r.id) || []; progress.englishBooks = engBookTitles.map((title, idx) => ({ title: title, id: engBookIds[idx] || null, ar: engBookARs[idx] || null, lexile: engBookLexiles[idx] || null }));
        const korBookTitles = getRollupArray(props['국어책제목(롤업)']); const korBookIds = props['국어 독서 제목']?.relation?.map(r => r.id) || []; progress.koreanBooks = korBookTitles.map((title, idx) => ({ title, id: korBookIds[idx] || null }));
        
        res.json({ success: true, progress });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/last-comment', requireAuth, async (req, res) => {
    const { studentName, currentDate } = req.query;
    try {
        const filter = {
            and: [
                { property: '이름', title: { equals: studentName } },
                { property: '🕐 날짜', date: { before: currentDate } }
            ]
        };
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter,
                sorts: [{ property: '🕐 날짜', direction: 'descending' }],
                page_size: 1
            })
        });
        
        if (query.results.length === 0) return res.json({ success: true, record: null });
        
        const props = query.results[0].properties;
        const date = props['🕐 날짜']?.date?.start || '';
        const comment = getSimpleText(props['❤ Today\'s Notice!'] || props['Today\'s Notice!']) || '';
        
        res.json({ success: true, record: { date, comment } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// [신규 API] 노션 진도 DB(PROGRESS_DATABASE_ID)의 '문법 테스트 내용' 원본 옵션값들을 싹 다 긁어옵니다!
app.get('/api/notion-grammar-options', requireAuth, async (req, res) => {
    try {
        const dbInfo = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}`, { method: 'GET' });
        
        const testProp = dbInfo.properties['문법 테스트 내용'] || dbInfo.properties['문법 파트'];
        let options = [];
        
        if (testProp && testProp.multi_select) {
            options = testProp.multi_select.options.map(opt => opt.name);
        } else if (testProp && testProp.select) {
            options = testProp.select.options.map(opt => opt.name);
        }
        
        res.json({ success: true, options });
    } catch (error) {
        console.error('Fetch Grammar Options Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/past-grammar-data', requireAuth, async (req, res) => {
    try {
        // 캐시가 유효하면 노션 API 호출 없이 즉시 응답 (5분 캐시). ?force=true면 캐시 무시
        if (req.query.force !== 'true' && dashboardCache.pastGrammar.data &&
            (Date.now() - dashboardCache.pastGrammar.lastFetch < GRAMMAR_CACHE_DURATION)) {
            return res.json({ success: true, data: dashboardCache.pastGrammar.data });
        }

        const { start: kstTodayStr } = getKSTTodayRange();
        const today = new Date(kstTodayStr);
        const end = today.toISOString().split('T')[0];

        const sevenDaysAgo = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000);
        const start = sevenDaysAgo.toISOString().split('T')[0];

        const filter = {
            and: [
                { property: '🕐 날짜', date: { on_or_after: start } },
                { property: '🕐 날짜', date: { on_or_before: end } }
            ]
        };
        
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter, sorts: [{ property: '🕐 날짜', direction: 'descending' }], page_size: 100 })
        });
        
        const records = query.results.map(page => {
            const props = page.properties;
            
            const className = getRollupValue(props['문법클래스']) || '미분류';
            const topic = getSimpleText(getPropByKeywords(props, ['오늘', '문법', '진도']) || props['오늘 문법 진도']) || '-';
            const homework = getSimpleText(getPropByKeywords(props, ['문법', '숙제', '내용']) || getPropByKeywords(props, ['문법', '과제', '내용'])) || '-';
            
            let testStr = '-';
            const testProp = getPropByKeywords(props, ['문법', '테스트', '내용']) || props['문법 테스트 내용'] || props['문법 파트'];
            if (testProp) {
                if (testProp.type === 'multi_select') testStr = testProp.multi_select.map(i=>i.name).join(', ');
                else if (testProp.type === 'select') testStr = testProp.select?.name || '-';
                else if (testProp.type === 'rich_text') testStr = getSimpleText(testProp);
            }
            if(!testStr) testStr = '-';
            
            let score = 'N/A';
            const scoreProp = getPropByKeywords(props, ['문법', '시험', '점수']) || props['📑 문법 시험 점수'];
            if (scoreProp?.formula?.type === 'number') score = scoreProp.formula.number !== null ? scoreProp.formula.number : 'N/A';
            else if (scoreProp?.formula?.type === 'string') {
                const match = scoreProp.formula.string.match(/-?\d+(\.\d+)?/);
                if (match) score = match[0];
            }
            
            if (Number(score) === 0 && score !== null && score !== '') {
                score = '시험 보지 않음';
            }
            
            const date = props['🕐 날짜']?.date?.start || '';

            const studentName = props['이름']?.title?.[0]?.plain_text || '이름없음';

            const grammarTotal = (props['문법(전체 개수)'] || props['문법 (전체 개수)'])?.number ?? null;
            const grammarWrong = (props['문법(틀린 개수)'] || props['문법 (틀린 개수)'])?.number ?? null;

            return { pageId: page.id, date, className, studentName, topic, homework, test: testStr, score, grammarTotal, grammarWrong };
        }).filter(r => r.topic !== '-' || r.homework !== '-' || r.test !== '-');

        // 새로 가져온 데이터 캐싱 저장
        dashboardCache.pastGrammar = { data: records, lastFetch: Date.now() };

        res.json({ success: true, data: records });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/update-grammar-by-class', requireAuth, async (req, res) => {
    const { className, topic, homework, testContent, comment, date } = req.body;
    if (!className || !date) { return res.status(400).json({ success: false, message: 'Missing info' }); }
    
    // [핵심] 진행률을 실시간으로 쪼개서 보내기 위한 청크(Chunk) 스트리밍 설정
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: date } } ] };
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter }) });
        
        const students = query.results;
        
        // [신규 로직] 노션 DB 설정이 '단일 선택'인지 '다중 선택'인지 자동 감지!
        let isMultiSelect = false;
        if (students.length > 0) {
            const testProp = students[0].properties['문법 테스트 내용'] || students[0].properties['문법 파트'];
            if (testProp && testProp.type === 'multi_select') isMultiSelect = true;
        }

        // 대상 반 학생만 추출
        const targetStudents = students.filter(page => {
            const studentClass = getRollupValue(page.properties['문법클래스']);
            return studentClass && studentClass.trim() === className.trim();
        });

        if (targetStudents.length === 0) {
            res.write(JSON.stringify({ success: false, message: '해당 반의 학생 데이터를 찾을 수 없습니다.' }) + '\n');
            return res.end();
        }

        // [신규] ① GRAMMAR_DB(반별 문법 원장)에 (반이름, 날짜) 1행 upsert — 반별 히스토리 영구 보존
        if (GRAMMAR_DB_ID) {
            try {
                const testTags = (testContent && testContent.trim())
                    ? testContent.split(',').map(s => s.trim()).filter(Boolean) : [];
                const gProps = {
                    '이름': { title: [{ text: { content: `${className}-${date}` } }] },
                    '반이름': { select: { name: className } },
                    '날짜': { date: { start: date } },
                    '오늘 문법 진도': { rich_text: [{ text: { content: topic || '' } }] },
                    '문법 과제 내용': { rich_text: [{ text: { content: homework || '' } }] },
                    '문법 테스트 내용': { multi_select: testTags.map(name => ({ name })) }
                };
                if (comment !== undefined) {
                    gProps['문법 코멘트'] = { rich_text: [{ text: { content: comment || '' } }] };
                }
                const gFilter = { "and": [
                    { property: '반이름', select: { equals: className } },
                    { property: '날짜', date: { equals: date } }
                ]};
                const existing = await fetchNotion(`https://api.notion.com/v1/databases/${GRAMMAR_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: gFilter, page_size: 1 }) });
                if (existing.results.length > 0) {
                    await fetchNotion(`https://api.notion.com/v1/pages/${existing.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties: gProps }) });
                } else {
                    await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: GRAMMAR_DB_ID }, properties: gProps }) });
                }
            } catch (ge) {
                console.error('GRAMMAR_DB upsert 실패(투사는 계속):', ge.message);
            }
        }

        let updatedCount = 0;

        // Promise.all 대신 for...of 루프를 사용하여 순차 처리 및 딜레이 추가 (노션 속도 제한 방지)
        for (const page of targetStudents) {
            const properties = {
                '오늘 문법 진도': { rich_text: [{ text: { content: topic || '' } }] },
                '문법 숙제 내용': { rich_text: [{ text: { content: homework || '' } }] }
            };

            // [신규] 반별 문법 코멘트를 각 학생 행에 투사 (생성 시 이 필드를 읽어 주입)
            if (comment !== undefined) {
                properties['문법 코멘트'] = { rich_text: [{ text: { content: comment || '' } }] };
            }

            if (testContent !== undefined) {
                if (testContent.trim() === '') {
                    properties['문법 테스트 내용'] = isMultiSelect ? { multi_select: [] } : { select: null };
                } else {
                    if (isMultiSelect) {
                        const tags = testContent.split(',').map(s => s.trim()).filter(Boolean);
                        properties['문법 테스트 내용'] = { multi_select: tags.map(tag => ({ name: tag })) };
                    } else {
                        properties['문법 테스트 내용'] = { select: { name: testContent.split(',')[0].trim() } };
                    }
                }
            }

            // 개별 학생 업데이트
            await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties })
            });

            updatedCount++;
            
            // 프론트엔드로 현재 진행 상황(예: 3/15) 실시간 전송
            res.write(JSON.stringify({ progress: updatedCount, total: targetStudents.length }) + '\n');
            
            // 노션 API 속도 제한(Rate Limit)을 피하기 위해 300ms 딜레이 부여
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // 데이터 수정 시 대시보드 캐시 무효화 (이전에 추가한 캐시가 있을 경우)
        if (typeof dashboardCache !== 'undefined') {
            dashboardCache.dailyReport.lastFetch = 0;
            dashboardCache.pastGrammar.lastFetch = 0;
        }

        res.write(JSON.stringify({ success: true, message: `총 ${updatedCount}명 업데이트 완료!` }) + '\n');
        res.end();
    } catch (error) { 
        console.error('Grammar Update Error:', error); 
        res.write(JSON.stringify({ success: false, message: error.message }) + '\n');
        res.end();
    }
});

// [신규] 반+날짜로 GRAMMAR_DB 원장 기록을 불러오기 (문법 관리 탭 프리필용)
app.get('/api/grammar-record', requireAuth, async (req, res) => {
    const { className, date } = req.query;
    if (!className || !date) return res.status(400).json({ success: false, message: 'Missing className/date' });
    if (!GRAMMAR_DB_ID) return res.json({ success: true, record: null });
    try {
        const filter = { "and": [
            { property: '반이름', select: { equals: className } },
            { property: '날짜', date: { equals: date } }
        ]};
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${GRAMMAR_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ filter, page_size: 1 }) });
        if (q.results.length === 0) return res.json({ success: true, record: null });
        const p = q.results[0].properties;
        const testTags = (p['문법 테스트 내용']?.multi_select || []).map(t => t.name);
        res.json({ success: true, record: {
            topic: getSimpleText(p['오늘 문법 진도']),
            homework: getSimpleText(p['문법 과제 내용']),
            testContent: testTags.join(', '),
            comment: getSimpleText(p['문법 코멘트'])
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/update-homework', requireAuth, async (req, res) => {
    const { pageId, propertyName, newValue, propertyType, updates } = req.body;
    if (!pageId) return res.status(400).json({ success: false, message: 'Page ID missing' });
    try {
        const mapPropName = (name) => {
            const mapping = { 
                "단어 (맞은 개수)": "단어(맞은 개수)", "단어(맞은 개수)": "단어(맞은 개수)",
                "단어 (전체 개수)": "단어(전체 개수)", "단어(전체 개수)": "단어(전체 개수)",
                "문법 (전체 개수)": "문법(전체 개수)", "문법(전체 개수)": "문법(전체 개수)",
                "문법 (틀린 개수)": "문법(틀린 개수)", "문법(틀린 개수)": "문법(틀린 개수)",
                "독해 (틀린 개수)": "독해(틀린 개수)", "독해(틀린 개수)": "독해(틀린 개수)",
                "5️⃣ 매일 독해 숙제": "5️⃣ 독해서 풀기", "5️⃣ 독해서 풀기 숙제": "5️⃣ 독해서 풀기",
                "5️⃣ 독해서 풀기": "5️⃣ 독해서 풀기", "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 부&매&일", 
                "오늘 읽은 한국 책": "국어 독서 제목", "문법 과제 내용": "문법 숙제 내용",
                "Today's Notice!": "❤ Today's Notice!", "오늘의 코멘트": "❤ Today's Notice!", "오늘의 학습 소감": "오늘의 학습 소감"
            };
            return mapping[name] || name; 
        };
        const mapValue = (val) => { if (val === "해당 없음" || val === "해당없음") return "숙제 없음"; return val; };
        const propertiesToUpdate = {};
        
        const processPayload = (type, val) => {
            if (type === 'number') return { number: Number(val) || 0 };
            if (type === 'rich_text') return { rich_text: [{ text: { content: val || '' } }] };
            if (type === 'select') return { select: val ? { name: val } : null };
            if (type === 'multi_select') {
                const tags = Array.isArray(val) ? val : (val ? String(val).split(',').map(s => s.trim()).filter(Boolean) : []);
                return { multi_select: tags.map(name => ({ name })) };
            }
            if (type === 'relation') return { relation: Array.isArray(val) ? val.map(id => ({ id })) : (val ? [{ id: val }] : []) };
            if (type === 'checkbox') return { checkbox: val };
            if (type === 'file') return { files: [{ name: "인증샷", external: { url: val } }] }; 
            return { status: { name: val || '숙제 없음' } };
        };

        if (updates && typeof updates === 'object') {
            for (const [propName, valObj] of Object.entries(updates)) {
                const notionPropName = mapPropName(propName); 
                const val = mapValue(valObj.value);
                propertiesToUpdate[notionPropName] = processPayload(valObj.type || 'status', val);
            }
        } else if (propertyName) {
            const notionPropName = mapPropName(propertyName); 
            const val = mapValue(newValue);
            propertiesToUpdate[notionPropName] = processPayload(propertyType || 'status', val);
        } else { return res.status(400).json({ success: false, message: 'No update data provided' }); }
        
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: propertiesToUpdate }) });
        
        // [추가됨] 데이터 수정 시 대시보드 캐시 무효화
        dashboardCache.dailyReport.lastFetch = 0;
        dashboardCache.pastGrammar.lastFetch = 0;

        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/teachers', requireAuth, async (req, res) => { const list = Object.values(userAccounts).filter(a => a.role === 'teacher' || a.role === 'manager').map(a => ({ name: a.name })); res.json(list); });
app.post('/teacher-login', async (req, res) => { const { teacherId, teacherPassword } = req.body; const account = userAccounts[teacherId]; if (account && account.password === teacherPassword) { const token = generateToken({ loginId: teacherId, name: account.name, role: account.role }); res.json({ success: true, token }); } else { res.status(401).json({ success: false, message: 'Invalid credentials' }); } });
app.get('/api/teacher/user-info', requireAuth, (req, res) => { res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId }); });
app.get('/api/user-info', requireAuth, (req, res) => { res.json({ userId: req.user.userId, userName: req.user.name, userRole: req.user.role }); });
app.get('/api/student-info', requireAuth, (req, res) => { if (req.user.role !== 'student') return res.status(401).json({ error: 'Students only' }); res.json({ studentId: req.user.userId, studentName: req.user.name }); });
app.post('/login', async (req, res) => { 
    const { studentId, studentPassword } = req.body; 
    const cleanId = studentId ? studentId.trim().toLowerCase() : '';
    const cleanPw = studentPassword ? studentPassword.toString().trim() : '';

    try { 
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, { 
            method: 'POST', 
            body: JSON.stringify({ filter: { and: [ { property: '학생 ID', rich_text: { equals: cleanId } }, { property: '비밀번호', rich_text: { equals: cleanPw } } ] } }) 
        }); 

        if (data.results.length > 0) { 
            const name = data.results[0].properties['이름']?.title?.[0]?.plain_text || cleanId; 
            const token = generateToken({ userId: cleanId, role: 'student', name: name }); 
            res.json({ success: true, token }); 
        } else { res.json({ success: false, message: '로그인 실패' }); } 
    } catch (e) { res.status(500).json({ success: false, message: 'Error' }); } 
});

app.post('/save-progress', requireAuth, async (req, res) => {
    const formData = req.body;
    const studentName = req.user.name;
    try {
        const ALLOWED_PROPS = { 
            "⭕ 지난 문법 숙제 검사": "⭕ 지난 문법 숙제 검사", "1️⃣ 어휘 클카 암기 숙제": "1️⃣ 어휘 클카 암기 숙제", "2️⃣ 독해 단어 클카 숙제": "2️⃣ 독해 단어 클카 숙제", 
            "4️⃣ Summary 숙제": "4️⃣ Summary 숙제", "5️⃣ 매일 독해 숙제": "5️⃣ 독해서 풀기", "5️⃣ 독해서 풀기 숙제": "5️⃣ 독해서 풀기", "6️⃣ 영어일기 or 개인 독해서": "6️⃣ 부&매&일",
            "단어(맞은 개수)": "단어(맞은 개수)", "단어(전체 개수)": "단어(전체 개수)", "어휘유닛": "어휘유닛", 
            "문법(전체 개수)": "문법(전체 개수)", "문법(틀린 개수)": "문법(틀린 개수)", "독해(틀린 개수)": "독해(틀린 개수)", "독해 하브루타": "독해 하브루타",
            "영어 더빙 학습": "영어 더빙 학습 완료", "더빙 워크북": "더빙 워크북 완료", "📖 영어독서": "📖 영어독서", 
            "어휘학습": "어휘학습", "Writing": "Writing", "완료 여부": "📕 책 읽는 거인", "오늘의 소감": "오늘의 학습 소감",
            "grammarImage": "문법 인증샷", "summaryImage": "Summary 인증샷", "readingImage": "독해서 인증샷", "diaryImage": "부매일 인증샷"
        };
        const valueMapping = { "해당없음": "숙제 없음", "안 해옴": "안 해옴", "숙제 함": "숙제 함", "진행하지 않음": "진행하지 않음", "완료": "완료", "미완료": "미완료", "원서독서로 대체": "원서독서로 대체", "듣기평가교재 완료": "듣기평가교재 완료", "못함": "못함", "완료함": "완료함", "SKIP": "SKIP", "안함": "안함", "숙제없음": "숙제없음", "못하고감": "못하고감", "시작함": "시작함", "절반": "절반", "거의다읽음": "거의다읽음" };
        const properties = {};
        
        for (let key in formData) { 
            if (key === 'englishBooks' || key === 'koreanBooks') continue; 
            if (!ALLOWED_PROPS.hasOwnProperty(key)) continue; 
            let rawValue = formData[key]; 
            if (rawValue === undefined || rawValue === '') continue; 
            let value = valueMapping[rawValue] || rawValue; 
            const notionPropName = ALLOWED_PROPS[key]; 
            
            if (['단어(맞은 개수)', '단어(전체 개수)', '문법(전체 개수)', '문법(틀린 개수)', '독해(틀린 개수)'].includes(notionPropName)) { 
                const numVal = Number(value); properties[notionPropName] = { number: isNaN(numVal) ? 0 : numVal }; 
            } else if (['독해 하브루타', '📖 영어독서', '어휘학습', 'Writing', '📕 책 읽는 거인'].includes(notionPropName)) { 
                properties[notionPropName] = { select: { name: value } }; 
            } else if (['어휘유닛', '오늘의 학습 소감'].includes(notionPropName)) { 
                properties[notionPropName] = { rich_text: [{ text: { content: value } }] }; 
            } else if (['문법 인증샷', 'Summary 인증샷', '독해서 인증샷', '부매일 인증샷'].includes(notionPropName)) {
                if (value) properties[notionPropName] = { files: [{ name: "인증샷", external: { url: value } }] };
            } else { properties[notionPropName] = { status: { name: value } }; } 
        }
        
        if (formData.englishBooks && Array.isArray(formData.englishBooks)) { properties['오늘 읽은 영어 책'] = await processBookRelations(formData.englishBooks, ENG_BOOKS_ID, 'Title'); }
        if (formData.koreanBooks && Array.isArray(formData.koreanBooks)) { properties['국어 독서 제목'] = await processBookRelations(formData.koreanBooks, KOR_BOOKS_ID, '책제목'); }
        
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '이름', title: { equals: studentName } }, { property: '🕐 날짜', date: { equals: dateString } } ] };
        
        const existingPageQuery = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter, page_size: 1 }) });
        
        if (existingPageQuery.results.length > 0) { 
            await fetchNotion(`https://api.notion.com/v1/pages/${existingPageQuery.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) }); 
        } else { 
            properties['이름'] = { title: [{ text: { content: studentName } }] }; 
            properties['🕐 날짜'] = { date: { start: dateString } }; 
            const studentPageId = await findPageIdByTitle(STUDENT_DATABASE_ID, studentName, '이름'); 
            if (studentPageId) properties['학생'] = { relation: [{ id: studentPageId }] }; 
            await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: PROGRESS_DATABASE_ID }, properties }) }); 
        }

        // [추가됨] 학생이 진도를 저장하면 대시보드 캐시 무효화
        dashboardCache.dailyReport.lastFetch = 0;
        dashboardCache.pastGrammar.lastFetch = 0;

        res.json({ success: true, message: '저장 완료' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

let reportTemplate = '';
try { reportTemplate = fs.readFileSync(path.join(publicPath, 'views', 'dailyreport.html'), 'utf-8'); } 
catch (e) { console.error('Template load error', e); }

function getReportColor(value, type) {
    const GREEN = '#10b981'; const RED = '#ef4444'; const GRAY = '#9ca3af';
    if (value === 'N/A' || value === '없음' || value === '시험 보지 않음' || value === null || value === undefined || value === '') return GRAY;
    if (type === 'score') { const num = parseInt(value); if (isNaN(num)) return GRAY; return (num >= 80) ? GREEN : RED; }
    if (type === 'test_score') { const num = parseInt(value); if (isNaN(num)) return GRAY; if (num === 0) return GRAY; return (num >= 80) ? GREEN : RED; }
    if (type === 'result') { if (value === 'PASS') return GREEN; if (value === 'FAIL') return RED; return GRAY; }
    if (type === 'status') { if (value === '완료' || value === '완료함') return GREEN; if (value === '미완료' || value === '못함' || value === '안 해옴') return RED; return GRAY; }
    if (type === 'hw_detail') { if (value === '숙제 함') return GREEN; if (value === '안 해옴') return RED; return GRAY; }
    return GRAY;
}

app.get('/report', async (req, res) => {
    const { pageId, date } = req.query;
    if (!pageId) return res.status(400).send('Missing info');
    try {
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsed = await parseDailyReportData(page);
        let html = reportTemplate;
        const bookTitleStr = parsed.reading.englishBooks && parsed.reading.englishBooks.length > 0 ? parsed.reading.englishBooks.map(b => b.title).join(', ') : (parsed.reading.bookTitle || '읽은 책 없음');
        
        const formatTestScore = (val) => {
            if (val === '시험 보지 않음') return val;
            if (val === 0 || val === null) return '없음';
            return val + '점';
        };

        // [신규] 담당 선생님 이름 추출 로직
        const teacherNameStr = parsed.teachers && parsed.teachers.length > 0 ? parsed.teachers.join(', ') : '미배정';

        const replacements = {
            '{{STUDENT_NAME}}': parsed.studentName, 
            '{{REPORT_DATE}}': getKoreanDate(parsed.date),
            '{{TEACHER_NAME}}': teacherNameStr, // [신규] 리포트 HTML에 들어갈 데이터 연동
            '{{TEACHER_COMMENT}}': parsed.comment.teacherComment.replace(/\n/g, '<br>'),
            '{{HW_SCORE}}': parsed.completionRate === null ? '없음' : parsed.completionRate + '%', '{{HW_SCORE_COLOR}}': getReportColor(parsed.completionRate, 'score'),
            '{{GRAMMAR_SCORE}}': formatTestScore(parsed.tests.grammarScore), '{{GRAMMAR_SCORE_COLOR}}': getReportColor(parsed.tests.grammarScore, 'test_score'),
            '{{VOCAB_SCORE}}': formatTestScore(parsed.tests.vocabScore), '{{VOCAB_SCORE_COLOR}}': getReportColor(parsed.tests.vocabScore, 'test_score'),
            '{{READING_TEST_STATUS}}': parsed.tests.readingResult, '{{READING_TEST_COLOR}}': getReportColor(parsed.tests.readingResult, 'result'),
            '{{LISTENING_STATUS}}': parsed.listening.study, '{{LISTENING_COLOR}}': getReportColor(parsed.listening.study, 'status'),
            '{{LISTENING_FONT_CLASS}}': (parsed.listening.study && parsed.listening.study.length > 5) ? 'text-lg' : 'text-4xl',
            '{{READING_BOOK_STATUS}}': parsed.reading.readingStatus, '{{READING_BOOK_COLOR}}': getReportColor(parsed.reading.readingStatus, 'status'),
            '{{HW_GRAMMAR_STATUS}}': parsed.homework.grammar, '{{HW_GRAMMAR_COLOR}}': getReportColor(parsed.homework.grammar, 'hw_detail'),
            '{{HW_VOCAB_STATUS}}': parsed.homework.vocabCards, '{{HW_VOCAB_COLOR}}': getReportColor(parsed.homework.vocabCards, 'hw_detail'),
            '{{HW_READING_CARD_STATUS}}': parsed.homework.readingCards, '{{HW_READING_CARD_COLOR}}': getReportColor(parsed.homework.readingCards, 'hw_detail'),
            '{{HW_SUMMARY_STATUS}}': parsed.homework.summary, '{{HW_SUMMARY_COLOR}}': getReportColor(parsed.homework.summary, 'hw_detail'),
            '{{HW_DIARY_STATUS}}': parsed.homework.diary, '{{HW_DIARY_COLOR}}': getReportColor(parsed.homework.diary, 'hw_detail'),
            '{{GRAMMAR_CLASS_TOPIC}}': parsed.comment.grammarTopic, '{{GRAMMAR_HW_DETAIL}}': parsed.comment.grammarHomework,
            '{{BOOK_TITLE}}': bookTitleStr, '{{BOOK_LEVEL}}': (parsed.reading.bookAR || parsed.reading.bookLexile) ? `${parsed.reading.bookAR || 'N/A'} / ${parsed.reading.bookLexile || 'N/A'}` : 'N/A',
            '{{WRITING_STATUS}}': parsed.reading.writingStatus, '{{RD_CHECK_POINT_SCORE}}': parsed.completionRate !== null ? parsed.completionRate : '없음'
        };
        
        for (const [key, val] of Object.entries(replacements)) {
            const displayVal = (val === null || val === undefined || val === '') ? '없음' : val;
            html = html.split(key).join(displayVal);
        }
        res.send(html);
    } catch (e) { res.status(500).send('Report Error'); }
});

app.get('/api/admin/regenerate-urls', requireAuth, async (req, res) => {
    if (req.user.role !== 'manager') return res.status(403).json({ success: false, message: '관리자 권한이 필요합니다.' });
    const { date } = req.query; 
    if (!date) return res.status(400).json({ success: false, message: '날짜가 필요합니다.' });

    try {
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: date } } ] };
        let hasMore = true; let startCursor = undefined; let processedCount = 0;

        while (hasMore) {
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { 
                method: 'POST', body: JSON.stringify({ filter: filter, page_size: 100, start_cursor: startCursor }) 
            });

            for (const page of data.results) {
                const cleanDomain = DOMAIN_URL.replace(/^https?:\/\//, '');
                const url = `${cleanDomain}/report?pageId=${page.id}&date=${date}`;
                if (page.properties['데일리리포트URL']?.url === url) continue;
                await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) });
                processedCount++;
            }
            hasMore = data.has_more; startCursor = data.next_cursor;
        }
        res.json({ success: true, message: `${date} 리포트 URL ${processedCount}개 업데이트 완료` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

cron.schedule('0 22 * * *', async () => {
    try {
        const { start, end, dateString } = getKSTTodayRange();
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: dateString } } ] };
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: filter }) });
        for (const page of data.results) {
            const cleanDomain = DOMAIN_URL.replace(/^https?:\/\//, '');
            const url = `${cleanDomain}/report?pageId=${page.id}&date=${dateString}`;
            if (page.properties['데일리리포트URL']?.url === url) continue;
            await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { '데일리리포트URL': { url } } }) });
        }
    } catch (e) { console.error('Cron Error', e); }
}, { timezone: "Asia/Seoul" });

// [신규] 코멘트 작성완료 체크/해제 + 작성완료시각 기록
// completed=true  → 작성완료=true, 작성완료시각=현재 한국시간
// completed=false → 작성완료=false, 작성완료시각=비움 (되돌리기)
app.post('/api/set-write-complete', requireAuth, async (req, res) => {
    const { pageId, completed } = req.body;
    if (!pageId) return res.status(400).json({ success: false, message: 'Missing pageId' });

    try {
        const properties = { '작성완료': { checkbox: !!completed } };
        if (completed) {
            // UTC에 9시간 더해 한국시간 벽시계로 만든 뒤 +09:00 오프셋 부여 (정확한 시각)
            const kstIso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
            properties['작성완료시각'] = { date: { start: kstIso } };
        } else {
            properties['작성완료시각'] = { date: null };
        }
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties })
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// [진도 관리] 교재 목록 캐시 + 진도설정 읽기/쓰기
// ============================================================
let textbookCache = { list: null, byId: {}, lastFetch: 0 };
const TEXTBOOK_CACHE_MS = 10 * 60 * 1000; // 10분 (교재는 거의 안 바뀌는 정적 데이터)

async function loadTextbooks(force = false) {
    if (!force && textbookCache.list && (Date.now() - textbookCache.lastFetch < TEXTBOOK_CACHE_MS)) {
        return textbookCache;
    }
    const list = [];
    const byId = {};
    let cursor = undefined, hasMore = true;
    while (hasMore) {
        const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${TEXTBOOK_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify(body)
        });
        for (const page of data.results) {
            const props = page.properties;
            const nameProp = Object.values(props).find(p => p.type === 'title');
            const name = nameProp?.title?.[0]?.plain_text || '';
            if (!name) continue;
            const subject = props['과목']?.select?.name || '';
            const item = { id: page.id, name, subject };
            list.push(item);
            byId[page.id] = item;
        }
        hasMore = data.has_more; cursor = data.next_cursor;
    }
    textbookCache = { list, byId, lastFetch: Date.now() };
    return textbookCache;
}

// 교재 목록 (드롭다운용)
app.get('/api/textbooks', requireAuth, async (req, res) => {
    try {
        if (!TEXTBOOK_DB_ID) return res.status(500).json({ success: false, message: 'TEXTBOOK_DB_ID 미설정' });
        const { list } = await loadTextbooks(req.query.force === 'true');
        res.json({ success: true, textbooks: list });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 학생별 진도 설정 읽기 (학생 명부 DB)
app.get('/api/progress-config-data', requireAuth, async (req, res) => {
    try {
        let byId = {};
        try { byId = (await loadTextbooks()).byId; } catch (e) { /* 교재 못 읽어도 진행 */ }
        const relName = (prop) => (prop?.relation?.map(r => byId[r.id]?.name || '').filter(Boolean).join(', ')) || '';
        const relId = (prop) => prop?.relation?.[0]?.id || '';

        const students = [];
        let cursor = undefined, hasMore = true;
        while (hasMore) {
            const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
                method: 'POST', body: JSON.stringify(body)
            });
            for (const page of data.results) {
                const p = page.properties;
                students.push({
                    pageId: page.id,
                    name: p['이름']?.title?.[0]?.plain_text || '이름없음',
                    teachers: p['담당쌤']?.multi_select?.map(t => t.name) || [],
                    days: p['수강요일']?.multi_select?.map(d => d.name).join('') || '',
                    status: p['학습상태']?.select?.name || '',
                    fixed: p['고정숙제']?.rich_text?.map(t => t.plain_text).join('') || '',
                    vocab: { bookId: relId(p['어휘교재']),   bookName: relName(p['어휘교재']),   unit: p['어휘현재유닛']?.number ?? '',   amount: p['어휘진도량']?.number ?? '' },
                    mainR: { bookId: relId(p['주독해교재']), bookName: relName(p['주독해교재']), unit: p['주독해현재유닛']?.number ?? '', amount: p['주독해진도량']?.number ?? '' },
                    subR:  { bookId: relId(p['부독해교재']), bookName: relName(p['부독해교재']), unit: p['부독해현재유닛']?.number ?? '', amount: p['부독해진도량']?.number ?? '' },
                });
            }
            hasMore = data.has_more; cursor = data.next_cursor;
        }
        res.json({ success: true, students });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 학생 진도 설정 1개 항목 수정 (학생 명부 DB 페이지 PATCH)
app.post('/api/update-student-progress', requireAuth, async (req, res) => {
    const { pageId, propertyName, value, propertyType } = req.body;
    if (!pageId || !propertyName) return res.status(400).json({ success: false, message: 'Missing info' });
    try {
        let propValue;
        if (propertyType === 'relation') {
            propValue = { relation: value ? [{ id: value }] : [] };
        } else if (propertyType === 'number') {
            propValue = { number: (value === '' || value === null || value === undefined) ? null : Number(value) };
        } else if (propertyType === 'select') {
            propValue = { select: value ? { name: value } : null };
        } else { // rich_text
            propValue = { rich_text: value ? [{ text: { content: String(value).substring(0, 2000) } }] : [] };
        }
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, {
            method: 'PATCH', body: JSON.stringify({ properties: { [propertyName]: propValue } })
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/planner-test', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner-test.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Final Server running on ${PORT}`));