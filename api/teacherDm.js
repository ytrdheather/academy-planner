/**
 * 담당쌤 개인 DM 보내기.
 *
 * 공용 채널에 뿌리면 각자 자기 학생인지 훑어야 하고, 결국 아무도 안 본다.
 * 이름 → 선생님 명부 `카카오워크 ID`(숫자) → 1:1 DM 으로 꽂아 준다.
 *
 * 🔴 이름으로 카카오워크 사용자를 찾지 않는다. 카카오워크는 실명(`김재아 라일라쌤`)인데
 *    명부는 `레일라쌤` 형식이라 이름으로 짝지으면 엉뚱한 선생에게 학생 정보가 간다.
 *    연결은 이메일로만 하고 `scripts/link-teacher-kakaowork.mjs --sync` 가 채운다.
 *
 * textbookFeeModule 에도 같은 일을 하는 코드가 있다. 그쪽은 라이브로 도는 중이라
 * 건드리지 않았다. 다음에 손볼 일이 생기면 이 파일로 합칠 것.
 */
const CACHE_MS = 5 * 60 * 1000;
const plain = p => ((p?.title || p?.rich_text || []).map(t => t.plain_text).join('') || '').trim();

export function makeTeacherDm({ fetchNotion, teacherDbId, appKey }) {
    let cache = { at: 0, map: new Map() };

    async function directory() {
        if (!teacherDbId) return new Map();
        if (Date.now() - cache.at < CACHE_MS) return cache.map;
        const d = await fetchNotion(`https://api.notion.com/v1/databases/${teacherDbId}/query`, {
            method: 'POST', body: JSON.stringify({ page_size: 100 }),
        });
        const map = new Map();
        for (const r of d.results) {
            const 이름 = plain(r.properties['이름']);
            const id = plain(r.properties['카카오워크 ID']);
            // 이메일이 잘못 들어가 있던 적이 있다. 숫자가 아니면 쓰지 않는다.
            if (이름 && /^\d+$/.test(id)) map.set(이름, id);
        }
        cache = { at: Date.now(), map };
        return map;
    }

    async function openDm(userId) {
        const res = await fetch('https://api.kakaowork.com/v1/conversations.open', {
            method: 'POST',
            headers: { Authorization: `Bearer ${appKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: Number(userId) }),
        });
        const b = await res.json();
        if (!b?.success) throw new Error(`conversations.open 실패: ${JSON.stringify(b).slice(0, 200)}`);
        return b.conversation.id;
    }

    /**
     * `url` 은 두 가지를 받는다.
     *   문자열            → `노션에서 열기` 버튼 하나 (예전 호출부가 이렇게 쓴다)
     *   [{text, url, style}] → 그대로 버튼 여러 개
     * 버튼을 여러 개 다는 이유는 알림에서 바로 처리하게 하려는 것이다 — 노션을 열게 하면 아무도 안 한다.
     */
    async function sendCard(conversationId, title, body, url) {
        const buttons = !url ? []
            : typeof url === 'string' ? [{ text: '노션에서 열기', url }]
                : url.filter(b => b && b.url);

        // 🔴 카카오워크 블록 한계 (2026-09-04 실측): header 20자 · button 20자 · text 500자.
        //    하나라도 넘기면 invalid_parameter 로 메시지 전체가 거부된다 — 제목 한 글자 때문에
        //    담당쌤 알림이 통째로 안 나가면 안 되므로 자르고서라도 내보낸다.
        const 자르기 = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
        const blocks = [{ type: 'header', text: 자르기(title, 20), style: 'blue' }];
        for (let i = 0; i < String(body).length; i += 500) {
            blocks.push({ type: 'text', text: String(body).slice(i, i + 500), markdown: false });
        }
        for (const b of buttons) {
            blocks.push({ type: 'button', text: 자르기(b.text, 20), style: b.style || 'default', action_type: 'open_system_browser', value: b.url });
        }
        // 카카오워크 앱이 아닌 곳(알림 미리보기 등)에서는 text 만 보이므로 주소도 같이 실어 준다.
        const tail = buttons.map(b => `\n${b.text}: ${b.url}`).join('');

        const res = await fetch('https://api.kakaowork.com/v1/messages.send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${appKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId, text: `${title}\n\n${body}${tail}`, blocks }),
        });
        const b = await res.json();
        if (!b?.success) throw new Error(`messages.send 실패: ${JSON.stringify(b).slice(0, 200)}`);
        return true;
    }

    /**
     * 담당쌤에게 DM. 보냈으면 true, 매핑이 없어 못 보냈으면 false.
     * false 를 조용히 넘기지 말고 부르는 쪽에서 원장에게 알릴 것.
     */
    async function teacherDm(teacherName, title, body, url) {
        if (!appKey || !teacherName || teacherName === '미지정') return false;
        const id = (await directory()).get(teacherName);
        if (!id) return false;
        await sendCard(await openDm(id), title, body, url);
        return true;
    }

    teacherDm.sendCard = sendCard;
    teacherDm.directory = directory;
    return teacherDm;
}
