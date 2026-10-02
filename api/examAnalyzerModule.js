import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 32 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('이미지 또는 PDF 파일만 올릴 수 있습니다.'));
    }
});

// multer 오류(형식/용량)를 500 HTML 대신 JSON으로 반환하는 래퍼
function uploadImages(req, res, next) {
    upload.array('images', 10)(req, res, err => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        next();
    });
}

// 업로드된 파일을 Claude 메시지 블록으로 변환 (PDF는 document, 그 외는 image)
function filesToContentBlocks(files) {
    return files.map(file => {
        if (file.mimetype === 'application/pdf') {
            return {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') }
            };
        }
        return {
            type: 'image',
            source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') }
        };
    });
}

const QUESTION_TYPES = [
    '어휘추론', '영영풀이', '어구추론', '내용일치', '어법이해',
    '서술형', '알맞은 대화 응답 찾기', '주제찾기', '기타'
];

const ANALYSIS_TOOL = {
    name: 'submit_exam_analysis',
    description: '시험지 문항별 분석 결과를 제출한다.',
    input_schema: {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        number: { type: 'string', description: '문제 번호 (예: 1, 2-1)' },
                        type: { type: 'string', enum: QUESTION_TYPES, description: '문제 유형' },
                        source_type: { type: 'string', enum: ['교과서본문', '외부지문', '대화문', '학습지'], description: '문항의 출제범위. 화자가 번갈아 말하는 대화형 텍스트면 "대화문". 교과서 본문에서 나온 지문이면 "교과서본문", 교과서 밖 외부 지문이면 "외부지문", 학습지(프린트)에서 나온 것으로 보이면 "학습지". 판단이 어려우면 "교과서본문"으로 둬라(선생님이 수정).' },
                        grammar_point: { type: 'string', description: '어법이해/서술형 문제일 때 출제된 구체적 문법 포인트. 해당 없으면 빈 문자열.' },
                        score: { type: 'number', description: '배점' },
                        difficulty: { type: 'string', enum: ['상', '중', '하'], description: '난이도' },
                        answer: { type: 'string', description: '이 문항의 정답. 반드시 문제를 직접 풀어서 채워라. 객관식/선택형이면 정답 선택지 번호(예: 3). 정답이 여러 개면 쉼표로(예: 2,4). 서술형이면 모범답안 문장. 도저히 풀 수 없으면 빈 문자열.' }
                    },
                    required: ['number', 'type', 'source_type', 'score', 'difficulty', 'answer']
                }
            }
        },
        required: ['questions']
    }
};

const SYSTEM_PROMPT = `너는 영어학원 선생님을 도와 중간/기말고사 시험지 이미지를 분석하는 도구다.
입력된 시험지 이미지의 모든 문항을 순서대로 분석해서 submit_exam_analysis 도구로 결과를 제출해라.

분류 기준:
- type은 반드시 다음 중 하나: ${QUESTION_TYPES.join(', ')}
- source_type(출제범위)은 그 문항이 어디서 출제됐는지다. 화자가 번갈아 말하는 대화형 텍스트(A: ... B: ... 등)에 기반하면 "대화문", 교과서 본문 지문이면 "교과서본문", 교과서 밖 외부 지문이면 "외부지문", 학습지(프린트)로 보이면 "학습지". 이미지만으로 출처 구분이 어려우면 "교과서본문"으로 두고 선생님이 고치게 해라.
- **모든 문항을 직접 풀어서 answer에 정답을 채워라.** 객관식/선택형이면 정답 선택지 번호(1~5, 여러 개면 "2,4"), 서술형이면 모범답안 문장. 지문·보기를 근거로 최선을 다해 풀되, 도저히 판단 불가하면 빈 문자열.
- '어법이해' 문제는 grammar_point에 구체적인 문법 포인트를 적어라 (예: "관계대명사 계속적 용법", "가정법 과거완료").
- '서술형' 문제는 grammar_point에 그 문제가 확인하려는 문법 포인트를 적고, answer에 모범답안을 적어라.
- 그 외 유형은 grammar_point를 빈 문자열로 두되 answer(정답 번호)는 반드시 채워라.
- score는 시험지에 표기된 배점을 그대로 읽어라. 표기가 없으면 0.
- difficulty는 문항의 추론 난이도, 함정 요소, 어휘 수준을 바탕으로 상/중/하 중 하나로 판단해라.`;

// ── 학생 채점용 도구/헬퍼 ──────────────────────────────────────────

const GRADING_TOOL = {
    name: 'submit_student_answers',
    description: '학생 답안지에서 각 문항 번호별로 학생이 표기/작성한 답을 읽어 제출한다. 채점은 하지 않는다.',
    input_schema: {
        type: 'object',
        properties: {
            answers: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        number: { type: 'string', description: '문제 번호 (정답지와 동일한 표기, 예: 1, 2-1)' },
                        student_answer: { type: 'string', description: '학생이 그 번호에 표기하거나 작성한 답. 객관식이면 고른 번호(예: 3), 서술형이면 학생이 쓴 문장을 그대로 옮겨적어라. 표기가 없으면 빈 문자열.' }
                    },
                    required: ['number', 'student_answer']
                }
            }
        },
        required: ['answers']
    }
};

const GRADING_SYSTEM_PROMPT = `너는 영어학원 선생님을 도와 학생의 시험 답안지 이미지를 읽는 도구다.
정답 여부는 판단하지 말고, 각 문항 번호에 학생이 표기하거나 손으로 쓴 답만 정확히 읽어 submit_student_answers 도구로 제출해라.
- 객관식(오지선다)은 학생이 고른 번호를 아라비아 숫자로 적어라. ①②③④⑤ 같은 동그라미 숫자는 1~5로 바꿔라. 여러 개 고른 흔적이 있으면 모두 적어라(예: "2,4").
- 서술형/영작은 학생이 쓴 글씨를 최대한 그대로 옮겨적어라. 알아보기 어려우면 읽히는 만큼만 적어라.
- 아무 표기도 없으면 student_answer를 빈 문자열로 둬라.
- 주어진 번호 목록에 있는 문항만 답해라.`;

// ①②③④⑤ → 1~5, 공백 제거, 소문자화 (객관식/단답 비교용 정규화)
function normalizeAnswer(s) {
    if (!s) return '';
    const circled = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5' };
    return String(s).replace(/[①②③④⑤]/g, m => circled[m]).replace(/\s+/g, '').toLowerCase();
}

// "1", "2-1", "10" 자연 정렬
function naturalNumberSort(a, b) {
    const pa = String(a).split('-').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('-').map(n => parseInt(n, 10) || 0);
    return (pa[0] - pb[0]) || ((pa[1] || 0) - (pb[1] || 0));
}

// 정답지(QUESTION_DB)에서 특정 시험의 문항들을 relation으로 조회
async function loadAnswerKey(fetchNotion, questionDbId, examPageId) {
    let results = [];
    let cursor;
    do {
        const body = { filter: { property: '시험', relation: { contains: examPageId } }, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${questionDbId}/query`, {
            method: 'POST', body: JSON.stringify(body)
        });
        results = results.concat(data.results);
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    return results.map(p => {
        const P = p.properties;
        return {
            number: P['번호']?.title?.[0]?.plain_text || '',
            type: P['유형']?.select?.name || '',
            source_type: P['출제범위']?.select?.name || '',
            grammar_point: P['문법포인트']?.rich_text?.[0]?.plain_text || '',
            answer: P['정답']?.rich_text?.[0]?.plain_text || '',
            score: P['배점']?.number || 0,
            difficulty: P['난이도']?.select?.name || ''
        };
    }).sort((a, b) => naturalNumberSort(a.number, b.number));
}

// 리포트 AI 문구(AI코멘트·리포트AI)의 프롬프트 버전. 프롬프트를 바꾸면 올린다 → 예전 캐시는 다시 만들어진다.
const REPORT_PROMPT_VERSION = 3;

// ===== 리디테스트 대비 범위 =====
// 리디테스트(별도 저장소 Desktop/Readitest)가 학교·시험마다 분석한 어법 포인트로 동형 모의고사를 만들어 학생들이 전부 풀었다.
// 그래서 "분석한 포인트 = 학생이 학원에서 동형으로 연습한 포인트"로 본다(원장 확정 2026-10-02).
// 리디테스트가 뽑아 준 data/readitest-coverage.json 을 읽는다. 파일이 없거나 그 시험이 없으면 조용히 빠진다.
const COVERAGE_PATH = new URL('../data/readitest-coverage.json', import.meta.url);
let coverageCache = { mtimeMs: -1, data: null };
function defaultLoadCoverage() {
    try {
        const st = fs.statSync(COVERAGE_PATH);
        if (st.mtimeMs !== coverageCache.mtimeMs) {
            coverageCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8')) };
        }
        return coverageCache.data;
    } catch (e) { return null; }
}

// 리디플랜 시험 정보(영덕중학교 / 2학년 / 2026 / 2학기 / 중간고사) → 리디테스트 표기(영덕중 / 2 / 2026 / 2 / 중간)로 맞춰 찾는다.
// 다른 학교·고등학교는 억지로 비슷한 학교에 붙이지 않는다.
function findCoverage(coverage, examInfo) {
    if (!coverage?.exams?.length) return null;
    const school = String(examInfo.school || '').replace(/\s+/g, '').replace(/중학교$/, '중');
    const grade = Number(String(examInfo.grade || '').replace(/[^0-9]/g, '')) || null;
    const semester = Number(String(examInfo.semester || '').replace(/[^0-9]/g, '')) || null;
    const sitting = /기말/.test(examInfo.examType || '') ? '기말' : /중간/.test(examInfo.examType || '') ? '중간' : '';
    if (!school || !grade || !sitting) return null;
    return coverage.exams.find(e =>
        String(e.school).replace(/\s+/g, '') === school && Number(e.grade) === grade && e.sitting === sitting
        && (!examInfo.year || !e.year || Number(e.year) === Number(examInfo.year))
        && (!semester || !e.semester || Number(e.semester) === semester)
    ) || null;
}

// 난이도(상/중/하)별 정오 요약 — AI 코멘트가 "쉬운 문제 실수"와 "어려운 문제 해결"을 구분해 쓰게 한다
function summarizeByDifficulty(questions) {
    const label = q => `${q.number}번(${[q.type, q.source_type, q.grammar_point].filter(Boolean).join(', ')})`;
    const lines = ['상', '중', '하'].map(d => {
        const qs = questions.filter(q => q.difficulty === d);
        if (!qs.length) return null;
        const right = qs.filter(q => q.verdict === '정답');
        const wrong = qs.filter(q => q.verdict === '오답' || q.verdict === '부분');
        return `${d} 난이도 ${qs.length}문항 중 ${right.length}문항 정답`
            + (d === '상' && right.length ? ` — 맞힌 상 문항: ${right.map(label).join(', ')}` : '')
            + (wrong.length ? ` — 틀린 문항: ${wrong.map(label).join(', ')}` : '');
    }).filter(Boolean);
    return lines.length ? lines.join('\n') : '';
}

// 저장된 시험(정답지) 목록 조회 — 교사용/학생용 공통
async function listExams(fetchNotion, examDbId) {
    let results = [];
    let cursor;
    do {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const data = await fetchNotion(`https://api.notion.com/v1/databases/${examDbId}/query`, {
            method: 'POST', body: JSON.stringify(body)
        });
        results = results.concat(data.results);
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    return results.map(p => {
        const P = p.properties;
        return {
            pageId: p.id,
            examTitle: P['시험명']?.title?.[0]?.plain_text || '(제목없음)',
            school: P['학교']?.select?.name || '',
            grade: P['학년']?.select?.name || '',
            year: P['시험년도']?.number || null,
            semester: P['학기']?.select?.name || '',
            examType: P['시험종류']?.select?.name || '',
            questionCount: P['문항수']?.number || 0
        };
    });
}

