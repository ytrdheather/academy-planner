import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';

// [모듈 Import]
import { initializeMonthlyReportRoutes } from './monthlyReportModule.js';
import { initializeBookRoutes, processBookRelations } from './bookModule.js';
import { initializeExamAnalyzerRoutes } from './examAnalyzerModule.js';
import Holidays from 'date-holidays';

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
    TEXTBOOK_UNIT_DB_ID,
    EXAM_DB_ID,
    QUESTION_DB_ID,
    STUDENT_RESULT_DB_ID,
    STUDENT_ANSWER_DB_ID,
} = process.env;

// 숙제 정지 기간 DB (전역 숙제 생성 킬스위치). env 없으면 생성해둔 DB로 폴백 → Render env 추가 없이도 동작.
const PAUSE_DB_ID = process.env.PAUSE_DB_ID || '39e09320-bce2-8115-aa02-f03fabca5433';

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
// 선생님은 24시간(공용 PC 대비 짧게), 학생은 30일.
// 학생은 개인 폰에 앱처럼 깔아 쓰기 때문에 매일 로그인시키면 안 씀.
function generateToken(userData) {
    const expiresIn = userData.role === 'student' ? '30d' : '24h';
    return jwt.sign(userData, JWT_SECRET, { expiresIn });
}
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
app.use(express.json({ limit: '25mb' })); // 목차 스크린샷(base64) 업로드 대응
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
app.get('/manual', (req, res) => res.sendFile(path.join(publicPath, 'views', 'manual.html')));
// 학생·학부모에게 그대로 공유하는 설치 안내(설치 방법만 담김). /manual은 선생님용 내용이 함께 있어 공유용으로 쓰지 않는다.
app.get('/install', (req, res) => res.sendFile(path.join(publicPath, 'views', 'install.html')));
// 신규 등록생 학부모께 카톡으로 보내는 등록 전 안내서.
// 학생별 아이디는 URL의 # 뒤에 실려 오므로(서버로 전송되지 않음) 여기서는 정적 파일만 내려준다.
app.get('/welcome', (req, res) => res.sendFile(path.join(publicPath, 'views', 'welcome.html')));
// 학부모께 실제로 보내는 짧은 주소. 아이디는 페이지가 열린 뒤 서버에서 받아오므로 주소에 담기지 않는다.
app.get('/w/:code', (req, res) => res.sendFile(path.join(publicPath, 'views', 'welcome.html')));
// 위 안내서 링크를 학생별로 만들어 주는 원장·선생님용 도구
app.get('/welcome-admin', (req, res) => res.sendFile(path.join(publicPath, 'views', 'welcome-admin.html')));

app.get('/past-grammar', (req, res) => res.sendFile(path.join(publicPath, 'views', 'past-grammar.html')));
app.get('/exam-analyzer', (req, res) => res.sendFile(path.join(publicPath, 'views', 'exam-analyzer.html')));
app.get('/student-grader', (req, res) => res.sendFile(path.join(publicPath, 'views', 'student-grader.html')));
app.get('/results-viewer', (req, res) => res.sendFile(path.join(publicPath, 'views', 'results-viewer.html')));
app.get('/student-report', (req, res) => res.sendFile(path.join(publicPath, 'views', 'student-report.html')));

app.use('/assets', express.static(path.join(publicPath, 'assets')));

// [PWA] 학생이 폰 홈 화면에 앱처럼 설치할 수 있게 하는 파일들.
// 서비스워커는 반드시 루트(/sw.js)에서 내려줘야 사이트 전체를 scope로 잡습니다.
app.get('/manifest.json', (req, res) => res.sendFile(path.join(publicPath, 'manifest.json')));
app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache'); // 서비스워커 자체는 캐시 금지 → 배포하면 바로 갱신됨
    res.sendFile(path.join(publicPath, 'sw.js'));
});

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

// [신규] 반 공통 문법 코멘트 생성 — 오늘의 코멘트와 동일한 전문가 톤 규칙.
// 단, 반 전체에 공통으로 들어가므로 학생 이름/호칭/점수/숙제/인사말 없이 '문법 수업 서술'만 생성한다.
app.post('/api/generate-grammar-comment', requireAuth, async (req, res) => {
    const { keywords, className } = req.body;
    if (!keywords) return res.status(400).json({ success: false, message: 'Missing keywords' });
    if (!geminiModel) return res.status(500).json({ success: false, message: 'AI not configured' });

    try {
        const prompt = `
        너는 '리디튜드' 영어학원의 경력 많은 담임 선생님이다. ${className ? `'${className}' 반의 ` : ''}오늘 문법 수업 내용을 학부모님께 전하는 '문법 코멘트' 한 단락을 작성한다. 이 글은 그 반 모든 학생의 일일 리포트 맨 앞(인사말 다음)에 공통으로 들어간다.

        [말투 — 가장 중요]
        - 학습 전문가(담임 교사)의 정중하고 담담한 문어체. 모든 문장을 '~습니다 / ~합니다 / ~였습니다 / ~예정입니다' 같은 '~니다' 체로 끝맺는다. '~요'로 끝나는 문장은 한 문장도 쓰지 않는다.
        - 절대 금지(유치원 선생님·아기자기 말투): '~한답니다 / ~이에요 / ~거예요 / ~같아요!' 류 어미, 감탄사, 느낌표(!). 느낌표는 한 개도 쓰지 않는다.
        - 감정 과잉·미화 금지. 사실에 근거한 관찰과 지도 계획을 담담하게 서술한다.

        [내용 규칙]
        - 아래 키워드에 담긴 내용을 하나도 빠뜨리지 말고 자연스럽게 이어지는 하나의 단락으로 풀어 쓴다. 접속어("그리고, ~하며, 이어서, 다만")로 부드럽게 연결한다.
        - 사실 왜곡·과장 금지. 키워드에 없는 내용은 지어내지 않는다. "~까지 ~해오기"는 앞으로의 숙제 부여이지 완료된 일이 아니다.
        - 이 코멘트는 '반 전체 공통'이다. 특정 학생 이름·호칭·개인 점수·개인 숙제 수행 여부는 절대 쓰지 않는다.
        - 인사말("~리포트를 보내드립니다")·제목·머리말 없이, 문법 수업 서술 본문만 출력한다. 별표(*)·따옴표(') 강조 금지.

        [입력 키워드(선생님 메모)]
        ${keywords}

        [좋은 예시]
        오늘은 to부정사의 명사적 용법을 배우고, 배운 개념을 예문에 직접 적용해 보는 연습을 진행했습니다. 처음에는 주어 자리와 목적어 자리를 구분하는 데 시간이 다소 걸렸으나, 반복 연습을 통해 점차 익숙해지는 모습이었습니다. 다음 시간에는 형용사적 용법으로 이어가며 문장 속에서의 쓰임을 넓혀갈 예정입니다.
        `;

        const result = await geminiModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.72, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 1024 } }
        });
        const commentText = result.response.text().trim();
        res.json({ success: true, comment: commentText });
    } catch (error) {
        console.error('Grammar Comment AI Error:', error);
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

    // [신규] 학습상태 (명부 롤업) — 정상이 아니면 숙제정지·누락제외·상태배지
    let learningStatus = '';
    const statusRollup = props['학습상태']?.rollup?.array;
    if (statusRollup && statusRollup[0]?.select) learningStatus = statusRollup[0].select.name;

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

    return { pageId: page.id, studentName, attendanceDays, learningStatus, date: pageDate, teachers: assignedTeachers, completionRate: performanceRate, homework, assignedHw, tests, listening, reading, comment };
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

// 학생 명부에서 이름→학습상태 맵만 가볍게 읽어오기 (일일행에는 학습상태가 없어 조인용)
async function readStudentStatusMap(nameFilter) {
    const map = {};
    let cursor = undefined, hasMore = true;
    while (hasMore) {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        if (nameFilter) body.filter = { property: '이름', title: { equals: nameFilter } };
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST', body: JSON.stringify(body)
        });
        for (const page of data.results) {
            const name = page.properties['이름']?.title?.[0]?.plain_text || '';
            if (name) map[name] = page.properties['학습상태']?.select?.name || '';
        }
        hasMore = data.has_more; cursor = data.next_cursor;
    }
    return map;
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

        // 일일행에는 학습상태가 없으므로 명부에서 이름으로 조인 (병결/여행휴가/휴원 등 배지·누락점검 제외용)
        try {
            const statusMap = await readStudentStatusMap();
            data.forEach(st => { st.learningStatus = statusMap[st.studentName] || ''; });
        } catch (e) { console.error('학습상태 조인 실패:', e.message); }

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
        try {
            const statusMap = await readStudentStatusMap(parsedData.studentName);
            parsedData.learningStatus = statusMap[parsedData.studentName] || '';
        } catch (e) { console.error('학습상태 조인 실패(단건):', e.message); }
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
        // 선생님 코멘트는 학부모용이므로 학생 플래너 응답에서 제거.
        // (화면에서 안 그리는 것만으로는 개발자도구/네트워크 탭에서 그대로 보임)
        delete progress['❤ Today\'s Notice!'];
        delete progress['Today\'s Notice!'];

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

        // [수정] getKSTTodayRange().start는 KST 자정의 UTC 값(=하루 전 15:00Z)이라
        //        .split('T')[0]하면 오늘이 아니라 어제가 나오는 버그가 있었음. dateString(KST 오늘)을 기준으로 계산.
        const { dateString: kstTodayStr } = getKSTTodayRange();
        const end = kstTodayStr;

        const startDate = new Date(`${kstTodayStr}T00:00:00.000Z`);
        startDate.setUTCDate(startDate.getUTCDate() - 8);
        const start = startDate.toISOString().split('T')[0];

        const filter = {
            and: [
                { property: '🕐 날짜', date: { on_or_after: start } },
                { property: '🕐 날짜', date: { on_or_before: end } }
            ]
        };

        // [수정] 노션은 1회 최대 100건만 반환. 이전엔 page_size:100 단일 호출이라
        //        내림차순 정렬상 최신(월수금) 날짜가 100건을 채우고 화·목 등 오래된 날짜가 잘려나갔음.
        //        has_more/next_cursor로 전량 수집하도록 페이지네이션 추가.
        const allResults = [];
        let startCursor = undefined;
        let hasMore = true;
        while (hasMore) {
            const page = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter, sorts: [{ property: '🕐 날짜', direction: 'descending' }], page_size: 100, start_cursor: startCursor })
            });
            allResults.push(...page.results);
            hasMore = page.has_more;
            startCursor = page.next_cursor;
        }
        const query = { results: allResults };

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

