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
                        model_answer: { type: 'string', description: '서술형 문제일 때 예상되는 모범답안. 해당 없으면 빈 문자열.' }
                    },
                    required: ['number', 'type', 'source_type', 'score', 'difficulty']
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
- '어법이해' 문제는 grammar_point에 구체적인 문법 포인트를 적어라 (예: "관계대명사 계속적 용법", "가정법 과거완료").
- '서술형' 문제는 grammar_point에 그 문제가 확인하려는 문법 포인트를 적고, model_answer에 예상되는 모범답안을 적어라. 학생 답안은 없으니 채점하지 말고 모범답안만 제시해라.
- 그 외 유형은 grammar_point, model_answer를 빈 문자열로 둬라.
- score는 시험지에 표기된 배점을 그대로 읽어라. 표기가 없으면 0.
- difficulty는 문항의 추론 난이도, 함정 요소, 어휘 수준을 바탕으로 상/중/하 중 하나로 판단해라.`;

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
}