// 정답지 + 학생답 맵 → 문항별 채점 결과 (객관식 자동 대조, 서술형은 채점대기).
// grade-student(이미지 인식), student/submit-exam(학생 직접 입력), 재채점에서 공통 사용.
function gradeAgainstKey(answerKey, studentMap) {
    return answerKey.map(q => {
        const studentAnswer = studentMap[normalizeAnswer(q.number)] ?? '';
        const isEssay = q.type === '서술형';
        let verdict, earned;
        if (isEssay) {
            verdict = '채점대기';
            earned = 0;
        } else {
            const correct = studentAnswer && normalizeAnswer(studentAnswer) === normalizeAnswer(q.answer);
            verdict = correct ? '정답' : '오답';
            earned = correct ? q.score : 0;
        }
        return {
            number: q.number,
            type: q.type,
            grammar_point: q.grammar_point,
            answer: q.answer,
            student_answer: studentAnswer,
            verdict,
            score: q.score,
            earned
        };
    });
}

// 채점 결과(graded) → 점수/취약점 집계 + 저장용 rows·리포트 텍스트 계산 (순수 함수, DB 접근 없음).
// 저장(persistStudentResult)과 재채점(regrade-exam)이 동일 계산을 쓰도록 공통화.
function computeResultSummary(graded) {
    let score = 0, fullScore = 0, correctCount = 0, wrongCount = 0, partialCount = 0;
    const weakTypes = new Set();
    const weakGrammar = new Set();
    const wrongNumbers = [];
    let hasEssay = false, essayPending = false;

    const rows = graded.map(g => {
        const max = Number(g.score) || 0;
        // 획득점수: 정답=만점, 오답/채점대기=0, 부분=입력값(0~배점으로 보정).
        let earned;
        if (g.verdict === '채점대기') earned = 0;
        else if (g.verdict === '정답') earned = max;
        else if (g.verdict === '오답') earned = 0;
        else { // '부분' 또는 기타
            earned = Number(g.earned);
            if (!Number.isFinite(earned)) earned = 0;
        }
        earned = Math.max(0, Math.min(max, earned));
        score += earned;
        fullScore += max;
        if (g.type === '서술형') { hasEssay = true; if (g.verdict === '채점대기') essayPending = true; }
        if (g.verdict === '정답') correctCount++;
        else if (g.verdict === '부분') {
            partialCount++;
            if (g.type) weakTypes.add(g.type);
            if (g.grammar_point) weakGrammar.add(g.grammar_point);
        } else if (g.verdict === '오답') {
            wrongCount++;
            wrongNumbers.push(g.number);
            if (g.type) weakTypes.add(g.type);
            if (g.grammar_point) weakGrammar.add(g.grammar_point);
        }
        return { ...g, earned };
    });

    const weakGrammarStr = [...weakGrammar].join(', ');
    const reportText = `총점 ${score}/${fullScore} (정답 ${correctCount}, 오답 ${wrongCount}`
        + `${partialCount ? ', 부분 ' + partialCount : ''}`
        + `${essayPending ? ', 서술형 채점대기' : ''}). `
        + `${weakTypes.size ? '취약 유형: ' + [...weakTypes].join(', ') + '. ' : ''}`
        + `${weakGrammarStr ? '취약 문법: ' + weakGrammarStr + '. ' : ''}`
        + `${wrongNumbers.length ? '오답 문항: ' + wrongNumbers.join(', ') : ''}`;

    return {
        rows, score, fullScore, correctCount, wrongCount, partialCount,
        weakTypes: [...weakTypes], weakGrammarStr, hasEssay, essayPending, reportText
    };
}

// STUDENT_RESULT_DB 1행 속성 빌더 (저장·재채점 공통). meta에서 학생/시험/등록자 등을 받는다.
function buildResultProps(sum, meta) {
    const props = {
        '점수': { number: sum.score },
        '만점': { number: sum.fullScore },
        '정답수': { number: sum.correctCount },
        '오답수': { number: sum.wrongCount },
        '취약유형': { multi_select: sum.weakTypes.map(name => ({ name })) },
        '취약문법': { rich_text: [{ text: { content: sum.weakGrammarStr } }] },
        '서술형채점': { select: { name: sum.hasEssay ? (sum.essayPending ? '대기' : '완료') : '없음' } },
        '리포트': { rich_text: [{ text: { content: sum.reportText } }] }
    };
    if (meta.studentName != null) props['학생명'] = { title: [{ text: { content: String(meta.studentName) } }] };
    if (meta.examPageId) props['시험'] = { relation: [{ id: meta.examPageId }] };
    if (meta.registeredBy != null) props['등록자'] = { rich_text: [{ text: { content: String(meta.registeredBy || '') } }] };
    if (meta.school) props['학교'] = { select: { name: meta.school } };
    if (meta.grade) props['학년'] = { select: { name: meta.grade } };
    if (meta.examType) props['시험종류'] = { select: { name: meta.examType } };
    return props;
}

// STUDENT_ANSWER_DB 문항 1행 속성 빌더. link가 있으면 학생결과 relation을 붙인다(신규 생성용).
function buildAnswerProps(g, resultId) {
    const props = {
        '번호': { title: [{ text: { content: String(g.number ?? '') } }] },
        '문법포인트': { rich_text: [{ text: { content: String(g.grammar_point ?? '') } }] },
        '정답': { rich_text: [{ text: { content: String(g.answer ?? '') } }] },
        '학생답': { rich_text: [{ text: { content: String(g.student_answer ?? '') } }] },
        '배점': { number: Number(g.score) || 0 },
        '획득점수': { number: g.earned }
    };
    if (resultId) props['학생결과'] = { relation: [{ id: resultId }] };
    if (g.type) props['유형'] = { select: { name: g.type } };
    if (g.verdict) props['정오'] = { select: { name: g.verdict } };
    return props;
}

// 채점 결과(graded)를 STUDENT_RESULT_DB(1행) + STUDENT_ANSWER_DB(문항별)로 저장.
// meta: { examPageId, studentName, school?, grade?, examType?, registeredBy? }
// 교사 저장(save-student-result)과 학생 제출(submit-exam) 양쪽에서 재사용.
async function persistStudentResult(fetchNotion, dbIds, meta, graded) {
    const sum = computeResultSummary(graded);

    // 1) 학생 응시 결과 1행
    const resultProps = buildResultProps(sum, meta);

    const resultPage = await fetchNotion('https://api.notion.com/v1/pages', {
        method: 'POST',
        body: JSON.stringify({ parent: { database_id: dbIds.STUDENT_RESULT_DB_ID }, properties: resultProps })
    });

    // 2) 문항별 응답 행 (학생결과 relation으로 연결)
    for (const g of sum.rows) {
        await fetchNotion('https://api.notion.com/v1/pages', {
            method: 'POST',
            body: JSON.stringify({ parent: { database_id: dbIds.STUDENT_ANSWER_DB_ID }, properties: buildAnswerProps(g, resultPage.id) })
        });
    }

    return { pageId: resultPage.id, score: sum.score, fullScore: sum.fullScore, report: sum.reportText };
}