// [신규] 문법 코멘트만 저장 (진도/과제/테스트는 건드리지 않음) — 미니 모달용
// GRAMMAR_DB 원장에 (반,날짜) upsert(코멘트 필드만) + 그 반 PROGRESS 전원에 코멘트 투사
app.post('/api/update-grammar-comment-by-class', requireAuth, async (req, res) => {
    const { className, date, comment } = req.body;
    if (!className || !date) { return res.status(400).json({ success: false, message: 'Missing info' }); }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        // ① GRAMMAR_DB 원장 upsert — 코멘트 필드만 (기존 진도/과제/테스트 보존)
        if (GRAMMAR_DB_ID) {
            const commentProp = { '문법 코멘트': { rich_text: [{ text: { content: comment || '' } }] } };
            const gFilter = { "and": [
                { property: '반이름', select: { equals: className } },
                { property: '날짜', date: { equals: date } }
            ]};
            const existing = await fetchNotion(`https://api.notion.com/v1/databases/${GRAMMAR_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ filter: gFilter, page_size: 1 }) });
            if (existing.results.length > 0) {
                await fetchNotion(`https://api.notion.com/v1/pages/${existing.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties: commentProp }) });
            } else {
                await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: GRAMMAR_DB_ID }, properties: {
                    '이름': { title: [{ text: { content: `${className}-${date}` } }] },
                    '반이름': { select: { name: className } },
                    '날짜': { date: { start: date } },
                    ...commentProp
                } }) });
            }
        }

        // ② 그 반 PROGRESS 그날 행 전원에 코멘트 투사
        const filter = { "and": [ { property: '🕐 날짜', date: { equals: date } } ] };
        const query = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify({ filter }) });
        const targetStudents = query.results.filter(page => {
            const studentClass = getRollupValue(page.properties['문법클래스']);
            return studentClass && studentClass.trim() === className.trim();
        });

        if (targetStudents.length === 0) {
            res.write(JSON.stringify({ success: false, message: '해당 반의 학생 데이터를 찾을 수 없습니다.' }) + '\n');
            return res.end();
        }

        let updatedCount = 0;
        for (const page of targetStudents) {
            await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties: { '문법 코멘트': { rich_text: [{ text: { content: comment || '' } }] } } })
            });
            updatedCount++;
            res.write(JSON.stringify({ progress: updatedCount, total: targetStudents.length }) + '\n');
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (typeof dashboardCache !== 'undefined') {
            dashboardCache.dailyReport.lastFetch = 0;
        }

        res.write(JSON.stringify({ success: true, message: `문법 코멘트 저장 완료 (${updatedCount}명 반영)` }) + '\n');
        res.end();
    } catch (error) {
        console.error('Grammar Comment Save Error:', error);
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

        // 결석 사유를 새로 적으면(= 결석 처리) 11시에 미리 만들어둔 그날 숙제를 되돌린다.
        // 사유를 지우는 경우(빈 값)엔 아무 것도 하지 않음 — 숙제는 '🔮 생성'으로 다시 만들면 된다.
        let absenceRollback = null;
        const absenceVal = propertiesToUpdate['결석 사유']?.rich_text?.[0]?.text?.content;
        if (absenceVal && String(absenceVal).trim()) {
            try { absenceRollback = await rollbackHomeworkForAbsence(pageId); }
            catch (e) { console.error('결석 롤백 실패', e); }   // 결석사유 저장 자체는 이미 끝났으므로 실패해도 200
        }

        res.json({ success: true, absenceRollback });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/teachers', requireAuth, async (req, res) => { const list = Object.values(userAccounts).filter(a => a.role === 'teacher' || a.role === 'manager').map(a => ({ name: a.name })); res.json(list); });
app.post('/teacher-login', async (req, res) => { const { teacherId, teacherPassword } = req.body; const account = userAccounts[teacherId]; if (account && account.password === teacherPassword) { const token = generateToken({ loginId: teacherId, name: account.name, role: account.role }); res.json({ success: true, token }); } else { res.status(401).json({ success: false, message: 'Invalid credentials' }); } });
app.get('/api/teacher/user-info', requireAuth, (req, res) => { res.json({ userName: req.user.name, userRole: req.user.role, loginId: req.user.loginId }); });
app.get('/api/user-info', requireAuth, (req, res) => { res.json({ userId: req.user.userId, userName: req.user.name, userRole: req.user.role }); });
app.get('/api/student-info', requireAuth, (req, res) => { if (req.user.role !== 'student') return res.status(401).json({ error: 'Students only' }); res.json({ studentId: req.user.userId, studentName: req.user.name }); });

// ── 학생이 쓰는 학습 사이트 아이디·비번 ──
// 학생 명부의 속성에서 그대로 읽어온다. 칸이 없는 프로그램은 조용히 건너뛰므로,
// 노션에 아래 이름으로 칸만 만들면 코드를 고치지 않아도 리디플랜에 바로 뜬다.
// editable: 노션에서 수식이 아니라 직접 입력하는 칸이라 리디플랜에서 저장할 수 있다는 뜻.
// 수식 칸(넬트·클래스카드·클래스5)은 노션이 자동 계산하므로 쓰기를 시도해서는 안 된다.
const PROGRAM_ACCOUNTS = [
    { key: 'nelt', name: '넬트 / 교재성취 TEST', idProp: '넬트/교재성취 ID', pwProp: '넬트/교재성취 PW', site: '' },
    { key: 'cc',   name: '클래스카드',            idProp: '클래스카드 ID',    pwProp: '클래스카드 PW',    site: 'https://www.classcard.net/Login' },
    { key: 'c5',   name: '클래스5',               idProp: '클래스5 ID',       pwProp: '클래스5 PW',       site: 'https://www.classmovie.co.kr/main' },
    { key: 'rv',   name: '리도보카',              idProp: '리도보카 ID',      pwProp: '리도보카 PW',      site: '', editable: true }
];

// 노션 속성은 수식·텍스트·숫자 등 타입이 제각각이라 무엇이 오든 문자열로 뽑아낸다.
function readNotionText(prop) {
    if (!prop) return '';
    switch (prop.type) {
        case 'formula':   return String(prop.formula?.string ?? prop.formula?.number ?? '').trim();
        case 'rich_text': return (prop.rich_text || []).map(t => t.plain_text).join('').trim();
        case 'title':     return (prop.title || []).map(t => t.plain_text).join('').trim();
        case 'number':    return prop.number == null ? '' : String(prop.number);
        case 'select':    return prop.select?.name || '';
        case 'rollup':    return readNotionText(prop.rollup?.array?.[0]);
        default:          return '';
    }
}

// ── 학부모께 보내는 짧은 안내서 주소 (/w/<학생ID><서명>) ──
// 학생 ID만 쓰면 뒷번호를 바꿔가며 남의 아이 아이디를 볼 수 있으므로 서명을 붙인다.
// 서명 확인은 서버에서만 되고, 틀리면 노션을 조회하기 전에 막힌다.
const WELCOME_SIG_LEN = 10;

function welcomeSign(studentId) {
    return crypto.createHmac('sha256', JWT_SECRET)
        .update('welcome:' + studentId)
        .digest('hex')
        .slice(0, WELCOME_SIG_LEN);
}

function welcomeCode(studentId) {
    return studentId + welcomeSign(studentId);
}

// 코드가 올바르면 학생 ID를, 아니면 빈 문자열을 돌려준다
function readWelcomeCode(code) {
    const raw = (code || '').trim();
    if (raw.length <= WELCOME_SIG_LEN) return '';
    const studentId = raw.slice(0, -WELCOME_SIG_LEN);
    const sig = raw.slice(-WELCOME_SIG_LEN);
    const want = welcomeSign(studentId);
    // 길이가 같아야 timingSafeEqual을 쓸 수 있다
    if (sig.length !== want.length) return '';
    const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    return ok ? studentId : '';
}

// 학부모용이라 로그인이 없다. 링크(=서명)를 가진 사람만 볼 수 있다.
app.get('/api/welcome-info/:code', async (req, res) => {
    const studentId = readWelcomeCode(req.params.code);
    if (!studentId) return res.status(404).json({ error: '잘못된 주소입니다' });

    try {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: { property: '학생 ID', rich_text: { equals: studentId } },
                page_size: 1
            })
        });
        if (!data.results?.length) return res.status(404).json({ error: '학생을 찾지 못했습니다' });

        const props = data.results[0].properties;
        const accounts = {};
        PROGRAM_ACCOUNTS.forEach(p => {
            const id = readNotionText(props[p.idProp]);
            const pw = readNotionText(props[p.pwProp]);
            if (id || pw) accounts[p.key] = { id, pw };
        });

        res.set('Cache-Control', 'no-store'); // 아이디가 들어 있으므로 캐시에 남기지 않는다
        res.json({ n: readNotionText(props['이름']), p: accounts });
    } catch (e) {
        console.error('welcome-info 조회 실패:', e);
        res.status(500).json({ error: '정보를 불러오지 못했습니다' });
    }
});

app.get('/api/my-accounts', requireAuth, async (req, res) => {
    if (req.user.role !== 'student') return res.status(401).json({ error: 'Students only' });
    try {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: { property: '학생 ID', rich_text: { equals: req.user.userId } },
                page_size: 1
            })
        });
        if (!data.results?.length) return res.json({ accounts: [] });

        const props = data.results[0].properties;
        const accounts = PROGRAM_ACCOUNTS.map(p => ({
            key: p.key,
            name: p.name,
            site: p.site,
            id: readNotionText(props[p.idProp]),
            pw: readNotionText(props[p.pwProp])
        })).filter(a => a.id || a.pw); // 아이디도 비번도 없으면 안 쓰는 프로그램으로 본다

        res.json({ accounts });
    } catch (e) {
        console.error('my-accounts 조회 실패:', e);
        res.status(500).json({ error: '아이디 정보를 불러오지 못했습니다' });
    }
});

