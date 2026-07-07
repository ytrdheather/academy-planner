import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 10 }
});

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
                        source_type: { type: 'string', enum: ['대화문', '지문', '해당없음'], description: '문항이 근거로 삼는 지문의 형태. 대화형 텍스트(A: ... B: ... 형식)면 "대화문", 설명문·이야기 등 일반 지문이면 "지문", 특정 지문 없이 단어·문법만 묻는 문제면 "해당없음".' },
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
- source_type(출제범위)은 그 문항이 근거로 삼는 지문의 형태를 본다. 화자가 번갈아 말하는 대화형 텍스트(A: ... B: ... 등)에 기반하면 "대화문", 설명문·이야기 등 하나의 글로 된 지문에 기반하면 "지문", 특정 지문 없이 단어 하나·문법 규칙만 묻는 문제면 "해당없음"으로 표기해라.
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
            grammar_point: P['문법포인트']?.rich_text?.[0]?.plain_text || '',
            answer: P['정답']?.rich_text?.[0]?.plain_text || '',
            score: P['배점']?.number || 0
        };
    }).sort((a, b) => naturalNumberSort(a.number, b.number));
}

// 이 기능은 원장(manager 계정) 전용 — 다른 선생님 계정(teacher1/teacher2 등, role은 같은 'manager'라도 loginId가 다름)은 접근 불가
function requireOwner(req, res, next) {
    if (req.user?.loginId !== 'manager') {
        return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
    }
    next();
}

export function initializeExamAnalyzerRoutes({ app, requireAuth, fetchNotion, dbIds }) {
    let anthropic = null;
    if (process.env.ANTHROPIC_API_KEY) {
        anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else {
        console.warn('⚠️ ANTHROPIC_API_KEY가 설정되지 않아 시험지 분석 기능이 비활성화됩니다.');
    }

    app.post('/api/analyze-exam', requireAuth, requireOwner, upload.array('images', 10), async (req, res) => {
        if (!anthropic) {
            return res.status(500).json({ success: false, message: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: '이미지를 최소 1장 업로드해주세요.' });
        }

        try {
            const imageBlocks = req.files.map(file => ({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: file.mimetype,
                    data: file.buffer.toString('base64')
                }
            }));

            const message = await anthropic.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 4096,
                system: SYSTEM_PROMPT,
                tools: [ANALYSIS_TOOL],
                tool_choice: { type: 'tool', name: 'submit_exam_analysis' },
                messages: [{
                    role: 'user',
                    content: [
                        ...imageBlocks,
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
            let results = [];
            let cursor;
            do {
                const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
                if (cursor) body.start_cursor = cursor;
                const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbIds.EXAM_DB_ID}/query`, {
                    method: 'POST', body: JSON.stringify(body)
                });
                results = results.concat(data.results);
                cursor = data.has_more ? data.next_cursor : undefined;
            } while (cursor);

            const exams = results.map(p => {
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
            res.json({ success: true, exams });
        } catch (error) {
            console.error('시험 목록 조회 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 학생 답안 채점 — 정답지와 대조해 문항별 정오/점수 산출(서술형은 채점대기)
    app.post('/api/grade-student', requireAuth, requireOwner, upload.array('images', 10), async (req, res) => {
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

            const imageBlocks = req.files.map(file => ({
                type: 'image',
                source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') }
            }));
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
                        ...imageBlocks,
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

            // 정답지 기준으로 대조 채점
            const graded = answerKey.map(q => {
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

        // 선생님이 검토한 verdict 기준으로 점수 재계산 (서술형 O/X 반영)
        let score = 0, fullScore = 0, correctCount = 0, wrongCount = 0;
        const weakTypes = new Set();
        const weakGrammar = new Set();
        const wrongNumbers = [];
        let hasEssay = false, essayPending = false;

        const rows = graded.map(g => {
            const earned = g.verdict === '정답' ? (Number(g.score) || 0) : 0;
            score += earned;
            fullScore += Number(g.score) || 0;
            if (g.type === '서술형') { hasEssay = true; if (g.verdict === '채점대기') essayPending = true; }
            if (g.verdict === '정답') correctCount++;
            else if (g.verdict === '오답') {
                wrongCount++;
                wrongNumbers.push(g.number);
                if (g.type) weakTypes.add(g.type);
                if (g.grammar_point) weakGrammar.add(g.grammar_point);
            }
            return { ...g, earned };
        });

        const weakGrammarStr = [...weakGrammar].join(', ');
        const reportText = `총점 ${score}/${fullScore} (정답 ${correctCount}, 오답 ${wrongCount}`
            + `${essayPending ? ', 서술형 채점대기' : ''}). `
            + `${weakTypes.size ? '취약 유형: ' + [...weakTypes].join(', ') + '. ' : ''}`
            + `${weakGrammarStr ? '취약 문법: ' + weakGrammarStr + '. ' : ''}`
            + `${wrongNumbers.length ? '오답 문항: ' + wrongNumbers.join(', ') : ''}`;

        try {
            // 1) 학생 응시 결과 1행
            const resultProps = {
                '학생명': { title: [{ text: { content: String(studentName) } }] },
                '시험': { relation: [{ id: examPageId }] },
                '점수': { number: score },
                '만점': { number: fullScore },
                '정답수': { number: correctCount },
                '오답수': { number: wrongCount },
                '취약유형': { multi_select: [...weakTypes].map(name => ({ name })) },
                '취약문법': { rich_text: [{ text: { content: weakGrammarStr } }] },
                '서술형채점': { select: { name: hasEssay ? (essayPending ? '대기' : '완료') : '없음' } },
                '리포트': { rich_text: [{ text: { content: reportText } }] },
                '등록자': { rich_text: [{ text: { content: req.user.name || req.user.loginId } }] }
            };
            if (school) resultProps['학교'] = { select: { name: school } };
            if (grade) resultProps['학년'] = { select: { name: grade } };
            if (examType) resultProps['시험종류'] = { select: { name: examType } };

            const resultPage = await fetchNotion('https://api.notion.com/v1/pages', {
                method: 'POST',
                body: JSON.stringify({ parent: { database_id: dbIds.STUDENT_RESULT_DB_ID }, properties: resultProps })
            });

            // 2) 문항별 응답 행 (학생결과 relation으로 연결)
            for (const g of rows) {
                const props = {
                    '번호': { title: [{ text: { content: String(g.number ?? '') } }] },
                    '학생결과': { relation: [{ id: resultPage.id }] },
                    '문법포인트': { rich_text: [{ text: { content: String(g.grammar_point ?? '') } }] },
                    '정답': { rich_text: [{ text: { content: String(g.answer ?? '') } }] },
                    '학생답': { rich_text: [{ text: { content: String(g.student_answer ?? '') } }] },
                    '배점': { number: Number(g.score) || 0 },
                    '획득점수': { number: g.earned }
                };
                if (g.type) props['유형'] = { select: { name: g.type } };
                if (g.verdict) props['정오'] = { select: { name: g.verdict } };

                await fetchNotion('https://api.notion.com/v1/pages', {
                    method: 'POST',
                    body: JSON.stringify({ parent: { database_id: dbIds.STUDENT_ANSWER_DB_ID }, properties: props })
                });
            }

            res.json({ success: true, pageId: resultPage.id, score, fullScore, report: reportText });
        } catch (error) {
            console.error('학생 결과 저장 오류:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });
}