// Notion DB에 속성(칸)이 없으면 추가한다(있으면 무해한 no-op). AI 코멘트 캐시 저장용.
async function ensureDbProperty(fetchNotion, dbId, propName, propConfig) {
    await fetchNotion(`https://api.notion.com/v1/databases/${dbId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { [propName]: propConfig } })
    });
}

// 규칙 기반 대책 매핑 (선생님이 지정한 유형·출제범위별 학습 처방)
const TYPE_ADVICE = {
    '어휘추론': '교과서 본문 어휘와 학습지 단어를 정확히 암기하고, 문맥 속 의미를 추론하는 연습을 하세요.',
    '영영풀이': '학교 학습지의 영영풀이(영어 정의) 어휘를 반복해서 확인·암기하세요.',
    '어구추론': '지문 속 표현·숙어의 문맥상 의미를 파악하는 연습이 필요합니다.',
    '내용일치': '지문을 꼼꼼히 읽고 선택지와 세부 정보를 하나씩 대조하는 연습을 하세요.',
    '어법이해': '틀린 문항의 오답 풀이를 확실히 하고, 해당 문법 포인트를 개념부터 다시 복습하세요.',
    '서술형': '문법 포인트를 정확히 이해하고, 모범답안과 비교하며 직접 영작하는 연습을 하세요.',
    '알맞은 대화 응답 찾기': '교과서·학습지의 대화문을 반복 암기해 상황별 표현에 익숙해지세요.',
    '주제찾기': '글의 중심 내용과 요지를 파악하는 독해 연습이 필요합니다.',
    '기타': '틀린 문항의 유형을 확인하고 관련 개념을 복습하세요.'
};
const SOURCE_ADVICE = {
    '대화문': '학습지 및 교과서의 대화문을 잘 암기할 필요가 있습니다.',
    '교과서본문': '교과서 본문을 반복해서 읽고 내용을 확실히 숙지하세요.',
    '외부지문': '다양한 외부 지문 독해 연습으로 처음 보는 글에 대한 적응력을 높이세요.',
    '학습지': '학교에서 나눠준 학습지를 한 번 더 꼼꼼히 확인·복습하세요.'
};

// 노션 rich_text 칸은 조각 하나에 2000자까지라, 긴 문자열은 나눠 쓰고 읽을 때 이어 붙인다.
function richTextChunks(str) {
    const out = [];
    for (let i = 0; i < str.length && out.length < 100; i += 1900) out.push({ text: { content: str.slice(i, i + 1900) } });
    return out;
}
function readRichText(prop) {
    return (prop?.rich_text || []).map(t => t.plain_text || '').join('');
}

// 학부모용 리포트 문구(핵심 진단·문항별 오답 요인·대처 방안)의 규칙 기반 폴백 — AI 실패 시에도 빈칸이 나가지 않게
function buildParentReportFallback(wrongQuestions, recommendations) {
    const reasons = {};
    wrongQuestions.forEach(q => {
        reasons[q.number] = q.grammar_point
            ? `${q.grammar_point} 판단에서 혼동이 있었던 것으로 보입니다.`
            : (TYPE_ADVICE[q.type] || TYPE_ADVICE['기타']);
    });
    const diagnosis = wrongQuestions.length
        ? `${wrongQuestions.length}문항에서 실점했습니다. ${[...new Set(wrongQuestions.map(q => q.type).filter(Boolean))].join('·')} 유형의 보완이 다음 시험의 열쇠입니다.`
        : '전 문항 정답 — 개념과 독해 모두 안정적인 결과입니다.';
    const plan = recommendations.length ? recommendations.slice(0, 4) : ['현재의 학습 습관을 유지하며 다음 시험 범위를 미리 예습합니다.'];
    return { diagnosis, reasons, plan };
}

// 이 기능은 원장(manager 계정) 전용 — 다른 선생님 계정(teacher1/teacher2 등, role은 같은 'manager'라도 loginId가 다름)은 접근 불가
function requireOwner(req, res, next) {
    if (req.user?.loginId !== 'manager') {
        return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
    }
    next();
}

// 학생 셀프 답안 입력 전용 — 로그인한 학생(role='student')만 접근 가능
function requireStudent(req, res, next) {
    if (req.user?.role !== 'student') {
        return res.status(403).json({ success: false, message: '학생만 접근할 수 있습니다.' });
    }
    next();
}

export function initializeExamAnalyzerRoutes({ app, requireAuth, fetchNotion, geminiModel, loadStudyPeriod, loadCoverage = defaultLoadCoverage, dbIds, warmDelayMs = 3000 }) {
    let anthropic = null;
    if (process.env.ANTHROPIC_API_KEY) {
        anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else {
        console.warn('⚠️ ANTHROPIC_API_KEY가 설정되지 않아 시험지 분석 기능이 비활성화됩니다.');
    }

    app.post('/api/analyze-exam', requireAuth, requireOwner, uploadImages, async (req, res) => {
        if (!anthropic) {
            return res.status(500).json({ success: false, message: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: '이미지를 최소 1장 업로드해주세요.' });
        }

        try {
            const contentBlocks = filesToContentBlocks(req.files);

            const message = await anthropic.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 4096,
                system: SYSTEM_PROMPT,
                tools: [ANALYSIS_TOOL],
                tool_choice: { type: 'tool', name: 'submit_exam_analysis' },
                messages: [{
                    role: 'user',
                    content: [
                        ...contentBlocks,
                        { type: 'text', text: '이 시험지의 모든 문항을 분석해줘.' }
                    ]
                }]
            });

            const toolUse = message.content.find(block => block.type === 'tool_use');
            if (!toolUse) {
                return res.status(502).json({ success: false, message: 'AI가 구조화된 결과를 반환하지 않았습니다.' });
            }

            res.json({ success: true, questions: toolUse.input.questions });
        } catch (error) {
            console.error('시험지 분석 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    app.post('/api/save-exam-analysis', requireAuth, requireOwner, async (req, res) => {
        const { school, grade, year, semester, examType, questions } = req.body;

        if (!school || !grade || !year || !semester || !examType) {
            return res.status(400).json({ success: false, message: '학교/학년/시험년도/학기/시험종류를 모두 입력해주세요.' });
        }
        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ success: false, message: '저장할 문항이 없습니다.' });
        }
        if (!dbIds?.EXAM_DB_ID || !dbIds?.QUESTION_DB_ID) {
            return res.status(500).json({ success: false, message: 'EXAM_DB_ID / QUESTION_DB_ID가 설정되지 않았습니다.' });
        }

        const examTitle = `${school} ${grade} ${year} ${semester} ${examType}`;

        try {
            // 1) 부모 시험 페이지 생성 (시험 1개 = 1줄)
            const examPage = await fetchNotion('https://api.notion.com/v1/pages', {
                method: 'POST',
                body: JSON.stringify({
                    parent: { database_id: dbIds.EXAM_DB_ID },
                    properties: {
                        '시험명': { title: [{ text: { content: examTitle } }] },
                        '학교': { select: { name: school } },
                        '학년': { select: { name: grade } },
                        '시험년도': { number: Number(year) },
                        '학기': { select: { name: semester } },
                        '시험종류': { select: { name: examType } },
                        '문항수': { number: questions.length },
                        '등록자': { rich_text: [{ text: { content: req.user.name || req.user.loginId } }] }
                    }
                })
            });

            // 2) 문항별 페이지 생성 (문항 1개 = 1줄, 시험 relation으로 연결)
            //    Notion 페이지 생성은 개별 요청이라 순차 처리(속도보다 안정성 우선)
            for (const q of questions) {
                const props = {
                    '번호': { title: [{ text: { content: String(q.number ?? '') } }] },
                    '시험': { relation: [{ id: examPage.id }] },
                    '배점': { number: Number(q.score) || 0 },
                    '문법포인트': { rich_text: [{ text: { content: String(q.grammar_point ?? '') } }] },
                    '정답': { rich_text: [{ text: { content: String(q.answer ?? '') } }] }
                };
                if (q.type) props['유형'] = { select: { name: q.type } };
                if (q.source_type) props['출제범위'] = { select: { name: q.source_type } };
                if (q.difficulty) props['난이도'] = { select: { name: q.difficulty } };

                await fetchNotion('https://api.notion.com/v1/pages', {
                    method: 'POST',
                    body: JSON.stringify({ parent: { database_id: dbIds.QUESTION_DB_ID }, properties: props })
                });
            }

            res.json({ success: true, pageId: examPage.id, examTitle, savedCount: questions.length });
        } catch (error) {
            console.error('시험지 분석 저장 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 저장된 정답지(시험) 목록 — 학생 채점 시 드롭다운용
    app.get('/api/exam-list', requireAuth, requireOwner, async (req, res) => {
        if (!dbIds?.EXAM_DB_ID) {
            return res.status(500).json({ success: false, message: 'EXAM_DB_ID가 설정되지 않았습니다.' });
        }
        try {
            const exams = await listExams(fetchNotion, dbIds.EXAM_DB_ID);
            res.json({ success: true, exams });
        } catch (error) {
            console.error('시험 목록 조회 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ── 학생 셀프 답안 입력 (플래너에서 학생이 직접 입력) ──────────────
    // 학생이 답안을 낼 수 있는 시험 목록 (저장된 시험 전부 노출)
    app.get('/api/student/exam-list', requireAuth, requireStudent, async (req, res) => {
        if (!dbIds?.EXAM_DB_ID) {
            return res.status(500).json({ success: false, message: '시험 목록을 불러올 수 없습니다.' });
        }
        try {
            const exams = await listExams(fetchNotion, dbIds.EXAM_DB_ID);
            res.json({ success: true, exams });
        } catch (error) {
            console.error('학생 시험 목록 조회 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 선택한 시험의 문항 목록 — ⚠️ 정답은 절대 내려주지 않는다 (학생에게 답 유출 금지)
    app.get('/api/student/exam-questions', requireAuth, requireStudent, async (req, res) => {
        const { examPageId } = req.query;
        if (!examPageId) return res.status(400).json({ success: false, message: '시험을 선택해주세요.' });
        if (!dbIds?.QUESTION_DB_ID) {
            return res.status(500).json({ success: false, message: '문항을 불러올 수 없습니다.' });
        }
        try {
            const key = await loadAnswerKey(fetchNotion, dbIds.QUESTION_DB_ID, examPageId);
            // 정답(answer)·문법포인트는 제외하고 번호·유형·배점만 전달
            const questions = key.map(q => ({ number: q.number, type: q.type, score: q.score }));
            res.json({ success: true, questions });
        } catch (error) {
            console.error('학생 문항 조회 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 학생 답안 제출 — 서버가 정답지와 대조해 채점(객관식 자동, 서술형 채점대기) 후 저장
    app.post('/api/student/submit-exam', requireAuth, requireStudent, async (req, res) => {
        const { examPageId, answers } = req.body;
        const studentName = req.user.name;
        if (!examPageId) return res.status(400).json({ success: false, message: '시험을 선택해주세요.' });
        if (!Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({ success: false, message: '제출할 답안이 없습니다.' });
        }
        if (!dbIds?.QUESTION_DB_ID || !dbIds?.STUDENT_RESULT_DB_ID || !dbIds?.STUDENT_ANSWER_DB_ID) {
            return res.status(500).json({ success: false, message: 'DB ID가 설정되지 않았습니다.' });
        }

        try {
            // 중복 제출 차단 (같은 학생이 같은 시험을 이미 냈으면 막음 — 재제출은 선생님이 삭제 후 가능)
            const dup = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_RESULT_DB_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    filter: { and: [
                        { property: '학생명', title: { equals: studentName } },
                        { property: '시험', relation: { contains: examPageId } }
                    ] },
                    page_size: 1
                })
            });
            if (dup.results.length > 0) {
                return res.status(409).json({ success: false, message: '이미 제출한 시험이에요. 다시 제출하려면 선생님께 문의하세요.' });
            }

            const answerKey = await loadAnswerKey(fetchNotion, dbIds.QUESTION_DB_ID, examPageId);
            if (answerKey.length === 0) {
                return res.status(400).json({ success: false, message: '이 시험의 문항을 찾을 수 없어요. 선생님께 문의하세요.' });
            }

            const studentMap = {};
            for (const a of answers) studentMap[normalizeAnswer(a.number)] = a.student_answer || '';
            const graded = gradeAgainstKey(answerKey, studentMap);

            // 시험 메타(학교/학년/시험종류) 채우기 — 실패해도 저장은 진행
            const meta = { examPageId, studentName, registeredBy: `${studentName} (학생제출)` };
            try {
                const examPage = await fetchNotion(`https://api.notion.com/v1/pages/${examPageId}`);
                const EP = examPage.properties;
                meta.school = EP['학교']?.select?.name || '';
                meta.grade = EP['학년']?.select?.name || '';
                meta.examType = EP['시험종류']?.select?.name || '';
            } catch (e) { /* 메타 없으면 생략 */ }

            const saved = await persistStudentResult(fetchNotion, dbIds, meta, graded);
            const essayPending = graded.some(g => g.type === '서술형');
            res.json({
                success: true,
                score: saved.score,
                fullScore: saved.fullScore,
                total: graded.length,
                autoScored: graded.filter(g => g.type !== '서술형').length,
                essayPending
            });
        } catch (error) {
            console.error('학생 답안 제출 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 학생 답안 채점 — 정답지와 대조해 문항별 정오/점수 산출(서술형은 채점대기)
    app.post('/api/grade-student', requireAuth, requireOwner, uploadImages, async (req, res) => {
        if (!anthropic) {
            return res.status(500).json({ success: false, message: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
        }
        const { examPageId, studentName } = req.body;
        if (!examPageId) return res.status(400).json({ success: false, message: '채점할 시험을 선택해주세요.' });
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: '학생 답안 이미지를 최소 1장 업로드해주세요.' });
        }
        if (!dbIds?.QUESTION_DB_ID) {
            return res.status(500).json({ success: false, message: 'QUESTION_DB_ID가 설정되지 않았습니다.' });
        }

        try {
            const answerKey = await loadAnswerKey(fetchNotion, dbIds.QUESTION_DB_ID, examPageId);
            if (answerKey.length === 0) {
                return res.status(400).json({ success: false, message: '이 시험의 정답지 문항을 찾을 수 없습니다. 먼저 시험지 분석을 저장했는지 확인해주세요.' });
            }

            const contentBlocks = filesToContentBlocks(req.files);
            const numbers = answerKey.map(q => q.number).join(', ');

            const message = await anthropic.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 4096,
                system: GRADING_SYSTEM_PROMPT,
                tools: [GRADING_TOOL],
                tool_choice: { type: 'tool', name: 'submit_student_answers' },
                messages: [{
                    role: 'user',
                    content: [
                        ...contentBlocks,
                        { type: 'text', text: `이 답안지의 문항 번호는 다음과 같다: ${numbers}. 각 번호에 학생이 표기/작성한 답을 읽어줘.` }
                    ]
                }]
            });

            const toolUse = message.content.find(block => block.type === 'tool_use');
            if (!toolUse) {
                return res.status(502).json({ success: false, message: 'AI가 학생 답안을 읽지 못했습니다.' });
            }

            const studentMap = {};
            for (const a of toolUse.input.answers || []) {
                studentMap[normalizeAnswer(a.number)] = a.student_answer || '';
            }

            // 정답지 기준으로 대조 채점 (객관식 자동, 서술형 채점대기)
            const graded = gradeAgainstKey(answerKey, studentMap);

            res.json({ success: true, examPageId, studentName: studentName || '', graded });
        } catch (error) {
            console.error('학생 채점 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 채점 결과 저장 — 학생 응시 결과 1행 + 문항별 응답 여러 행
    app.post('/api/save-student-result', requireAuth, requireOwner, async (req, res) => {
        const { examPageId, studentName, school, grade, examType, graded } = req.body;

        if (!examPageId || !studentName) {
            return res.status(400).json({ success: false, message: '시험과 학생 이름이 필요합니다.' });
        }
        if (!Array.isArray(graded) || graded.length === 0) {
            return res.status(400).json({ success: false, message: '저장할 채점 결과가 없습니다.' });
        }
        if (!dbIds?.STUDENT_RESULT_DB_ID || !dbIds?.STUDENT_ANSWER_DB_ID) {
            return res.status(500).json({ success: false, message: 'STUDENT_RESULT_DB_ID / STUDENT_ANSWER_DB_ID가 설정되지 않았습니다.' });
        }

        try {
            const saved = await persistStudentResult(fetchNotion, dbIds, {
                examPageId, studentName, school, grade, examType,
                registeredBy: req.user.name || req.user.loginId
            }, graded);
            res.json({ success: true, ...saved });
            // 서술형 채점이 남았으면 점수가 바뀔 수 있으니 미리 만들지 않는다(그땐 원장이 열 때 만든다)
            if (!graded.some(g => g.verdict === '채점대기')) warmReport(saved.pageId, graded.length);
        } catch (error) {
            console.error('학생 결과 저장 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 저장된 학생 응시 결과 목록 (시험/이름으로 필터)
    app.get('/api/student-results', requireAuth, requireOwner, async (req, res) => {
        if (!dbIds?.STUDENT_RESULT_DB_ID) {
            return res.status(500).json({ success: false, message: 'STUDENT_RESULT_DB_ID가 설정되지 않았습니다.' });
        }
        const { examPageId, name } = req.query;
        try {
            const conditions = [];
            if (examPageId) conditions.push({ property: '시험', relation: { contains: examPageId } });
            if (name) conditions.push({ property: '학생명', title: { contains: name } });

            let results = [];
            let cursor;
            do {
                const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
                if (conditions.length === 1) body.filter = conditions[0];
                else if (conditions.length > 1) body.filter = { and: conditions };
                if (cursor) body.start_cursor = cursor;
                const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_RESULT_DB_ID}/query`, {
                    method: 'POST', body: JSON.stringify(body)
                });
                results = results.concat(data.results);
                cursor = data.has_more ? data.next_cursor : undefined;
            } while (cursor);

            const list = results.map(p => {
                const P = p.properties;
                return {
                    resultId: p.id,
                    studentName: P['학생명']?.title?.[0]?.plain_text || '',
                    examPageId: P['시험']?.relation?.[0]?.id || '',
                    school: P['학교']?.select?.name || '',
                    grade: P['학년']?.select?.name || '',
                    examType: P['시험종류']?.select?.name || '',
                    score: P['점수']?.number ?? 0,
                    fullScore: P['만점']?.number ?? 0,
                    correctCount: P['정답수']?.number ?? 0,
                    wrongCount: P['오답수']?.number ?? 0,
                    weakTypes: (P['취약유형']?.multi_select || []).map(x => x.name),
                    weakGrammar: P['취약문법']?.rich_text?.[0]?.plain_text || '',
                    essayStatus: P['서술형채점']?.select?.name || '',
                    report: P['리포트']?.rich_text?.[0]?.plain_text || '',
                    createdTime: p.created_time
                };
            });
            res.json({ success: true, results: list });
        } catch (error) {
            console.error('학생 결과 목록 조회 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 한 학생 결과의 문항별 상세
    app.get('/api/student-result-detail', requireAuth, requireOwner, async (req, res) => {
        if (!dbIds?.STUDENT_ANSWER_DB_ID) {
            return res.status(500).json({ success: false, message: 'STUDENT_ANSWER_DB_ID가 설정되지 않았습니다.' });
        }
        const { resultId } = req.query;
        if (!resultId) return res.status(400).json({ success: false, message: 'resultId가 필요합니다.' });
        try {
            // 출제범위는 문항 응답 DB에 없으므로, 이 결과의 시험 정답지와 조인해서 번호별로 채운다
            const sourceByNumber = {};
            try {
                const rp = await fetchNotion(`https://api.notion.com/v1/pages/${resultId}`);
                const examPageId = rp.properties['시험']?.relation?.[0]?.id || '';
                if (examPageId && dbIds.QUESTION_DB_ID) {
                    const key = await loadAnswerKey(fetchNotion, dbIds.QUESTION_DB_ID, examPageId);
                    key.forEach(k => { sourceByNumber[k.number] = k.source_type; });
                }
            } catch (e) { /* 정답지 없으면 출제범위 생략 */ }

            let rows = [];
            let cursor;
            do {
                const body = { filter: { property: '학생결과', relation: { contains: resultId } }, page_size: 100 };
                if (cursor) body.start_cursor = cursor;
                const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_ANSWER_DB_ID}/query`, {
                    method: 'POST', body: JSON.stringify(body)
                });
                rows = rows.concat(data.results);
                cursor = data.has_more ? data.next_cursor : undefined;
            } while (cursor);

            const questions = rows.map(p => {
                const P = p.properties;
                const number = P['번호']?.title?.[0]?.plain_text || '';
                return {
                    number,
                    type: P['유형']?.select?.name || '',
                    source_type: sourceByNumber[number] || '',
                    grammar_point: P['문법포인트']?.rich_text?.[0]?.plain_text || '',
                    answer: P['정답']?.rich_text?.[0]?.plain_text || '',
                    student_answer: P['학생답']?.rich_text?.[0]?.plain_text || '',
                    verdict: P['정오']?.select?.name || '',
                    score: P['배점']?.number ?? 0,
                    earned: P['획득점수']?.number ?? 0
                };
            }).sort((a, b) => naturalNumberSort(a.number, b.number));

            res.json({ success: true, questions });
        } catch (error) {
            console.error('학생 결과 상세 조회 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 정답지 수정 후 재채점 — 그 시험 응시 학생 전원을 현재 정답지로 다시 채점.
    // 객관식은 저장된 학생답으로 재계산, 서술형은 선생님이 매긴 점수(부분점수 포함) 보존.
    app.post('/api/regrade-exam', requireAuth, requireOwner, async (req, res) => {
        const { examPageId } = req.body;
        if (!examPageId) return res.status(400).json({ success: false, message: '재채점할 시험을 선택해주세요.' });
        if (!dbIds?.QUESTION_DB_ID || !dbIds?.STUDENT_RESULT_DB_ID || !dbIds?.STUDENT_ANSWER_DB_ID) {
            return res.status(500).json({ success: false, message: 'DB ID가 설정되지 않았습니다.' });
        }
        try {
            // 현재(수정된) 정답지
            const key = await loadAnswerKey(fetchNotion, dbIds.QUESTION_DB_ID, examPageId);
            if (key.length === 0) {
                return res.status(400).json({ success: false, message: '이 시험의 정답지를 찾을 수 없습니다.' });
            }
            const keyByNum = {};
            key.forEach(k => { keyByNum[normalizeAnswer(k.number)] = k; });

            // 캐시된 AI 코멘트를 비울 수 있도록 속성 보장(없으면 추가). 권한 없으면 무시하고 진행.
            try { await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, 'AI코멘트', { rich_text: {} }); } catch (e) { /* noop */ }
            try { await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, '리포트AI', { rich_text: {} }); } catch (e) { /* noop */ }
            try { await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, '학부모리포트', { rich_text: {} }); } catch (e) { /* noop */ }
            try { await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, '공개일시', { date: {} }); } catch (e) { /* noop */ }

            // 이 시험의 모든 학생 결과
            let results = [];
            let cursor;
            do {
                const body = { filter: { property: '시험', relation: { contains: examPageId } }, page_size: 100 };
                if (cursor) body.start_cursor = cursor;
                const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_RESULT_DB_ID}/query`, {
                    method: 'POST', body: JSON.stringify(body)
                });
                results = results.concat(data.results);
                cursor = data.has_more ? data.next_cursor : undefined;
            } while (cursor);

            let regradedCount = 0;
            const regradedIds = [];
            for (const rp of results) {
                const resultId = rp.id;

                // 학생 문항 응답 행
                let ansRows = [];
                let c2;
                do {
                    const body = { filter: { property: '학생결과', relation: { contains: resultId } }, page_size: 100 };
                    if (c2) body.start_cursor = c2;
                    const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_ANSWER_DB_ID}/query`, {
                        method: 'POST', body: JSON.stringify(body)
                    });
                    ansRows = ansRows.concat(data.results);
                    c2 = data.has_more ? data.next_cursor : undefined;
                } while (c2);

                // 저장된 학생답 + 현재 정답지로 재구성
                const graded = ansRows.map(r => {
                    const P = r.properties;
                    const number = P['번호']?.title?.[0]?.plain_text || '';
                    const studentAnswer = P['학생답']?.rich_text?.[0]?.plain_text || '';
                    const prevVerdict = P['정오']?.select?.name || '';
                    const prevEarned = P['획득점수']?.number ?? 0;
                    const k = keyByNum[normalizeAnswer(number)];
                    if (!k) {
                        // 현재 정답지에 없는 번호 → 기존 값 유지
                        return {
                            _rowId: r.id, number,
                            type: P['유형']?.select?.name || '',
                            grammar_point: P['문법포인트']?.rich_text?.[0]?.plain_text || '',
                            answer: P['정답']?.rich_text?.[0]?.plain_text || '',
                            student_answer: studentAnswer, verdict: prevVerdict,
                            score: P['배점']?.number ?? 0, earned: prevEarned
                        };
                    }
                    const base = { _rowId: r.id, number, type: k.type, grammar_point: k.grammar_point, answer: k.answer, student_answer: studentAnswer, score: k.score };
                    if (k.type === '서술형') {
                        // 선생님이 매긴 정오·점수 보존 (배점 바뀌면 computeResultSummary가 보정)
                        return { ...base, verdict: prevVerdict || '채점대기', earned: prevEarned };
                    }
                    const correct = studentAnswer && normalizeAnswer(studentAnswer) === normalizeAnswer(k.answer);
                    return { ...base, verdict: correct ? '정답' : '오답', earned: correct ? k.score : 0 };
                });

                const sum = computeResultSummary(graded);

                // 문항 행 업데이트 (정답·배점·유형·정오·획득점수 갱신)
                for (const g of sum.rows) {
                    await fetchNotion(`https://api.notion.com/v1/pages/${g._rowId}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ properties: buildAnswerProps(g, null) })
                    });
                }
                // 결과 총점 갱신 + 캐시된 AI 코멘트 비우기(정답지 바뀌었으니 리포트 재생성되도록)
                const resultProps = buildResultProps(sum, {});
                resultProps['AI코멘트'] = { rich_text: [] };
                resultProps['리포트AI'] = { rich_text: [] };
                // 점수가 바뀌었을 수 있으니 학부모 공개도 푼다 — 원장이 다시 확인하고 [학부모 공개]
                resultProps['학부모리포트'] = { rich_text: [] };
                resultProps['공개일시'] = { date: null };
                await fetchNotion(`https://api.notion.com/v1/pages/${resultId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties: resultProps })
                });
                regradedCount++;
                regradedIds.push([resultId, ansRows.length]);
            }

            res.json({ success: true, regradedCount });
            // 재채점으로 비운 리포트 문구를 뒤에서 한 명씩 다시 만들어 둔다(Gemini 를 한꺼번에 몰지 않는다)
            (async () => { for (const [id, n] of regradedIds) await warmReport(id, n); })();
        } catch (error) {
            console.error('재채점 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 학생·학부모용 분석 리포트 데이터 (규칙 기반 대책 + AI 종합 코멘트)
    // 리포트 데이터를 만든다 — 화면(/api/student-report-data)과 채점 저장 뒤 미리 만들기(warmReport)가 같이 쓴다.
    // 속도(2026-10-03, 처음 열 때 8~10초였다): 서로 기다릴 필요 없는 노션 읽기·Gemini 두 번을 동시에 돌리고,
    // AI 문구 저장은 한 번의 PATCH 로 묶어 화면을 띄운 뒤에 한다(waitForSave=false).
    async function buildReport(resultId, { waitForSave = false, expectedCount = null } = {}) {
            const t0 = Date.now();
            // 1) 결과 페이지 + 학생 문항 응답 — 둘 다 resultId 만 있으면 되니 동시에
            const loadAnswers = async () => {
                let rows = [];
                let cursor;
                do {
                    const body = { filter: { property: '학생결과', relation: { contains: resultId } }, page_size: 100 };
                    if (cursor) body.start_cursor = cursor;
                    const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.STUDENT_ANSWER_DB_ID}/query`, {
                        method: 'POST', body: JSON.stringify(body)
                    });
                    rows = rows.concat(data.results);
                    cursor = data.has_more ? data.next_cursor : undefined;
                } while (cursor);
                return rows;
            };
            const [resultPage, ansRows] = await Promise.all([
                fetchNotion(`https://api.notion.com/v1/pages/${resultId}`),
                loadAnswers()
            ]);
            // 막 저장한 결과는 노션 검색에 늦게 잡힐 수 있다 — 문항이 덜 읽혔으면 AI 를 부르지 않고 멈춘다(미리 만들기 전용)
            if (expectedCount != null && ansRows.length < expectedCount) {
                const err = new Error(`문항 ${ansRows.length}/${expectedCount} — 아직 노션에 다 안 잡혔다`);
                err.incomplete = true;
                throw err;
            }
            const RP = resultPage.properties;
            const studentName = RP['학생명']?.title?.[0]?.plain_text || '';
            const examPageId = RP['시험']?.relation?.[0]?.id || '';
            const summary = {
                score: RP['점수']?.number ?? 0,
                fullScore: RP['만점']?.number ?? 0,
                correctCount: RP['정답수']?.number ?? 0,
                wrongCount: RP['오답수']?.number ?? 0,
                essayStatus: RP['서술형채점']?.select?.name || ''
            };
            summary.percent = summary.fullScore > 0 ? Math.round((summary.score / summary.fullScore) * 100) : 0;

            // 2) 시험 정보(제목 등)
            let examInfo = {
                school: RP['학교']?.select?.name || '',
                grade: RP['학년']?.select?.name || '',
                examType: RP['시험종류']?.select?.name || '',
                examTitle: '', semester: '', year: null
            };
            // 2) 시험 정보 + 정답지(출제범위·난이도) — 둘 다 시험 ID 만 있으면 되니 동시에
            const [examPage, key] = examPageId
                ? await Promise.all([
                    fetchNotion(`https://api.notion.com/v1/pages/${examPageId}`).catch(() => null), // 없으면 결과행 정보로 대체
                    loadAnswerKey(fetchNotion, dbIds.QUESTION_DB_ID, examPageId)
                ])
                : [null, []];
            if (examPage) {
                const EP = examPage.properties;
                examInfo.examTitle = EP['시험명']?.title?.[0]?.plain_text || '';
                examInfo.semester = EP['학기']?.select?.name || '';
                examInfo.year = EP['시험년도']?.number || null;
            }

            // 3) 학생 문항 응답 + 정답지 조인
            const sourceByNumber = {};
            const difficultyByNumber = {};
            key.forEach(k => { sourceByNumber[k.number] = k.source_type; difficultyByNumber[k.number] = k.difficulty; });

            const questions = ansRows.map(p => {
                const P = p.properties;
                const number = P['번호']?.title?.[0]?.plain_text || '';
                return {
                    number,
                    type: P['유형']?.select?.name || '',
                    source_type: sourceByNumber[number] || '',
                    difficulty: difficultyByNumber[number] || '',
                    grammar_point: P['문법포인트']?.rich_text?.[0]?.plain_text || '',
                    answer: P['정답']?.rich_text?.[0]?.plain_text || '',
                    student_answer: P['학생답']?.rich_text?.[0]?.plain_text || '',
                    verdict: P['정오']?.select?.name || '',
                    score: P['배점']?.number ?? 0,
                    earned: P['획득점수']?.number ?? 0
                };
            }).sort((a, b) => naturalNumberSort(a.number, b.number));

            // 4) 강점/약점 집계
            const perType = {};
            questions.forEach(q => {
                if (!q.type) return;
                perType[q.type] = perType[q.type] || { correct: 0, wrong: 0, total: 0 };
                perType[q.type].total++;
                if (q.verdict === '정답') perType[q.type].correct++;
                // 부분점수는 완전히 맞춘 게 아니므로 약점 분석에서 오답과 함께 취급
                else if (q.verdict === '오답' || q.verdict === '부분') perType[q.type].wrong++;
            });
            const strengths = Object.entries(perType).filter(([, v]) => v.wrong === 0 && v.correct > 0).map(([type]) => type);
            const weakTypes = Object.entries(perType).filter(([, v]) => v.wrong > 0).map(([type, v]) => ({ type, wrong: v.wrong, total: v.total }));
            const wrongQuestions = questions.filter(q => q.verdict === '오답' || q.verdict === '부분');
            const weakSources = [...new Set(wrongQuestions.map(q => q.source_type).filter(Boolean))];
            const weakGrammar = [...new Set(wrongQuestions.map(q => q.grammar_point).filter(Boolean))];

            // 5) 규칙 기반 대책
            const recommendations = [];
            weakTypes.forEach(w => { if (TYPE_ADVICE[w.type]) recommendations.push(TYPE_ADVICE[w.type]); });
            weakSources.forEach(s => { if (SOURCE_ADVICE[s]) recommendations.push(SOURCE_ADVICE[s]); });
            if (weakGrammar.length) recommendations.push(`특히 다음 문법을 집중 복습하세요: ${weakGrammar.join(', ')}.`);
            const dedupRecs = [...new Set(recommendations)];

            // 6) AI 종합 코멘트 — 처음 1번만 생성해 저장하고, 이후엔 캐시 재사용(AI 호출 비용 절감·문구 고정)
            //    리포트AI 의 프롬프트 버전이 지금과 다르면 두 캐시를 모두 버리고 새 프롬프트로 다시 만든다.
            let parentReport = null;
            try { parentReport = JSON.parse(readRichText(RP['리포트AI']) || 'null'); } catch (e) { parentReport = null; }
            const cacheFresh = !!(parentReport && parentReport.v === REPORT_PROMPT_VERSION);
            if (!cacheFresh) parentReport = null;
            let overallComment = cacheFresh ? (RP['AI코멘트']?.rich_text?.[0]?.plain_text || '') : '';
            const difficultyLines = summarizeByDifficulty(questions);
            const cov = findCoverage(loadCoverage(), examInfo);
            const coveragePoints = (cov?.points || []).map(p => p.label || p.code).filter(Boolean);
            const coverageLine = cov && coveragePoints.length
                ? `학원에서 이 시험 대비로 동형 모의고사 ${cov.mock_sets || 5}세트를 만들어 학생이 모두 풀었다. 그 세트가 집중 연습시킨 어법 포인트: ${coveragePoints.join(', ')}`
                : '';
            const brief = `학생: ${studentName} / 시험: ${examInfo.examTitle || (examInfo.school + ' ' + examInfo.grade)} `
                + `/ 점수: ${summary.score}점(만점 ${summary.fullScore}, ${summary.percent}%) `
                + `/ 강점 유형: ${strengths.join(', ') || '없음'} `
                + `/ 약점 유형: ${weakTypes.map(w => w.type).join(', ') || '없음'} `
                + `/ 약점 어법(문법): ${weakGrammar.join(', ') || '없음'} `
                + `/ 약점 출제범위: ${weakSources.join(', ') || '없음'}`
                + (difficultyLines ? `\n[난이도별 결과]\n${difficultyLines}` : '')
                + (coverageLine ? `\n[학원 내신 대비]\n${coverageLine}` : '');
            const aiSaves = {}; // 이번에 새로 만든 AI 문구 — 끝에서 PATCH 한 번으로 저장
            const commentTask = (async () => {
            if (!overallComment && geminiModel) {
                try {
                    const prompt = `너는 '리디튜드' 영어학원의 담임 선생님이며, 학부모님께 보내는 시험 분석 코멘트를 작성한다. 아래 [요약]을 바탕으로 진지하고 전문적인 어조의 코멘트를 작성해라.\n`
                        + `- 정중한 존댓말(~합니다/~됩니다체)로, 차분하고 신뢰감 있는 전문가의 어조를 유지한다. 과하게 경쾌한 표현·느낌표 남발·감탄사는 피한다.\n`
                        + `- 인사말이나 자기소개("안녕하세요 ~어머님", "~입니다") 없이 분석 내용부터 시작한다.\n`
                        + `- 강점이 있으면 한 문장으로 간단히 짚은 뒤 보완점으로 넘어간다.\n`
                        + `- 약점 어법(문법)이 있으면 어떤 문법에서 어려움을 보였는지 구체적으로 언급하고, 그 부분을 다음 시험에서 헷갈리지 않도록 학원에서 어떻게 지도할지(반복 점검·개념 재정리 등)를 밝힌다.\n`
                        + `- 약점 출제범위(교과서 본문/외부 지문/대화문/학습지)가 있으면 어느 영역의 학습이 부족한지 짚고 보완 방향을 제시한다.\n`
                        + `- 학생이 해당 부분을 꾸준히 반복 학습하여 완전 학습에 이르도록 독려하는 내용을 포함한다.\n`
                        + (difficultyLines
                            ? `- [난이도별 결과]를 반드시 반영한다.\n`
                              + `  · 상 난이도 문항을 맞힌 것이 있으면 어떤 영역(유형·문법)의 어려운 문항을 해결했는지 구체적으로 짚어 칭찬한다.\n`
                              + `  · 하 난이도 문항을 틀린 것이 있으면 따로 분석한다. 쉬운 문항의 실점은 개념 부족보다 문제·선택지를 끝까지 확인하지 않은 실수, 본문·어휘 암기 누락, 시간 배분 같은 원인일 가능성이 크다. 유형·출제범위·문법포인트를 근거로 왜 그런 일이 생겼을지 추정하되 단정하지 말고, 어떻게 개선할지(검토 습관·암기 점검 등)를 구체적으로 제시한다.\n`
                              + `  · 하·중 난이도에서의 실점은 점수와 직결되므로, 이를 줄이기 위한 보완책을 따로 한 두 문장으로 밝힌다.\n`
                              + `  · 하 난이도 오답이 없으면 기본 문항을 안정적으로 처리했다고 짚는다.\n`
                            : '')
                        + (coverageLine
                            ? `- [학원 내신 대비]를 반드시 반영한다. 틀린 문항의 문법(약점 어법)이 대비 포인트와 같은 내용이면(표현이 달라도 같은 문법이면 같은 것으로 본다):\n`
                              + `  · "학원에서 동형 모의고사로 반복해 풀어 본 포인트인데 실전에서 실점했다 — 알고는 있으나 완전히 숙지하지 못했다"는 취지로 분명히 짚는다.\n`
                              + `  · 학생 탓으로만 끝내지 말고, 기말 대비에서 학원이 그 포인트를 어떻게 다시 굳힐지(실전 시간 재기·변형 반복·오답 재풀이 등)를 바로 이어 쓴다.\n`
                              + `  · 대비 포인트에 없던 문법을 틀렸다면 학교가 새롭게 낸 부분으로 보고, 다음 대비 자료에 반영하겠다고 쓴다.\n`
                              + `  · 대비 포인트 문항을 맞혔다면 대비 학습이 실전으로 이어졌다고 짧게 짚을 수 있다.\n`
                            : '')
                        + `- 점수 숫자를 단순 나열하지 말고, 별표(*)나 따옴표 강조는 쓰지 않는다.\n`
                        + `- ${difficultyLines ? '7~9' : '5~7'}문장 분량의 자연스러운 문단으로 작성한다.\n\n[요약]\n${brief}`;
                    const result = await geminiModel.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.4, maxOutputTokens: 1600, thinkingConfig: { thinkingBudget: 512 } }
                    });
                    overallComment = result.response.text().trim();
                    // 생성 성공 시 결과 페이지에 저장 → 다음 조회부터 재사용(추가 AI 호출 없음)
                    if (overallComment) aiSaves['AI코멘트'] = { rich_text: [{ text: { content: overallComment.slice(0, 1900) } }] };
                } catch (e) { console.error('리포트 AI 코멘트 오류:', e.message); }
            }
            })();
            const commentFallback = () => {
            if (!overallComment) {
                // Gemini 미사용/실패 시 규칙 기반 폴백 (동일한 전문가 톤)
                const hardRight = questions.filter(q => q.difficulty === '상' && q.verdict === '정답');
                const easyWrong = wrongQuestions.filter(q => q.difficulty === '하');
                overallComment = `${hardRight.length ? `난이도가 높은 ${hardRight.map(q => q.number + '번').join(', ')} 문항을 정확히 해결한 점은 높이 평가할 만합니다. ` : ''}`
                    + `${easyWrong.length ? `다만 비교적 쉬운 ${easyWrong.map(q => q.number + '번').join(', ')} 문항의 실점은 끝까지 확인하는 습관으로 충분히 줄일 수 있는 부분입니다. ` : ''}`
                    + `${studentName} 학생은 `
                    + `${strengths.length ? strengths.join(', ') + ' 유형에서는 안정적인 이해를 보였습니다. ' : ''}`
                    + `${weakGrammar.length ? '다만 ' + weakGrammar.join(', ') + ' 등의 어법에서 보완이 필요합니다. ' : ''}`
                    + `${weakSources.length ? weakSources.join(', ') + ' 영역의 학습을 한 번 더 점검할 것을 권합니다. ' : ''}`
                    + `${weakTypes.length ? weakTypes.map(w => w.type).join(', ') + ' 유형을 중심으로 반복 학습하여 완전한 이해에 이르도록 학원에서 지도하겠습니다.' : '전반적으로 안정적인 결과이며, 현재 수준을 꾸준히 유지하도록 지도하겠습니다.'}`;
            }
            };


            // 7) 학부모 발송용 리포트 문구 — 핵심 진단 한 줄 + 틀린 문항별 오답 요인(추정) + 대처 방안 + 학습 브리핑.
            //    AI코멘트와 같은 방식으로 처음 1번만 만들어 '리포트AI' 칸에 저장하고 재사용한다(재채점 시 비워짐).
            //    시험 기간 학습 태도 — 채점일 기준 최근 30일의 진도 기록과 선생님 일일 코멘트. 시험일은 따로 저장하지 않아서
            //    채점일을 끝으로 잡는다. 진도 읽기 → Gemini 순서지만, 종합 코멘트와는 동시에 돈다.
            const studyTo = (resultPage.created_time || new Date().toISOString()).slice(0, 10);
            const studyFrom = new Date(new Date(studyTo + 'T00:00:00Z').getTime() - 30 * 86400000).toISOString().slice(0, 10);
            const reportTask = (async () => {
            let study = null;
            if (!parentReport && loadStudyPeriod && studentName) {
                try { study = await loadStudyPeriod(studentName, studyFrom, studyTo); }
                catch (e) { console.error('시험 기간 진도 읽기 실패:', e.message); }
            }
            const hasStudy = !!(study && study.classDays > 0);

            if (!parentReport && geminiModel) {
                try {
                    const wrongLines = wrongQuestions.map(q =>
                        `- ${q.number}번 | 난이도: ${q.difficulty || '-'} | 유형: ${q.type || '-'} | 출제범위: ${q.source_type || '-'} | 문법포인트: ${q.grammar_point || '-'} | 정답: ${q.answer || '-'} | 학생답: ${q.student_answer || '(무응답)'} | ${q.verdict}`
                    ).join('\n') || '(틀린 문항 없음)';
                    const prompt = `너는 '리디튜드' 영어학원의 담임 선생님이다. 학부모님께 보내는 내신 시험 개인 분석 리포트의 문구를 JSON으로 작성한다.\n`
                        + `- diagnosis: 핵심 진단 한두 문장(80자 안팎). 무엇을 잘했고 무엇이 다음 시험의 열쇠인지. 예) "21문항 정답 — 독해는 안정적. 분사 어형 판단 한 가지가 다음 시험의 열쇠입니다."\n`
                        + `- reasons: 틀린 문항 번호를 키로, 오답 요인을 한두 문장으로. 난이도 하 문항이면 실수·확인 부족 가능성도 함께 짚는다.${coverageLine ? ' [학원 내신 대비] 포인트에 해당하는 문법이면 "동형 모의고사로 연습한 포인트인데 숙지가 미흡했던 것으로 보입니다"처럼 짚는다.' : ''} 우리는 문제 원문을 모르고 유형·문법포인트·정답·학생답만 안다. 아는 범위에서 그럴듯한 원인을 짚되 단정하지 말고 "~로 보입니다" 처럼 추정으로 쓴다. 선택지 번호만 보고 내용을 지어내지 마라.\n`
                        + `- plan: 다음 시험 대처 방안 3~4개. 각 항목은 한 줄(40자 안팎), 구체적인 학습 행동으로. 학원에서 할 지도와 학생이 할 일을 섞는다.\n`
                        + `- 정중한 존댓말, 차분한 전문가 어조. 별표·따옴표 강조·이모지 금지.\n`
                        + (hasStudy
                            ? `- attitude: [시험 기간 학습 기록]과 [선생님 일일 코멘트]만 근거로, 시험 기간 학습 태도를 네 항목으로 간결하게 브리핑한다. 각 항목은 1~2문장. 코멘트에 없는 일을 지어내지 말고, 근거가 부족한 항목은 기록에서 확인되는 범위로만 짧게 쓴다.\n`
                              + `  good: 시험 기간 중 잘 대응한 점 / regret: 시험 기간 학습 중 아쉬웠던 점 / selfImprove: 앞으로 학생이 더 주도적으로 개선해야 할 점(학생 이름을 넣어 "OO이가 ~" 형태로) / academyFocus: 학원에서 앞으로 신경 써서 지도할 점\n`
                            : `- attitude: 학습 기록이 없으므로 null.\n`)
                        + `JSON 형식: {"diagnosis": "...", "reasons": {"14": "..."}, "plan": ["...", "..."], "attitude": ${hasStudy ? '{"good": "...", "regret": "...", "selfImprove": "...", "academyFocus": "..."}' : 'null'}}\n\n`
                        + `[요약]\n${brief}\n\n[틀린 문항]\n${wrongLines}`
                        + (hasStudy
                            ? `\n\n[시험 기간 학습 기록] ${studyFrom}~${studyTo} · 수업 ${study.classDays}회 · 숙제 수행률 평균 ${study.stats.hwAvg}% · 단어 테스트 평균 ${study.stats.vocabAvg}점 · 문법 테스트 평균 ${study.stats.grammarAvg}점 · 독해 통과율 ${study.stats.readingPassRate}%`
                              + `\n\n[선생님 일일 코멘트]\n${study.comments || '(코멘트 없음)'}`
                            : '');
                    const result = await geminiModel.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.4, maxOutputTokens: 3000, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 512 } }
                    });
                    const parsed = JSON.parse(result.response.text());
                    if (parsed && typeof parsed.diagnosis === 'string' && Array.isArray(parsed.plan)) {
                        const a = parsed.attitude;
                        const attitude = hasStudy && a && a.good && a.regret && a.selfImprove && a.academyFocus
                            ? { good: a.good, regret: a.regret, selfImprove: a.selfImprove, academyFocus: a.academyFocus,
                                from: studyFrom, to: studyTo, classDays: study.classDays, hwAvg: study.stats.hwAvg, vocabAvg: study.stats.vocabAvg }
                            : null;
                        parentReport = { v: REPORT_PROMPT_VERSION, diagnosis: parsed.diagnosis.trim(), reasons: parsed.reasons || {}, plan: parsed.plan.filter(Boolean).slice(0, 4), attitude };
                        aiSaves['리포트AI'] = { rich_text: richTextChunks(JSON.stringify(parentReport)) };
                    }
                } catch (e) { console.error('학부모 리포트 AI 문구 오류:', e.message); }
            }
            })();

            await Promise.all([commentTask, reportTask]);
            commentFallback();

            // 새로 만든 AI 문구를 PATCH 한 번으로 저장. 칸이 이미 있으면 DB 스키마 확인(PATCH)을 건너뛴다.
            const aiCached = !!aiSaves['리포트AI']; // 리포트AI 가 저장돼야 다음 조회가 캐시로 끝난다
            const saveTask = (async () => {
                if (!Object.keys(aiSaves).length || !dbIds.STUDENT_RESULT_DB_ID) return;
                try {
                    for (const name of Object.keys(aiSaves)) {
                        if (!(name in RP)) await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, name, { rich_text: {} });
                    }
                    await fetchNotion(`https://api.notion.com/v1/pages/${resultId}`, {
                        method: 'PATCH', body: JSON.stringify({ properties: aiSaves })
                    });
                } catch (saveErr) { console.error('리포트 AI 문구 저장 실패:', saveErr.message); }
            })();
            if (waitForSave) await saveTask;
            // 폴백은 학습 태도를 지어내지 않는다(attitude: null → 화면에서 그 칸을 숨긴다)
            if (!parentReport) parentReport = { ...buildParentReportFallback(wrongQuestions, dedupRecs), attitude: null };

            // 선택형/서술형 나눠 보기 (리포트 상단 "선택형 85/90 · 서술형 10/10")
            const split = { objective: { earned: 0, score: 0, count: 0 }, essay: { earned: 0, score: 0, count: 0 } };
            questions.forEach(q => {
                const b = q.type === '서술형' ? split.essay : split.objective;
                b.earned += q.earned; b.score += q.score; b.count++;
            });

            console.log(`[시험 리포트] ${studentName} ${Date.now() - t0}ms ${cacheFresh ? '(캐시)' : aiCached ? '(AI 생성)' : '(AI 실패·규칙 문구)'}`);
            return {
                success: true,
                student: { name: studentName, ...examInfo, date: (resultPage.created_time || '').slice(0, 10) },
                summary,
                strengths,
                weaknesses: { types: weakTypes, sources: weakSources, grammar: weakGrammar },
                wrongQuestions,
                recommendations: dedupRecs,
                overallComment,
                parentReport,
                split,
                publishedAt: RP['공개일시']?.date?.start || null
            };
    }

    // 채점을 저장한 직후 뒤에서 리포트 AI 문구를 미리 만들어 둔다 → 원장이 열 때는 캐시로 바로 뜬다.
    // 막 만든 노션 행이 검색에 늦게 잡힐 수 있어 잠깐 기다렸다가, 문항 수가 다 맞을 때만 만든다(덜 읽힌 채로 캐시하면 안 된다).
    async function warmReport(resultId, expectedCount) {
        if (!geminiModel) return;
        for (let attempt = 1; attempt <= 4; attempt++) {
            await new Promise(r => setTimeout(r, warmDelayMs * attempt));
            try { await buildReport(resultId, { waitForSave: true, expectedCount }); return; }
            catch (e) {
                if (!e.incomplete) { console.error('리포트 미리 만들기 실패:', e.message); return; }
            }
        }
        console.error('리포트 미리 만들기 포기 — 문항이 노션에 다 안 잡혔다:', resultId);
    }

    app.get('/api/student-report-data', requireAuth, requireOwner, async (req, res) => {
        const { resultId } = req.query;
        if (!resultId) return res.status(400).json({ success: false, message: 'resultId가 필요합니다.' });
        if (!dbIds?.STUDENT_ANSWER_DB_ID || !dbIds?.QUESTION_DB_ID) {
            return res.status(500).json({ success: false, message: 'DB ID가 설정되지 않았습니다.' });
        }
        try {
            res.json(await buildReport(resultId));
        } catch (error) {
            console.error('학생 리포트 데이터 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ===== 학부모 링크 (2026-10-02) =====
    // 원장이 [학부모 공개]를 누른 순간의 리포트 화면 데이터를 결과행 '학부모리포트' 칸에 통째로 저장하고('공개일시' 기록),
    // 학부모 링크(/exam-report?id=결과ID)는 그 사본만 읽는다 — 노션 1회 조회, AI 호출 없음, 재채점해도 보낸 내용이 바뀌지 않는다.
    // 재채점하면 공개가 풀린다(점수가 바뀌었을 수 있으니 원장이 다시 확인하고 공개).

    app.post('/api/exam-report/publish', requireAuth, requireOwner, async (req, res) => {
        const { resultId, report } = req.body || {};
        if (!resultId || !report || typeof report !== 'object') {
            return res.status(400).json({ success: false, message: 'resultId와 리포트 내용이 필요합니다.' });
        }
        if (!report.student?.name || !report.summary) {
            return res.status(400).json({ success: false, message: '리포트 내용이 비어 있습니다.' });
        }
        const json = JSON.stringify({ v: 1, report });
        if (json.length > 95 * 1900) {
            return res.status(400).json({ success: false, message: '리포트가 너무 깁니다. 코멘트를 줄여 주세요.' });
        }
        try {
            await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, '학부모리포트', { rich_text: {} });
            await ensureDbProperty(fetchNotion, dbIds.STUDENT_RESULT_DB_ID, '공개일시', { date: {} });
            const publishedAt = new Date().toISOString();
            await fetchNotion(`https://api.notion.com/v1/pages/${resultId}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties: {
                    '학부모리포트': { rich_text: richTextChunks(json) },
                    '공개일시': { date: { start: publishedAt } }
                } })
            });
            res.json({ success: true, publishedAt, path: `/exam-report?id=${resultId}` });
        } catch (error) {
            console.error('학부모 리포트 공개 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    app.post('/api/exam-report/unpublish', requireAuth, requireOwner, async (req, res) => {
        const { resultId } = req.body || {};
        if (!resultId) return res.status(400).json({ success: false, message: 'resultId가 필요합니다.' });
        try {
            await fetchNotion(`https://api.notion.com/v1/pages/${resultId}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties: { '학부모리포트': { rich_text: [] }, '공개일시': { date: null } } })
            });
            res.json({ success: true });
        } catch (error) {
            console.error('학부모 리포트 공개 취소 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 🔓 로그인 없음 — 학부모가 여는 주소. 32자리 노션 ID 가 열쇠다(데일리 리포트 /report?pageId= 와 같은 수준).
    //    학생 응시 결과 DB 의 행이고, 공개된 것만 내준다. 사본 외의 노션 데이터는 돌려주지 않는다.
    app.get('/api/public/exam-report', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const id = String(req.query.id || '').trim();
        const notFound = () => res.status(404).json({ success: false, message: '리포트를 찾을 수 없거나 아직 공개되지 않았습니다.' });
        if (!/^[0-9a-f-]{32,36}$/i.test(id)) return notFound();
        try {
            const page = await fetchNotion(`https://api.notion.com/v1/pages/${id}`);
            const sameDb = (page.parent?.database_id || '').replace(/-/g, '') === String(dbIds.STUDENT_RESULT_DB_ID || '').replace(/-/g, '');
            if (!sameDb || page.archived || !page.properties?.['공개일시']?.date?.start) return notFound();
            const saved = JSON.parse(readRichText(page.properties['학부모리포트']) || 'null');
            if (!saved?.report) return notFound();
            res.json({ success: true, ...saved.report, publishedAt: page.properties['공개일시'].date.start });
        } catch (error) {
            console.error('학부모 리포트 조회 오류:', error.message);
            notFound();
        }
    });
}