// 등록 안내서 링크를 만들 때 학생을 찾아 아이디를 자동으로 채워 넣기 위한 검색.
// 손으로 다시 타이핑하면 노션 값과 달라지므로 반드시 노션에서 읽어온다.
app.get('/api/teacher/student-accounts', requireAuth, async (req, res) => {
    if (req.user.role === 'student') return res.status(401).json({ error: 'Teachers only' });

    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json({ students: [] });

    try {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: { property: '이름', title: { contains: q } },
                sorts: [{ property: '이름', direction: 'ascending' }],
                page_size: 15
            })
        });

        const students = (data.results || []).map(page => {
            const props = page.properties;
            const accounts = {};
            PROGRAM_ACCOUNTS.forEach(p => {
                const id = readNotionText(props[p.idProp]);
                const pw = readNotionText(props[p.pwProp]);
                if (id || pw) accounts[p.key] = { id, pw };
            });
            const studentId = readNotionText(props['학생 ID']);
            return {
                name: readNotionText(props['이름']),
                studentId,
                // 학부모께 보낼 짧은 주소. 학생 ID가 없으면 만들 수 없다.
                code: studentId ? welcomeCode(studentId) : '',
                status: props['재원상태']?.select?.name || '',
                className: props['Class']?.select?.name || '',
                accounts
            };
        });

        res.json({ students });
    } catch (e) {
        console.error('student-accounts 검색 실패:', e);
        res.status(500).json({ error: '학생을 찾지 못했습니다' });
    }
});

// 직접 입력하는 아이디(리도보카)를 노션 학생 명부에 저장한다.
// 학생 명부는 원장님의 실제 기록이므로, 지정한 학생의 지정한 두 칸 외에는 절대 건드리지 않는다.
app.post('/api/teacher/save-account', requireAuth, async (req, res) => {
    if (req.user.role === 'student') return res.status(401).json({ error: 'Teachers only' });

    const { studentId, key } = req.body || {};
    const newId = (req.body?.id ?? '').toString().trim();
    const newPw = (req.body?.pw ?? '').toString().trim();

    const prog = PROGRAM_ACCOUNTS.find(p => p.key === key && p.editable);
    if (!prog) return res.status(400).json({ error: '저장할 수 없는 프로그램입니다' });
    if (!studentId) return res.status(400).json({ error: '학생을 먼저 선택해 주세요' });

    try {
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({
                filter: { property: '학생 ID', rich_text: { equals: studentId } },
                page_size: 2
            })
        });
        if (!data.results?.length) return res.status(404).json({ error: '학생을 찾지 못했습니다' });
        // 같은 학생 ID가 둘 이상이면 어느 쪽을 고쳐야 할지 알 수 없으므로 저장하지 않는다
        if (data.results.length > 1) return res.status(409).json({ error: '같은 학생 ID가 여러 개입니다. 노션에서 확인해 주세요' });

        const page = data.results[0];
        // 수식 칸에 쓰려 하면 노션이 거부한다. 그 전에 여기서 막는다.
        for (const propName of [prog.idProp, prog.pwProp]) {
            const type = page.properties[propName]?.type;
            if (type !== 'rich_text') {
                return res.status(400).json({ error: `'${propName}' 칸은 직접 입력할 수 없습니다` });
            }
        }

        const toRichText = (v) => ({ rich_text: v ? [{ text: { content: v } }] : [] });
        await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
                properties: {
                    [prog.idProp]: toRichText(newId),
                    [prog.pwProp]: toRichText(newPw)
                }
            })
        });

        const who = readNotionText(page.properties['이름']);
        console.log(`[아이디 저장] ${req.user.name} → ${who}(${studentId}) ${prog.name}`);
        res.json({ success: true, name: who });
    } catch (e) {
        console.error('save-account 저장 실패:', e);
        res.status(500).json({ error: '노션에 저장하지 못했습니다' });
    }
});
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

// 어휘/주독해/부독해 숙제를 학부모 리포트·학생앱에 노출할지 스위치.
// 2026-07-28부터 기본 켬. 교재 업데이트 검증이 끝났고, 무엇보다 이 필드는 자동 생성분만이 아니라
// 선생님이 출결·숙제 탭에서 직접 쓴 숙제도 담기 때문에 꺼두면 수기 입력분까지 학부모에게 안 나갔다.
// 끄려면 Render 환경변수 SHOW_GENERATED_HOMEWORK=false (코드 배포 불필요, 재시작만).
// ※ 문법 숙제는 이 스위치와 무관하게 항상 노출됨. 생성 엔진/저장/출결탭도 스위치와 무관하게 그대로 동작.
const SHOW_GENERATED_HOMEWORK = process.env.SHOW_GENERATED_HOMEWORK !== 'false';

// [신규] 진도 자동화로 설정된 "다음 숙제"(문법/어휘/주독해/부독해) 섹션 행 HTML을 조립.
// 데이터는 parseDailyReportData가 이미 읽어둠(comment.grammarTopic/grammarHomework, assignedHw.*).
// 교재가 없거나 내용이 비면 그 과목은 자동 생략. 전부 비면 안내 문구 한 줄.
function buildHomeworkRows(parsed) {
    const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const PLACEHOLDERS = ['없음', '숙제 내용 없음', '진도 해당 없음', '해당 없음', 'N/A'];
    const meaningful = (v) => {
        const c = (v || '').trim();
        return c && !PLACEHOLDERS.includes(c);
    };

    const rowShell = (icon, label, inner) => `
                <div class="hw-row">
                    <span class="hw-k">${icon} ${label}</span>
                    <div class="hw-v">${inner}</div>
                </div>`;

    const rows = [];

    // 문법: 진도(오늘 문법 진도) + 숙제 내용 두 줄
    const gTopic = parsed.comment.grammarTopic;
    const gDetail = parsed.comment.grammarHomework;
    if (meaningful(gTopic) || meaningful(gDetail)) {
        const line = (labelTxt, val) =>
            `<div class="hw-line"><span class="hw-sub">${labelTxt}</span><span>${escHtml(val.trim())}</span></div>`;
        let inner = '';
        if (meaningful(gTopic)) inner += line('진도', gTopic);
        if (meaningful(gDetail)) inner += line('숙제', gDetail);
        rows.push(rowShell('📑', '문법', inner));
    }

    // 어휘 / 주독해 / 부독해: 자동생성 숙제 내용 한 줄 (스위치가 켜졌을 때만 노출)
    if (SHOW_GENERATED_HOMEWORK) {
        const subjectRows = [
            ['📘', '어휘', parsed.assignedHw.vocab],
            ['📗', '주독해', parsed.assignedHw.mainR],
            ['📙', '부독해', parsed.assignedHw.subR],
        ];
        subjectRows.forEach(([icon, label, detail]) => {
            if (meaningful(detail)) rows.push(rowShell(icon, label, escHtml(detail.trim())));
        });
    }

    if (rows.length === 0) {
        return `<div class="hw-empty">설정된 다음 숙제가 없습니다.</div>`;
    }
    return rows.join('\n');
}

// 리포트 HTML 조립. forStudent=true면 dailyreport.html의 STUDENT_HIDE 마커 구간(선생님 코멘트)을 잘라냄.
// 학부모용 /report 와 학생용 /api/my-report 가 같은 템플릿·같은 계산식을 쓰도록 하나로 뽑아둔 함수.
function buildReportHtml(parsed, forStudent = false) {
        let html = reportTemplate;
        if (forStudent) {
            html = html.replace(/<!--\s*STUDENT_HIDE_START[\s\S]*?STUDENT_HIDE_END\s*-->/g, '');
        }
        const bookTitleStr = parsed.reading.englishBooks && parsed.reading.englishBooks.length > 0 ? parsed.reading.englishBooks.map(b => b.title).join(', ') : (parsed.reading.bookTitle || '읽은 책 없음');
        
        const formatTestScore = (val) => {
            if (val === '시험 보지 않음') return val;
            if (val === 0 || val === null) return '없음';
            const num = Number(val);
            if (!isNaN(num)) return Math.round(num) + '점'; // 공식값이 58.333… 같은 소수로 와도 정수로 반올림
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
            '{{HW_DAILY_READING_STATUS}}': parsed.homework.dailyReading, '{{HW_DAILY_READING_COLOR}}': getReportColor(parsed.homework.dailyReading, 'hw_detail'),
            '{{HW_DIARY_STATUS}}': parsed.homework.diary, '{{HW_DIARY_COLOR}}': getReportColor(parsed.homework.diary, 'hw_detail'),
            '{{HOMEWORK_ROWS}}': buildHomeworkRows(parsed),
            '{{BOOK_TITLE}}': bookTitleStr, '{{BOOK_LEVEL}}': (parsed.reading.bookAR || parsed.reading.bookLexile) ? `${parsed.reading.bookAR || 'N/A'} / ${parsed.reading.bookLexile || 'N/A'}` : 'N/A',
            '{{WRITING_STATUS}}': parsed.reading.writingStatus, '{{RD_CHECK_POINT_SCORE}}': parsed.completionRate !== null ? parsed.completionRate : '없음'
        };
        
        for (const [key, val] of Object.entries(replacements)) {
            const displayVal = (val === null || val === undefined || val === '') ? '없음' : val;
            html = html.split(key).join(displayVal);
        }
        return html;
}

