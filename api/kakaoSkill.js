/**
 * 카카오톡 채널 챗봇 스킬 서버.
 *
 * 학부모가 채널에 친 말을 카카오 i 오픈빌더가 이리로 보내 준다.
 * 우리는 무슨 얘기인지 갈라서, 해당 폼으로 가는 버튼을 돌려준다.
 *
 * 🔴 이 봇은 "안내원"이 아니라 "안내판"이다.
 *    답을 지어내지 않는다. 못 알아들으면 사람에게 넘긴다.
 *    지금까지 원장이 직접 답하던 자리라, 봇이 어설프게 끼어들면 지금보다 나빠진다.
 *
 * 🔴 봇은 학부모가 누구인지 모른다.
 *    오픈빌더가 주는 것은 익명 키(botUserKey)뿐이고 학생 이름이 없다.
 *    그래서 여기서 노션에 기록하거나 담임에게 알리지 않는다 — 누구 건지 모르는 기록은 쓸모가 없다.
 *    폼으로 보내면 거기서 이름을 받아 담임·연락처가 잡힌다. 그게 이 봇의 존재 이유다.
 */

/** 무슨 얘기인지 가르는 규칙. 위에서부터 먼저 맞는 것을 쓴다. */
const RULES = [
    {
        key: '조퇴',
        // '일찍'은 지각의 '늦-'과 겹치지 않으므로 먼저 봐도 안전하다
        words: ['조퇴', '일찍 가', '일찍가', '먼저 가', '먼저가', '중간에 가', '병원 가야', '데리러', '귀가', '데려가'],
        title: '조퇴 알려주기',
        text: '조퇴는 아래에서 알려주시면 담당 선생님께 바로 전달됩니다.\n나가는 시간만 적어 주시면 됩니다.',
        path: '/absence',
    },
    {
        key: '지각',
        words: ['지각', '늦어', '늦을', '늦게', '늦습니다', '늦겠', '조금 늦'],
        title: '지각 알려주기',
        text: '지각은 아래에서 알려주시면 담당 선생님께 바로 전달됩니다.\n예상 도착 시간만 적어 주시면 됩니다.',
        path: '/absence',
    },
    {
        key: '결석',
        words: ['결석', '못 가', '못가', '못 갑니다', '안 가', '안갑니다', '쉬겠', '쉬어요', '빠질', '빠져'],
        title: '결석 알려주기',
        text: '결석은 아래에서 알려주시면 보강 일정까지 함께 잡아드립니다.',
        path: '/absence',
    },
    {
        key: '교재비',
        words: ['입금', '교재비', '송금', '이체', '보냈', '납부'],
        title: null,     // 폼이 아니라 안내만 한다
        text: '교재비 입금은 따로 알려주지 않으셔도 됩니다.\n확인되면 안내드립니다.\n\n다만 학생 이름과 다른 이름으로 보내셨거나 나눠서 보내신 경우에는 이 채팅방에 남겨 주세요. 확인이 어려울 수 있습니다.',
    },
    {
        key: '일정',
        words: ['일정', '휴강', '보강', '공지', '스케줄', '언제 쉬', '방학'],
        title: '학사일정 보기',
        text: '휴강·보강 일정과 공지는 아래에서 보실 수 있습니다.\n리디플랜 아이디로 로그인하시면 열립니다.',
        path: '/notice',
    },
    {
        key: '상담',
        words: ['상담', '문의', '여쭤', '여쭙', '궁금', '질문'],
        title: '상담 신청하기',
        text: '상담은 아래에서 남겨 주시면 담당 선생님이 확인 후 답장드립니다.',
        path: '/counsel',
    },
];

/** 오픈빌더가 알아듣는 응답 모양. 버튼이 없으면 그냥 글만 보낸다. */
function reply(text, button) {
    const outputs = button
        ? [{ basicCard: { description: text, buttons: [{ action: 'webLink', label: button.label, webLinkUrl: button.url }] } }]
        : [{ simpleText: { text } }];
    return { version: '2.0', template: { outputs } };
}

export function initializeKakaoSkill({ app, domainUrl, sendKakaoWork, ownerConv }) {
    // 오픈빌더 스킬 설정에서 커스텀 헤더를 넣을 수 있다. 넣어 두면 아무나 못 부른다.
    const SECRET = process.env.KAKAO_SKILL_SECRET || '';

    app.post('/api/kakao/skill', async (req, res) => {
        if (SECRET && req.get('x-skill-secret') !== SECRET) {
            return res.status(403).json(reply('처리할 수 없습니다.'));
        }

        const utterance = String(req.body?.userRequest?.utterance || '').trim();
        const hit = RULES.find(r => r.words.some(w => utterance.includes(w)));

        if (hit) {
            console.log(`💬 챗봇: [${hit.key}] "${utterance.slice(0, 40)}"`);
            return res.json(reply(
                hit.text,
                hit.path ? { label: hit.title, url: `${domainUrl}${hit.path}` } : undefined,
            ));
        }

        // 못 알아들었다. 답을 지어내지 말고 사람에게 넘긴다.
        console.log(`💬 챗봇: [미분류] "${utterance.slice(0, 60)}"`);
        try {
            if (ownerConv) {
                await sendKakaoWork(ownerConv,
                    `[채널 문의 — 봇이 못 알아들음]\n\n"${utterance.slice(0, 300)}"\n\n채널에서 직접 답해 주세요.`);
            }
        } catch (e) { console.error('채널 문의 전달 실패:', e.message); }

        res.json(reply('선생님께 전달했습니다.\n수업이 끝난 뒤 확인하고 답장드립니다.\n\n급한 일이면 학원으로 전화 주세요. 031-273-6737'));
    });

    console.log('✅ 카카오 챗봇 스킬 로드됨 (POST /api/kakao/skill)');
}
