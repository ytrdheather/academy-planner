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
                        grammar_point: { type: 'string', description: '어법이해/서술형 문제일 때 출제된 구체적 문법 포인트. 해당 없으면 빈 문자열.' },
                        score: { type: 'number', description: '배점' },
                        difficulty: { type: 'string', enum: ['상', '중', '하'], description: '난이도' },
                        model_answer: { type: 'string', description: '서술형 문제일 때 예상되는 모범답안. 해당 없으면 빈 문자열.' }
                    },
                    required: ['number', 'type', 'score', 'difficulty']
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

export function initializeExamAnalyzerRoutes({ app, requireAuth }) {
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
}