app.get('/report', async (req, res) => {
    const { pageId } = req.query;
    if (!pageId) return res.status(400).send('Missing info');
    try {
        const page = await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`);
        const parsed = await parseDailyReportData(page);
        res.send(buildReportHtml(parsed, false));
    } catch (e) { res.status(500).send('Report Error'); }
});

// ==================================================================
// [학생용] 내 리포트 / 내 숙제
// 학부모용 /report 는 pageId만 알면 누구나 열리는 공개 링크라서 학생용으로 재사용하면 안 됨.
// 아래 API들은 전부 로그인 토큰의 이름(req.user.name)으로만 노션을 조회한다 → 남의 것 조회 불가.
// ==================================================================

function requireStudent(req, res, next) {
    if (req.user.role !== 'student') return res.status(403).json({ success: false, message: '학생 전용입니다' });
    next();
}

// 학생 본인의 진도 DB 행을 날짜 내림차순으로 가져오는 공통 조회
async function queryMyProgressRows(studentName, { limit = 30, onOrBefore = null } = {}) {
    const conditions = [{ property: '이름', title: { equals: studentName } }];
    if (onOrBefore) conditions.push({ property: '🕐 날짜', date: { on_or_before: onOrBefore } });

    const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({
            filter: { and: conditions },
            sorts: [{ property: '🕐 날짜', direction: 'descending' }],
            page_size: limit
        })
    });
    return data.results;
}

app.get('/my-report', (req, res) => res.sendFile(path.join(publicPath, 'views', 'my-report.html')));

// 리포트가 있는 날짜 목록 (최근 30일치) — 학생이 셀렉트박스에서 고를 수 있게
app.get('/api/my-report-dates', requireAuth, requireStudent, async (req, res) => {
    try {
        const rows = await queryMyProgressRows(req.user.name, { limit: 30 });
        const dates = rows
            .map(p => p.properties['🕐 날짜']?.date?.start)
            .filter(Boolean);
        res.json({ success: true, studentName: req.user.name, dates });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 학생 본인의 데일리 리포트 HTML (선생님 코멘트 섹션 제거된 버전)
app.get('/api/my-report', requireAuth, requireStudent, async (req, res) => {
    const { date } = req.query;
    try {
        const rows = await queryMyProgressRows(req.user.name, { limit: 1, onOrBefore: date || null });
        if (rows.length === 0) return res.status(404).send('리포트가 없습니다.');

        // 날짜를 지정했는데 그 날 행이 없으면(=그 이전 행이 잡히면) 없는 걸로 처리. 엉뚱한 날짜 리포트 방지.
        const rowDate = rows[0].properties['🕐 날짜']?.date?.start;
        if (date && rowDate !== date) return res.status(404).send('그 날짜의 리포트가 없습니다.');

        const parsed = await parseDailyReportData(rows[0]);
        res.set('Cache-Control', 'no-store');
        res.send(buildReportHtml(parsed, true));
    } catch (e) { res.status(500).send('Report Error'); }
});

// 학생 본인에게 부여된 "다음 숙제". 오늘 수업 행이 아직 없을 수 있으므로
// 최근 행부터 훑어서 숙제 내용이 실제로 채워진 가장 마지막 수업을 찾아 돌려준다.
app.get('/api/my-homework', requireAuth, requireStudent, async (req, res) => {
    const PLACEHOLDERS = ['없음', '숙제 내용 없음', '진도 해당 없음', '해당 없음', 'N/A'];
    const meaningful = (v) => {
        const c = (v || '').trim();
        return !!c && !PLACEHOLDERS.includes(c);
    };

    try {
        const rows = await queryMyProgressRows(req.user.name, { limit: 10 });

        for (const row of rows) {
            const props = row.properties;
            const hw = {
                date: props['🕐 날짜']?.date?.start || '',
                grammarTopic: getSimpleText(props['오늘 문법 진도']),
                grammar: getSimpleText(props['문법 숙제 내용']) || getSimpleText(props['문법 과제 내용']),
                vocab: getSimpleText(props['어휘숙제']),
                mainR: getSimpleText(props['주독해숙제']),
                subR: getSimpleText(props['부독해숙제'])
            };

            // 자동생성 숙제(어휘/주독해/부독해)는 학부모 리포트와 동일한 스위치를 따른다.
            if (!SHOW_GENERATED_HOMEWORK) { hw.vocab = ''; hw.mainR = ''; hw.subR = ''; }

            const items = [];
            if (meaningful(hw.grammarTopic) || meaningful(hw.grammar)) {
                items.push({
                    icon: '📑', subject: '문법',
                    lines: [
                        meaningful(hw.grammarTopic) ? { label: '진도', text: hw.grammarTopic.trim() } : null,
                        meaningful(hw.grammar) ? { label: '숙제', text: hw.grammar.trim() } : null
                    ].filter(Boolean)
                });
            }
            [['📘', '어휘', hw.vocab], ['📗', '주독해', hw.mainR], ['📙', '부독해', hw.subR]].forEach(([icon, subject, detail]) => {
                if (meaningful(detail)) items.push({ icon, subject, lines: [{ label: '숙제', text: detail.trim() }] });
            });

            if (items.length > 0) return res.json({ success: true, date: hw.date, items });
        }

        res.json({ success: true, date: null, items: [] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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

// ------------------------------------------------------------------
// [신규] 데일리 리포트 자동 생성 (Make 시나리오 대체)
// 학생 명부에서 오늘 수강요일인 재원생을 골라, 학습진도 DB에
// 이름·날짜·학생 relation만 채운 페이지를 만든다 (나머지는 롤업/수식/기본값).
// 같은 날짜에 이미 페이지가 있는 학생은 건너뛰므로 몇 번을 실행해도 안전(멱등).
// ------------------------------------------------------------------
async function generateDailyReports() {
    const { dateString } = getKSTTodayRange();
    const todayChar = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' }).format(new Date());
    const students = (await readStudentConfigs()).filter(s => s.days.includes(todayChar));

    // 오늘 날짜로 이미 생성된 페이지의 학생 relation 수집 → 중복 생성 방지
    const existing = new Set();
    let cursor, hasMore = true;
    while (hasMore) {
        const body = { filter: { property: '🕐 날짜', date: { equals: dateString } }, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
        for (const page of data.results) {
            (page.properties['학생 명부 관리']?.relation || []).forEach(r => existing.add(r.id));
        }
        hasMore = data.has_more; cursor = data.next_cursor;
    }

    const created = [], skipped = [];
    for (const st of students) {
        if (existing.has(st.pageId)) { skipped.push(st.name); continue; }
        await fetchNotion('https://api.notion.com/v1/pages', {
            method: 'POST',
            body: JSON.stringify({
                parent: { database_id: PROGRESS_DATABASE_ID },
                properties: {
                    '이름': { title: [{ text: { content: st.name } }] },
                    '🕐 날짜': { date: { start: dateString } },
                    '학생 명부 관리': { relation: [{ id: st.pageId }] }
                }
            })
        });
        created.push(st.name);
        await new Promise(r => setTimeout(r, 350)); // Notion 초당 3요청 제한 대응
    }
    dashboardCache.dailyReport.lastFetch = 0;
    return { date: dateString, day: todayChar, created, skipped };
}

// 수동 실행용 (크론이 못 돌았을 때 복구 등)
app.post('/api/generate-daily-reports', requireAuth, async (req, res) => {
    try {
        const result = await generateDailyReports();
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

cron.schedule('20 10 * * *', async () => {
    try {
        const r = await generateDailyReports();
        console.log(`✅ 데일리 리포트 자동 생성: ${r.date}(${r.day}) 신규 ${r.created.length}명, 기존 ${r.skipped.length}명`);
    } catch (e) { console.error('데일리 리포트 생성 Cron Error', e); }
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
            const workbook = props['워크북']?.checkbox || false;
            const totalUnits = props['총유닛수']?.number ?? null;
            const perPassage = props['유닛당지문수']?.number ?? 1;
            const item = { id: page.id, name, subject, workbook, totalUnits, perPassage };
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

// 학생별 진도 설정 읽기 (학생 명부 DB) — 재사용 함수
// onlyName을 주면 노션 쪽에서 그 1명만 필터링해서 가져온다(개인 지목 조회 10배 단축용). 안 주면 기존처럼 전체.
async function readStudentConfigs(onlyName = '') {
    let byId = {};
    try { byId = (await loadTextbooks()).byId; } catch (e) { /* 교재 못 읽어도 진행 */ }
    const relName = (prop) => (prop?.relation?.map(r => byId[r.id]?.name || '').filter(Boolean).join(', ')) || '';
    const relId = (prop) => prop?.relation?.[0]?.id || '';
    const nameFilter = onlyName ? { property: '이름', title: { equals: onlyName } } : null;

    const students = [];
    let cursor = undefined, hasMore = true;
    while (hasMore) {
        const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
        if (nameFilter) body.filter = nameFilter;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST', body: JSON.stringify(body)
        });
        for (const page of data.results) {
            const p = page.properties;
            const enroll = p['재원상태']?.select?.name || '';
            if (enroll === '퇴원' || enroll === '휴원') continue; // 미재원생(퇴원·휴원)은 진도관리·생성에서 제외
            students.push({
                pageId: page.id,
                name: p['이름']?.title?.[0]?.plain_text || '이름없음',
                teachers: p['담당쌤']?.multi_select?.map(t => t.name) || [],
                days: p['수강요일']?.multi_select?.map(d => d.name).join('') || '',
                status: p['학습상태']?.select?.name || '',
                fixed: p['고정숙제']?.rich_text?.map(t => t.plain_text).join('') || '',
                vocab: { bookId: relId(p['어휘교재']),   bookName: relName(p['어휘교재']),   unit: p['어휘현재유닛']?.number ?? '',   amount: p['어휘진도량']?.number ?? '',   method: p['어휘진도방식']?.select?.name || '',   weekly: p['어휘요일별진도량']?.rich_text?.map(t => t.plain_text).join('') || '' },
                mainR: { bookId: relId(p['주독해교재']), bookName: relName(p['주독해교재']), unit: p['주독해현재유닛']?.number ?? '', amount: p['주독해진도량']?.number ?? '', method: p['주독해진도방식']?.select?.name || '', weekly: p['주독해요일별진도량']?.rich_text?.map(t => t.plain_text).join('') || '' },
                subR:  { bookId: relId(p['부독해교재']), bookName: relName(p['부독해교재']), unit: p['부독해현재유닛']?.number ?? '', amount: p['부독해진도량']?.number ?? '', method: p['부독해진도방식']?.select?.name || '', weekly: p['부독해요일별진도량']?.rich_text?.map(t => t.plain_text).join('') || '' },
            });
        }
        hasMore = data.has_more; cursor = data.next_cursor;
    }
    // 노션은 DB에 저장된 순서 그대로 준다 → 진도 관리 탭에서 학생을 찾기 어려웠음. 이름 가나다순으로 고정.
    students.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return students;
}

app.get('/api/progress-config-data', requireAuth, async (req, res) => {
    try {
        const students = await readStudentConfigs();
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

// ============================================================
// [교재 목차 AI 입력] 목차(이미지/텍스트) → 유닛 구조화 → 교재 세부 내용 DB
// ============================================================

// 목차 페이지 도구
app.get('/textbook-toc', (req, res) => res.sendFile(path.join(publicPath, 'views', 'textbook-toc.html')));

// 목차 파싱 (저장 없이 검토용 초안 반환)
app.post('/api/parse-toc', requireAuth, async (req, res) => {
    const { tocText, imageBase64, imageMimeType } = req.body;
    if (!tocText && !imageBase64) return res.status(400).json({ success: false, message: '목차 텍스트나 이미지를 넣어주세요.' });
    if (!geminiModel) return res.status(500).json({ success: false, message: 'AI not configured' });

    try {
        const instruction = `너는 영어 교재의 목차(Table of Contents)를 구조화하는 도우미다. 목차를 "학생에게 낼 수 있는 가장 작은 학습 단위(지문/Reading/Lesson)" 하나하나로 펼쳐서, 나오는 순서대로 JSON 배열만 출력한다. 설명·마크다운 없이 순수 JSON 배열만.
각 원소 형식: {"group": "챕터/유닛 라벨", "subject": "과목/분류", "title": "항목 제목", "startPage": 정수 또는 null}
핵심 규칙:
- 한 유닛/챕터 안에 Reading 1, Reading 2 또는 Lesson 여러 개가 있으면, 그 각각을 "별도의 원소"로 만든다. 큰 제목(챕터/유닛명)만 뽑지 말 것.
- group: 그 항목이 속한 챕터/유닛 라벨을 번호까지 포함해 원문 그대로. 예: "Unit 1 Food", "Chapter 1 Eyes". 그런 묶음이 없으면 "".
- subject: 목차에 Subject/과목 표기(Science, History, Art 등)가 있으면 그 값. 없으면 "".
- title: 그 항목(지문/레슨)의 개별 제목을 원문 그대로. 예: "Marshmallows", "Twice as Good!".
- startPage: 그 항목의 시작 페이지 정수. 없으면 null. (끝 페이지는 계산 안 해도 됨)
- 배열 순서 = 책에 나온 실제 학습 순서(위→아래, 좌측 페이지 먼저 그다음 우측 페이지).
- 부록/색인/워크북/정답/Answer Key 등은 제외한다.
- 목차에 없는 내용을 절대 지어내지 마라. 불확실하면 페이지는 null.`;

        const parts = [{ text: instruction }];
        if (tocText) parts.push({ text: `\n[목차 텍스트]\n${tocText}` });
        if (imageBase64) parts.push({ inlineData: { mimeType: imageMimeType || 'image/jpeg', data: imageBase64 } });

        const result = await geminiModel.generateContent({
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' }
        });
        let text = result.response.text().trim();
        // 방어적 파싱: 혹시 마크다운 펜스가 섞이면 제거
        text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        let items;
        try { items = JSON.parse(text); } catch (e) {
            return res.status(500).json({ success: false, message: 'AI 응답을 표로 변환하지 못했습니다. 다시 시도해주세요.' });
        }
        if (!Array.isArray(items)) items = [];
        // 정규화 — 순번은 배열 순서대로 부여, 끝페이지는 프론트에서 자동계산
        items = items.map((u, i) => ({
            order: i + 1,
            group: String(u.group || ''),
            subject: String(u.subject || ''),
            title: String(u.title || ''),
            startPage: (u.startPage == null || u.startPage === '' || isNaN(Number(u.startPage))) ? null : Number(u.startPage),
            endPage: null
        }));
        res.json({ success: true, units: items });
    } catch (e) {
        console.error('parse-toc error', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// 특정 교재의 기존 유닛 불러오기 (재편집용)
app.get('/api/textbook-units', requireAuth, async (req, res) => {
    const { bookId } = req.query;
    if (!bookId) return res.status(400).json({ success: false, message: 'bookId 필요' });
    if (!TEXTBOOK_UNIT_DB_ID) return res.json({ success: true, units: [] });
    try {
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${TEXTBOOK_UNIT_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '교재', relation: { contains: bookId } }, page_size: 100 })
        });
        const units = q.results.map(pg => {
            const p = pg.properties;
            return {
                order: p['순번']?.number ?? null,
                group: p['그룹']?.rich_text?.map(t => t.plain_text).join('') || '',
                subject: p['분류']?.rich_text?.map(t => t.plain_text).join('') || '',
                title: p['제목']?.title?.[0]?.plain_text || '',
                startPage: p['시작페이지']?.number ?? null,
                endPage: p['끝페이지']?.number ?? null
            };
        }).sort((a, b) => (a.order || 0) - (b.order || 0));
        res.json({ success: true, units });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 유닛 저장 (기존 교체 + 교재 총유닛수 갱신). 스트리밍 진행률.
app.post('/api/save-textbook-units', requireAuth, async (req, res) => {
    const { bookId, units, workbook } = req.body;
    if (!bookId || !Array.isArray(units)) return res.status(400).json({ success: false, message: 'bookId/units 필요' });
    if (!TEXTBOOK_UNIT_DB_ID) return res.status(500).json({ success: false, message: 'TEXTBOOK_UNIT_DB_ID 미설정' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    try {
        // 1) 이 교재의 기존 유닛 행 archive (교체 방식)
        const existing = await fetchNotion(`https://api.notion.com/v1/databases/${TEXTBOOK_UNIT_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '교재', relation: { contains: bookId } }, page_size: 100 })
        });
        for (const pg of existing.results) {
            await fetchNotion(`https://api.notion.com/v1/pages/${pg.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
            await new Promise(r => setTimeout(r, 120));
        }

        // 2) 새 항목 행 생성 (순번은 배열 순서대로 부여)
        let created = 0;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            const order = (u.order == null || u.order === '') ? (i + 1) : Number(u.order);
            const props = {
                '제목': { title: [{ text: { content: String(u.title || `항목 ${order}`) } }] },
                '교재': { relation: [{ id: bookId }] },
                '순번': { number: order },
                '그룹': { rich_text: u.group ? [{ text: { content: String(u.group) } }] : [] },
                '분류': { rich_text: u.subject ? [{ text: { content: String(u.subject) } }] : [] },
                '시작페이지': { number: (u.startPage == null || u.startPage === '') ? null : Number(u.startPage) },
                '끝페이지': { number: (u.endPage == null || u.endPage === '') ? null : Number(u.endPage) }
            };
            await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: TEXTBOOK_UNIT_DB_ID }, properties: props }) });
            created++;
            res.write(JSON.stringify({ progress: created, total: units.length }) + '\n');
            await new Promise(r => setTimeout(r, 200));
        }

        // 3) 교재 데이터 베이스의 총유닛수(=총 항목수) + 워크북 유무 갱신
        const totalItems = units.length;
        const bookProps = { '총유닛수': { number: totalItems } };
        if (typeof workbook === 'boolean') bookProps['워크북'] = { checkbox: workbook };
        await fetchNotion(`https://api.notion.com/v1/pages/${bookId}`, { method: 'PATCH', body: JSON.stringify({ properties: bookProps }) });
        if (typeof textbookCache !== 'undefined') textbookCache.lastFetch = 0;

        res.write(JSON.stringify({ success: true, message: `${created}개 항목 저장 완료 (총 ${totalItems}개)` }) + '\n');
        res.end();
    } catch (e) {
        console.error('save-textbook-units error', e);
        res.write(JSON.stringify({ success: false, message: e.message }) + '\n');
        res.end();
    }
});

// [신규] 목차 없는 교재(어휘서 등)용 — 총유닛수·워크북만 교재 DB에 저장
app.post('/api/set-textbook-meta', requireAuth, async (req, res) => {
    const { bookId, totalUnits, workbook } = req.body;
    if (!bookId) return res.status(400).json({ success: false, message: 'bookId 필요' });
    try {
        const props = {};
        if (totalUnits !== undefined) props['총유닛수'] = { number: (totalUnits === '' || totalUnits === null) ? null : Number(totalUnits) };
        if (typeof workbook === 'boolean') props['워크북'] = { checkbox: workbook };
        if (Object.keys(props).length === 0) return res.status(400).json({ success: false, message: '저장할 값 없음' });
        await fetchNotion(`https://api.notion.com/v1/pages/${bookId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
        if (typeof textbookCache !== 'undefined') textbookCache.lastFetch = 0;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ============================================================
// [Phase 4] 숙제 자동 생성 엔진 (미리보기 → 확정)
//   오늘 출석+학습상태=정상 학생마다 다음 등원일 마감 개수만큼 지문을 커서에서 뽑아 문구 생성.
//   기록은 오늘(배정일) 행. 커서 = 지문 순번(1-based). 빈 숙제칸에만 확정 기록.
// ============================================================
const _WEEK_ORDER = ['월', '화', '수', '목', '금', '토'];
const _WIDX = { '월': 0, '화': 1, '수': 2, '목': 3, '금': 4, '토': 5, '일': 6 };
const _DOW = ['일', '월', '화', '수', '목', '금', '토']; // getUTCDay 0=일

function parseAttendDays(days) {
    if (!days) return [];
    const set = [...new Set(String(days).split('').filter(c => _WEEK_ORDER.includes(c)))];
    return set.sort((a, b) => _WEEK_ORDER.indexOf(a) - _WEEK_ORDER.indexOf(b));
}
// 직전 등원 다음날 ~ 이번 등원일, 일요일만 제외한 학습일 수
function studyDaysBetween(prevC, curC) {
    let steps = (_WIDX[curC] - _WIDX[prevC] + 7) % 7; if (steps === 0) steps = 7;
    let c = 0; for (let i = 1; i <= steps; i++) { if ((_WIDX[prevC] + i) % 7 !== _WIDX['일']) c++; }
    return c;
}
function computeWeeklyMap(method, N, attend) {
    const map = {};
    attend.forEach((d, i) => {
        if (method === '매일') { const prev = attend[(i - 1 + attend.length) % attend.length]; map[d] = N * studyDaysBetween(prev, d); }
        else map[d] = N;
    });
    return map;
}
function parseWeeklyStr(str) {
    const map = {}; if (!str) return map;
    const re = /([월화수목금토])\s*(\d+)/g; let m;
    while ((m = re.exec(str))) map[m[1]] = Number(m[2]);
    return map;
}
// 날짜 유틸 (UTC 정오 기준으로 타임존 영향 제거)
function _dUTC(str) { const [Y, M, D] = str.split('-').map(Number); return new Date(Date.UTC(Y, M - 1, D, 12)); }
function _fmtUTC(dt) { return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`; }
// start < d <= end 범위에서 일요일만 제외한 날수 (휴일도 셈)
function nonSundayCount(startStr, endStr) {
    const s = _dUTC(startStr).getTime(), e = _dUTC(endStr).getTime(); let c = 0;
    for (let t = s + 86400000; t <= e; t += 86400000) { if (new Date(t).getUTCDay() !== 0) c++; }
    return c;
}
// 정량 진도를 쓰지 않는 과목(그때그때 숙제가 달라지는 학생)을 위한 진도방식.
// 자동 생성 대상에서 빼되, '진도량을 빠뜨린 것'과는 구분해서 경고 없이 안내만 한다.
const MANUAL_METHOD = '직접입력';

// 다음등원일 마감 개수 (매일=오늘~다음등원일 실제 날수 기반·일요일 제외, 휴일도 셈)
function deadlineQuantity(subjCfg, nc) {
    const method = subjCfg.method || '등원마다';
    if (method === MANUAL_METHOD) return 0; // 직접입력: 분량 계산 대상이 아님(선생님이 숙제칸에 직접 씀)
    if (method === '불규칙') return parseWeeklyStr(subjCfg.weekly)[nc.char] || 0;
    const N = Number(subjCfg.amount); if (!(N > 0)) return 0;
    if (method === '매일') return N * nc.studyDays;
    return N; // 등원마다
}
// 오늘(YYYY-MM-DD) 이후 수강요일 패턴의 다음 개원일 (휴무일 건너뜀)
function nextClassInfo(todayStr, attendArr, isHoliday) {
    if (!attendArr.length) return null;
    const base = _dUTC(todayStr);
    for (let i = 1; i <= 28; i++) {
        const dt = new Date(base.getTime() + i * 86400000);
        const char = _DOW[dt.getUTCDay()];
        const ds = _fmtUTC(dt);
        if (attendArr.includes(char) && !(isHoliday && isHoliday(ds))) {
            return { char, gapDays: i, dateStr: ds, studyDays: nonSundayCount(todayStr, ds), label: `${char}요일(${dt.getUTCMonth() + 1}/${dt.getUTCDate()})` };
        }
    }
    return null;
}
function unitLabel(u) { return (((u.group ? u.group + ' ' : '') + (u.title || '')).trim()) || ('항목 ' + u.order); }
// 커서부터 count개 지문 → 숙제 문구 + 다음 커서
function buildAssignment(book, units, cursor, count, deadlineLabel) {
    cursor = Math.max(1, Number(cursor) || 1);
    let rangeText = '', pages = '', newCursor = cursor + count, reachedEnd = false, wbRange = '';
    // 교재 끝에 걸리면 요청량(count)보다 적게 배정된다. 문구의 개수도 커서 전진도 이 realCount를 따라야
    // "3개"라고 써놓고 1개만 주거나, 커서가 책 밖으로 넘어가는 일이 생기지 않는다.
    let realCount = count;
    if (units && units.length) {
        const assigned = units.filter(u => u.order != null && u.order >= cursor).sort((a, b) => a.order - b.order).slice(0, count);
        if (assigned.length === 0) return null; // 커서가 책 끝을 넘음
        if (assigned.length < count) reachedEnd = true;
        realCount = assigned.length;
        const first = assigned[0], last = assigned[assigned.length - 1];
        rangeText = assigned.length === 1 ? unitLabel(first) : `${unitLabel(first)} ~ ${unitLabel(last)}`;
        if (first.startPage != null) { const ep = last.endPage ?? last.startPage; pages = ` (p.${first.startPage}${ep != null ? '~' + ep : ''})`; }
        newCursor = first.order + assigned.length;
        if (book.workbook) { const g1 = first.group || '', g2 = last.group || ''; wbRange = g1 ? (g1 === g2 ? g1 : `${g1} ~ ${g2}`) : rangeText; }
    } else {
        const per = book.perPassage || 1;
        const total = book.totalUnits || null;
        let sU = Math.ceil(cursor / per), eU = Math.ceil((cursor + count - 1) / per);
        if (total && sU > total) return null;
        if (total && eU > total) { eU = total; reachedEnd = true; realCount = Math.max(1, total * per - cursor + 1); }
        rangeText = sU === eU ? `Unit ${sU}` : `Unit ${sU}~${eU}`;
        newCursor = cursor + realCount;
        if (book.workbook) wbRange = rangeText;
    }
    const rangeWithBook = (book && book.name) ? `${book.name} · ${rangeText}` : rangeText;
    let text = `${deadlineLabel}까지 ${realCount}개: ${rangeWithBook}${pages}`;
    if (wbRange) text += ` + 워크북 ${wbRange}`;
    return { text, newCursor, reachedEnd, count: realCount };
}

const PHASE4_SUBJECTS = [
    { key: 'vocab', label: '📘어휘', hwField: '어휘숙제', cursorField: '어휘현재유닛', lastAmtField: '어휘직전배정량' },
    { key: 'mainR', label: '📗주독해', hwField: '주독해숙제', cursorField: '주독해현재유닛', lastAmtField: '주독해직전배정량' },
    { key: 'subR', label: '📙부독해', hwField: '부독해숙제', cursorField: '부독해현재유닛', lastAmtField: '부독해직전배정량' },
];

// ── 전원생 숙제 정지(킬스위치) ──────────────────────────────
// 특정 날짜가 '활성' 정지기간(시작일~종료일) 안에 들면 그 기간 반환, 아니면 null
async function getActivePause(dateStr) {
    if (!PAUSE_DB_ID) return null;
    try {
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${PAUSE_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '활성', checkbox: { equals: true } }, page_size: 100 })
        });
        for (const pg of q.results) {
            const p = pg.properties;
            const start = p['시작일']?.date?.start || null;
            const end = p['종료일']?.date?.start || p['시작일']?.date?.end || start; // 종료일 없으면 시작일 하루
            if (!start) continue;
            if (dateStr >= start && dateStr <= end) {
                return { reason: p['사유']?.title?.map(t => t.plain_text).join('') || '(사유 없음)', start, end, pageId: pg.id };
            }
        }
    } catch (e) { /* 정지 조회 실패 시 막지 않음(생성은 계속) */ }
    return null;
}

// 활성 정지기간 전체 목록 (엔진용: 정지 판정 + 마감일 휴무 건너뛰기)
async function getActivePausePeriodList() {
    if (!PAUSE_DB_ID) return [];
    try {
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${PAUSE_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '활성', checkbox: { equals: true } }, page_size: 100 })
        });
        return q.results.map(pg => {
            const p = pg.properties;
            const start = p['시작일']?.date?.start || null;
            const end = p['종료일']?.date?.start || p['시작일']?.date?.end || start;
            return start ? { start, end, reason: p['사유']?.title?.map(t => t.plain_text).join('') || '', pageId: pg.id } : null;
        }).filter(Boolean);
    } catch (e) { return []; }
}

// 공휴일 자동 프리필: date-holidays(KR) 공휴일을 정지 기간으로 등록(중복 제외)
app.post('/api/prefill-holidays', requireAuth, async (req, res) => {
    const year = Number(req.body?.year) || new Date().getFullYear();
    if (!PAUSE_DB_ID) return res.status(500).json({ success: false, message: 'PAUSE_DB_ID 미설정' });
    try {
        const hd = new Holidays('KR');
        const holidays = (hd.getHolidays(year) || []).filter(h => h.type === 'public');
        // 기존 정지 기간 시작일 수집(중복 방지) — 페이지네이션
        const existing = new Set();
        let cur = await fetchNotion(`https://api.notion.com/v1/databases/${PAUSE_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100 }) });
        const collect = (r) => r.results.forEach(pg => { const s = pg.properties['시작일']?.date?.start; if (s) existing.add(s); });
        collect(cur);
        while (cur.has_more) { cur = await fetchNotion(`https://api.notion.com/v1/databases/${PAUSE_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100, start_cursor: cur.next_cursor }) }); collect(cur); }
        let added = 0;
        for (const h of holidays) {
            const ds = String(h.date || '').slice(0, 10);
            if (!ds || existing.has(ds)) continue;
            await fetchNotion(`https://api.notion.com/v1/pages`, {
                method: 'POST', body: JSON.stringify({
                    parent: { database_id: PAUSE_DB_ID }, properties: {
                        '사유': { title: [{ text: { content: `[공휴일] ${h.name}` } }] },
                        '시작일': { date: { start: ds } }, '종료일': { date: { start: ds } }, '활성': { checkbox: true },
                    }
                })
            });
            added++; existing.add(ds);
            await new Promise(r => setTimeout(r, 120));
        }
        res.json({ success: true, added, totalHolidays: holidays.length, year });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 정지 기간 목록
app.get('/api/pause-periods', requireAuth, async (req, res) => {
    try {
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${PAUSE_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ sorts: [{ property: '시작일', direction: 'descending' }], page_size: 100 })
        });
        const periods = q.results.map(pg => {
            const p = pg.properties;
            return {
                pageId: pg.id,
                reason: p['사유']?.title?.map(t => t.plain_text).join('') || '',
                start: p['시작일']?.date?.start || '',
                end: p['종료일']?.date?.start || '',
                active: p['활성']?.checkbox || false,
            };
        });
        const todayStr = getKSTTodayRange().dateString;
        res.json({ success: true, periods, activeNow: await getActivePause(todayStr) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 정지 기간 추가
app.post('/api/pause-periods', requireAuth, async (req, res) => {
    const { reason, start, end } = req.body;
    if (!start) return res.status(400).json({ success: false, message: '시작일 필요' });
    try {
        const props = {
            '사유': { title: [{ text: { content: String(reason || '숙제 정지').substring(0, 200) } }] },
            '시작일': { date: { start } },
            '종료일': { date: { start: end || start } },
            '활성': { checkbox: true },
        };
        await fetchNotion(`https://api.notion.com/v1/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: PAUSE_DB_ID }, properties: props }) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 정지 기간 활성 토글 / 삭제(archive)
app.post('/api/pause-periods/update', requireAuth, async (req, res) => {
    const { pageId, active, archive } = req.body;
    if (!pageId) return res.status(400).json({ success: false, message: 'pageId 필요' });
    try {
        const body = archive ? { archived: true } : { properties: { '활성': { checkbox: !!active } } };
        await fetchNotion(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify(body) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 숙제 제안 계산(아무것도 쓰지 않음). 미리보기 화면과 11시 자동 생성 크론이 함께 씀.
//   onlyName          : 주면 그 학생 1명만
//   requireAttendance : true면 출석 체크된 학생만(수동 전체 생성). 크론·개인 지목은 false.
async function computeHomeworkProposals({ dateStr, onlyName = '', requireAttendance = true } = {}) {
    const todayStr = dateStr || getKSTTodayRange().dateString;
    // 활성 정지기간: 오늘이 정지면 전체 생성 중단, 그리고 마감일 계산 때 휴무일로 사용
    const pausePeriods = await getActivePausePeriodList();
    const isHoliday = (ds) => pausePeriods.some(p => ds >= p.start && ds <= p.end);
    const pauseNow = pausePeriods.find(p => todayStr >= p.start && todayStr <= p.end);
    if (pauseNow) return { date: todayStr, paused: true, pause: pauseNow, students: [] };
    // 오늘 일일 DB 행 — 개인 지목(onlyName)이면 노션 필터로 그 1명 행만 가져온다(전체 조회 10배 단축)
    const dailyFilter = onlyName
        ? { and: [{ property: '🕐 날짜', date: { equals: todayStr } }, { property: '이름', title: { equals: onlyName } }] }
        : { property: '🕐 날짜', date: { equals: todayStr } };
    const daily = []; let sc, more = true;
    while (more) {
        const d = await fetchNotion(`https://api.notion.com/v1/databases/${PROGRESS_DATABASE_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: dailyFilter, page_size: 100, start_cursor: sc })
        });
        daily.push(...d.results); more = d.has_more; sc = d.next_cursor;
    }
    const cfgByName = {};
    (await readStudentConfigs(onlyName)).forEach(c => { cfgByName[c.name] = c; });
    const { byId: bookById } = await loadTextbooks();
    const unitCache = {};
    const getUnits = async (bookId) => {
        if (unitCache[bookId]) return unitCache[bookId];
        if (!TEXTBOOK_UNIT_DB_ID) { unitCache[bookId] = []; return []; }
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${TEXTBOOK_UNIT_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '교재', relation: { contains: bookId } }, page_size: 100 })
        });
        const units = q.results.map(pg => {
            const p = pg.properties;
            return { order: p['순번']?.number ?? null, group: p['그룹']?.rich_text?.map(t => t.plain_text).join('') || '', title: p['제목']?.title?.[0]?.plain_text || '', startPage: p['시작페이지']?.number ?? null, endPage: p['끝페이지']?.number ?? null };
        }).sort((a, b) => (a.order || 0) - (b.order || 0));
        unitCache[bookId] = units; return units;
    };

    const results = [];
    for (const page of daily) {
        const p = page.properties;
        const name = p['이름']?.title?.[0]?.plain_text || '';
        if (onlyName && name !== onlyName) continue;
        const attendance = p['출석']?.checkbox || false;
        const absence = (p['결석 사유']?.rich_text?.map(t => t.plain_text).join('') || '').trim();
        if (absence) continue;                            // 결석 사유가 있으면 어떤 경우에도 제외
        if (requireAttendance && !attendance) continue;   // 수동 전체 생성일 때만 출석 체크 필수
        const cfg = cfgByName[name];
        if (!cfg || (cfg.status || '정상') !== '정상') continue;
        const attendArr = parseAttendDays(cfg.days);
        const nc = nextClassInfo(todayStr, attendArr, isHoliday);
        if (!nc) continue;
        const existing = {
            어휘숙제: (p['어휘숙제']?.rich_text?.map(t => t.plain_text).join('') || '').trim(),
            주독해숙제: (p['주독해숙제']?.rich_text?.map(t => t.plain_text).join('') || '').trim(),
            부독해숙제: (p['부독해숙제']?.rich_text?.map(t => t.plain_text).join('') || '').trim(),
        };
        const subjectsOut = [];
        for (const S of PHASE4_SUBJECTS) {
            const s2 = cfg[S.key];
            if (!s2.bookId) continue; // 교재 미배정 = 그 과목을 안 하는 학생(정상 제외)
            const book = bookById[s2.bookId] || { name: s2.bookName, workbook: false, perPassage: 1, totalUnits: null };
            const base = {
                key: S.key, label: S.label, hwField: S.hwField, cursorField: S.cursorField, lastAmtField: S.lastAmtField,
                bookName: book.name || s2.bookName,
                alreadyFilled: !!existing[S.hwField], existingText: existing[S.hwField],
            };
            // 교재는 배정됐는데 진도량(또는 요일별 진도량)이 비어 있으면 분량을 계산할 수 없다.
            // 예전엔 여기서 조용히 continue 해서 그 과목이 화면에 아예 안 나타났고,
            // 선생님 입장에선 "아무리 눌러도 숙제가 안 생긴다"로만 보여 원인을 알 수 없었다.
            // 이제는 막힌 이유를 함께 내려보내고, 대신 기록은 못 하도록 blocked로 잠근다.
            // 직접입력 과목: 설정 누락이 아니라 의도된 운영 방식 → 경고가 아니라 안내로 표시하고 넘어간다.
            if (s2.method === MANUAL_METHOD) {
                subjectsOut.push({
                    ...base, qty: 0, blocked: true, manual: true, newCursor: null, advanced: 0, reachedEnd: false,
                    text: '✍ 직접 입력 과목 — 출결·숙제 탭의 숙제칸에 직접 적어주세요',
                });
                continue;
            }
            const qty = deadlineQuantity(s2, nc);
            if (!(qty > 0)) {
                const why = (s2.method === '불규칙')
                    ? `⚠ ${nc.char}요일 진도량 없음 — 진도 관리 탭의 '요일별 진도량'을 확인하세요`
                    : `⚠ 진도량 미설정 — 진도 관리 탭에서 ${S.label} 진도량을 입력하세요`;
                subjectsOut.push({ ...base, qty: 0, text: why, newCursor: null, advanced: 0, reachedEnd: false, blocked: true });
                continue;
            }
            const units = await getUnits(s2.bookId);
            const asg = buildAssignment(book, units, s2.unit, qty, nc.label);
            if (!asg) {
                subjectsOut.push({
                    ...base, qty, blocked: true, newCursor: null, advanced: 0, reachedEnd: true,
                    text: `⚠ 교재 끝(현재유닛 ${s2.unit || 1}) — 새 교재를 배정하고 현재유닛을 1로 되돌리세요`,
                });
                continue;
            }
            subjectsOut.push({
                ...base, qty: asg.count, blocked: false,
                text: asg.text,
                newCursor: asg.newCursor,
                advanced: asg.newCursor - (Number(s2.unit) || 1),
                reachedEnd: asg.reachedEnd,
            });
        }
        if (subjectsOut.length) results.push({ dailyPageId: page.id, studentPageId: cfg.pageId, name, days: cfg.days, deadline: nc.label, subjects: subjectsOut });
    }
    return { date: todayStr, paused: false, students: results };
}

// 미리보기: 오늘 출석자 대상 제안만 생성(아무것도 안 씀)
// body.name 을 주면 그 학생 1명만 대상(개인별 생성) — 이땐 출석 체크 전이어도 허용(선생님이 명시적으로 지목한 것이므로)
app.post('/api/generate-homework-preview', requireAuth, async (req, res) => {
    try {
        const onlyName = String(req.body?.name || '').trim();
        const r = await computeHomeworkProposals({ dateStr: req.body?.date, onlyName, requireAttendance: !onlyName });
        if (r.paused) return res.json({ success: true, date: r.date, paused: true, pause: r.pause, students: [] });
        res.json({ success: true, date: r.date, students: r.students, onlyName: onlyName || null });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 확정: 선택된 학생들의 숙제 문구 기록 + 커서 전진 (스트리밍 진행률)
app.post('/api/confirm-homework', requireAuth, async (req, res) => {
    const { students } = req.body; // [{ dailyPageId, studentPageId, hw:{어휘숙제:...}, cursors:{어휘현재유닛:n} }]
    if (!Array.isArray(students)) return res.status(400).json({ success: false, message: 'students 필요' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    let done = 0, errors = 0;
    for (const st of students) {
        try {
            if (st.hw && Object.keys(st.hw).length && st.dailyPageId) {
                const props = {};
                for (const [k, v] of Object.entries(st.hw)) props[k] = { rich_text: v ? [{ text: { content: String(v).substring(0, 2000) } }] : [] };
                await fetchNotion(`https://api.notion.com/v1/pages/${st.dailyPageId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
            }
            if (st.cursors && Object.keys(st.cursors).length && st.studentPageId) {
                const props = {};
                for (const [k, v] of Object.entries(st.cursors)) props[k] = { number: (v == null || v === '') ? null : Number(v) };
                await fetchNotion(`https://api.notion.com/v1/pages/${st.studentPageId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
            }
            done++;
        } catch (e) { errors++; }
        res.write(JSON.stringify({ progress: done + errors, total: students.length }) + '\n');
        await new Promise(r => setTimeout(r, 150));
    }
    if (typeof dashboardCache !== 'undefined') dashboardCache.dailyReport.lastFetch = 0;
    res.write(JSON.stringify({ success: true, message: `${done}명 확정 완료${errors ? `, ${errors}건 실패` : ''}` }) + '\n');
    res.end();
});

// ------------------------------------------------------------------
// [자동] 매일 11:00 숙제 자동 생성·기록
// 10:20 리포트 생성 뒤, 그날 등원 예정 학생 전원의 숙제를 미리 만들어 기록해 둔다.
// 이 시각엔 아직 출석 체크 전이므로 출석 여부는 보지 않는다(결석사유가 적힌 학생은 제외).
// 결석이 확인되면 결석사유를 적는 순간 rollbackHomeworkForAbsence()가 되돌린다.
// 이미 문구가 있는 과목은 건너뛰므로 몇 번을 실행해도 안전(멱등).
// ------------------------------------------------------------------
async function autoGenerateHomework(dateStr, { dryRun = false } = {}) {
    const r = await computeHomeworkProposals({ dateStr, requireAttendance: false });
    if (r.paused) return { date: r.date, paused: true, pause: r.pause, written: [], skipped: [], errors: [], dryRun };

    const written = [], skipped = [], errors = [], blocked = [];
    for (const st of r.students) {
        // 설정이 막힌 과목(진도량 미설정·교재 끝)은 기록하지 않고 따로 모아 보고한다.
        // 예전엔 이런 과목이 흔적 없이 사라져 "왜 이 학생만 숙제가 없지?"를 알 방법이 없었다.
        // 직접입력 과목(manual)은 정상 운영이므로 경고 집계에서 제외한다.
        st.subjects.filter(s => s.blocked && !s.manual).forEach(s => blocked.push({ name: st.name, subject: s.label, reason: s.text }));
        // 아직 문구가 없는 과목만 기록(수기로 채워둔 건 덮어쓰지 않음)
        const todo = st.subjects.filter(s => !s.blocked && !s.alreadyFilled && s.newCursor != null);
        if (!todo.length) { skipped.push(st.name); continue; }
        if (dryRun) { written.push({ name: st.name, subjects: todo.map(s => s.label), texts: todo.map(s => s.text) }); continue; }
        try {
            const hwProps = {};
            for (const s of todo) hwProps[s.hwField] = { rich_text: [{ text: { content: String(s.text).substring(0, 2000) } }] };
            await fetchNotion(`https://api.notion.com/v1/pages/${st.dailyPageId}`, { method: 'PATCH', body: JSON.stringify({ properties: hwProps }) });

            const curProps = {};
            for (const s of todo) { curProps[s.cursorField] = { number: s.newCursor }; curProps[s.lastAmtField] = { number: s.advanced || 0 }; }
            await fetchNotion(`https://api.notion.com/v1/pages/${st.studentPageId}`, { method: 'PATCH', body: JSON.stringify({ properties: curProps }) });

            written.push({ name: st.name, subjects: todo.map(s => s.label) });
        } catch (e) { errors.push({ name: st.name, message: e.message }); }
        await new Promise(x => setTimeout(x, 350)); // Notion 초당 3요청 제한 대응
    }
    if (!dryRun && typeof dashboardCache !== 'undefined') dashboardCache.dailyReport.lastFetch = 0;
    return { date: r.date, paused: false, written, skipped, errors, blocked, dryRun };
}

// 수동 실행용 (크론이 못 돌았을 때 복구 등). dryRun:true 면 무엇이 기록될지만 돌려주고 쓰지 않음.
app.post('/api/auto-generate-homework', requireAuth, async (req, res) => {
    try {
        const result = await autoGenerateHomework(req.body?.date, { dryRun: !!req.body?.dryRun });
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

cron.schedule('0 11 * * *', async () => {
    try {
        const r = await autoGenerateHomework();
        if (r.paused) { console.log(`⏸️ 숙제 자동 생성 건너뜀(정지 기간): ${r.pause?.reason || ''}`); return; }
        console.log(`✅ 숙제 자동 생성: ${r.date} 기록 ${r.written.length}명, 이미 있음 ${r.skipped.length}명, 설정막힘 ${r.blocked.length}건, 실패 ${r.errors.length}건`);
        if (r.blocked.length) console.warn('⚠ 설정이 막혀 건너뛴 과목(진도량 미설정·교재 끝):', r.blocked.map(b => `${b.name}/${b.subject}`).join(', '));
        if (r.errors.length) console.error('숙제 자동 생성 실패 목록:', r.errors);
    } catch (e) { console.error('숙제 자동 생성 Cron Error', e); }
}, { timezone: "Asia/Seoul" });

// 결석 처리 시 그날 자동 생성된 숙제를 되돌림
// (11시 자동 생성은 출석 전에 돌기 때문에, 결석사유를 적는 순간 문구를 지우고 커서를 원위치)
// 되돌린 뒤 직전배정량을 0으로 만들어 두 번 되돌아가지 않게 한다.
async function rollbackHomeworkForAbsence(dailyPageId) {
    const dp = await fetchNotion(`https://api.notion.com/v1/pages/${dailyPageId}`);
    const name = dp.properties?.['이름']?.title?.[0]?.plain_text || '';
    if (!name) return { rolledBack: [] };

    const q = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
        method: 'POST', body: JSON.stringify({ filter: { property: '이름', title: { equals: name } }, page_size: 1 })
    });
    if (!q.results.length) return { rolledBack: [] };
    const stPage = q.results[0], sp = stPage.properties;

    const clearProps = {}, cursorProps = {}, rolledBack = [];
    for (const S of PHASE4_SUBJECTS) {
        const hasText = (dp.properties?.[S.hwField]?.rich_text?.map(t => t.plain_text).join('') || '').trim();
        if (!hasText) continue;
        clearProps[S.hwField] = { rich_text: [] };
        const lastAmt = sp[S.lastAmtField]?.number ?? 0;
        if (lastAmt > 0) {
            const cur = sp[S.cursorField]?.number ?? 1;
            cursorProps[S.cursorField] = { number: Math.max(1, cur - lastAmt) };
            cursorProps[S.lastAmtField] = { number: 0 };
        }
        rolledBack.push(S.label);
    }
    if (!rolledBack.length) return { rolledBack: [] };

    await fetchNotion(`https://api.notion.com/v1/pages/${dailyPageId}`, { method: 'PATCH', body: JSON.stringify({ properties: clearProps }) });
    if (Object.keys(cursorProps).length) {
        await fetchNotion(`https://api.notion.com/v1/pages/${stPage.id}`, { method: 'PATCH', body: JSON.stringify({ properties: cursorProps }) });
    }
    if (typeof dashboardCache !== 'undefined') dashboardCache.dailyReport.lastFetch = 0;
    return { rolledBack, name };
}

// 숙제 미룸(이월): 그 과목 커서를 직전배정량만큼 되돌려 다음 생성 때 재출제(A방식: 밀린 것만)
app.post('/api/defer-homework', requireAuth, async (req, res) => {
    const { name, prefix } = req.body; // prefix ∈ 어휘/주독해/부독해
    if (!name || !prefix) return res.status(400).json({ success: false, message: 'name/prefix 필요' });
    if (!['어휘', '주독해', '부독해'].includes(prefix)) return res.status(400).json({ success: false, message: 'prefix 오류' });
    try {
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '이름', title: { equals: name } }, page_size: 1 })
        });
        if (!q.results.length) return res.status(404).json({ success: false, message: '학생 명부에서 찾을 수 없음' });
        const page = q.results[0], p = page.properties;
        const cursorField = prefix + '현재유닛', amtField = prefix + '직전배정량';
        const cursor = p[cursorField]?.number ?? null;
        const lastAmt = p[amtField]?.number ?? 0;
        if (!(lastAmt > 0)) return res.json({ success: false, message: '미룰 직전 숙제 내역이 없습니다(이미 미뤘거나 생성 전).' });
        const newCursor = Math.max(1, (cursor ?? 1) - lastAmt);
        await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, {
            method: 'PATCH', body: JSON.stringify({ properties: { [cursorField]: { number: newCursor }, [amtField]: { number: 0 } } })
        });
        res.json({ success: true, newCursor, rolledBack: lastAmt });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 특정 학생·과목의 오늘 이미 생성된 숙제 문구를 새 커서 기준으로 다시 계산해 덮어씀
// (마감일·개수는 생성 로직과 동일하게 새로 계산 — 기존 문구는 수기 수정 등으로 형식이 깨져 있을 수 있어 파싱하지 않음)
async function regenerateDailyHwText(prefix, studentProps, dailyPageId, newCursor) {
    const bookId = studentProps[prefix + '교재']?.relation?.[0]?.id || null;
    if (!bookId) return null;
    const hwField = prefix + '숙제';
    const dp = await fetchNotion(`https://api.notion.com/v1/pages/${dailyPageId}`);
    const existingText = (dp.properties?.[hwField]?.rich_text?.map(t => t.plain_text).join('') || '').trim();
    if (!existingText) return null; // 오늘 이 과목 숙제가 아직 생성 안 된 경우엔 건드리지 않음

    const { byId: bookById } = await loadTextbooks();
    const book = bookById[bookId];
    if (!book) return null;
    let units = [];
    if (TEXTBOOK_UNIT_DB_ID) {
        const uq = await fetchNotion(`https://api.notion.com/v1/databases/${TEXTBOOK_UNIT_DB_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '교재', relation: { contains: bookId } }, page_size: 100 })
        });
        units = uq.results.map(pg => {
            const up = pg.properties;
            return { order: up['순번']?.number ?? null, group: up['그룹']?.rich_text?.map(t => t.plain_text).join('') || '', title: up['제목']?.title?.[0]?.plain_text || '', startPage: up['시작페이지']?.number ?? null, endPage: up['끝페이지']?.number ?? null };
        }).sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    const todayStr = getKSTTodayRange().dateString;
    const attendArr = parseAttendDays(studentProps['수강요일']?.multi_select?.map(d => d.name).join('') || '');
    const pausePeriods = await getActivePausePeriodList();
    const isHoliday = (ds) => pausePeriods.some(pp => ds >= pp.start && ds <= pp.end);
    const nc = nextClassInfo(todayStr, attendArr, isHoliday);
    if (!nc) return null;
    const subjCfg = {
        method: studentProps[prefix + '진도방식']?.select?.name || '',
        amount: studentProps[prefix + '진도량']?.number ?? '',
        weekly: studentProps[prefix + '요일별진도량']?.rich_text?.map(t => t.plain_text).join('') || '',
    };
    const qty = deadlineQuantity(subjCfg, nc);
    if (!(qty > 0)) return null;

    const asg = buildAssignment(book, units, newCursor, qty, nc.label);
    if (!asg) return null;
    await fetchNotion(`https://api.notion.com/v1/pages/${dailyPageId}`, {
        method: 'PATCH', body: JSON.stringify({ properties: { [hwField]: { rich_text: [{ text: { content: asg.text.substring(0, 2000) } }] } } })
    });
    return asg.text;
}

// 숙제 진도 전진: 그 과목 커서를 +step(기본 1) 앞으로. 직전배정량=이동한 칸수 기록(↩ 미룸으로 되돌리기 가능)
app.post('/api/advance-homework', requireAuth, async (req, res) => {
    const { name, prefix, dailyPageId, setCursor } = req.body; // prefix ∈ 어휘/주독해/부독해, dailyPageId 주면 오늘 숙제 문구도 갱신, setCursor 주면 그 절대값으로 지정(오타·오류 커서 교정용)
    const step = Math.max(1, Number(req.body?.step) || 1);
    if (!name || !prefix) return res.status(400).json({ success: false, message: 'name/prefix 필요' });
    if (!['어휘', '주독해', '부독해'].includes(prefix)) return res.status(400).json({ success: false, message: 'prefix 오류' });
    try {
        const q = await fetchNotion(`https://api.notion.com/v1/databases/${STUDENT_DATABASE_ID}/query`, {
            method: 'POST', body: JSON.stringify({ filter: { property: '이름', title: { equals: name } }, page_size: 1 })
        });
        if (!q.results.length) return res.status(404).json({ success: false, message: '학생 명부에서 찾을 수 없음' });
        const page = q.results[0], p = page.properties;
        const cursorField = prefix + '현재유닛', amtField = prefix + '직전배정량';
        const cursor = p[cursorField]?.number ?? 1;
        const newCursor = (setCursor != null && setCursor !== '') ? Math.max(1, Number(setCursor) || 1) : Math.max(1, (cursor || 1) + step);
        const advancedAmt = newCursor - (cursor || 1);
        await fetchNotion(`https://api.notion.com/v1/pages/${page.id}`, {
            method: 'PATCH', body: JSON.stringify({ properties: { [cursorField]: { number: newCursor }, [amtField]: { number: advancedAmt } } })
        });
        let updatedText = null;
        if (dailyPageId) {
            try { updatedText = await regenerateDailyHwText(prefix, p, dailyPageId, newCursor); }
            catch (e) { /* 오늘 문구 갱신 실패해도 커서 전진 자체는 이미 반영됨 */ }
        }
        res.json({ success: true, newCursor, advanced: advancedAmt, updatedText });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/planner-test', (req, res) => res.sendFile(path.join(publicPath, 'views', 'planner-test.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Final Server running on ${PORT}`));