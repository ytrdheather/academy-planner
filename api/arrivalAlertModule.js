// ------------------------------------------------------------------
// [미도착 알림] 등원 시각이 지났는데 아직 안 온 학생을 선생님께 알린다.
//
// 도착 신호는 "학생이 리디플래너에 숙제를 저장한 순간"이다. 아이들이 학원에 와서
// 직접 쓰기 때문에 저장 = 등원으로 본다 (index.js 의 /save-progress 가 출석을 켠다).
// 선생님이 출석을 손으로 찍던 일이 없어지고, 그 대신 여기서 안 찍힌 아이를 골라낸다.
//
// 판정은 "등원 시각 + 유예(기본 15분)가 지났는데 출석이 안 켜졌다" 하나뿐이다.
// 크론은 매시 15분·45분에 돈다 — 수업이 정각 아니면 30분에 시작하기 때문이다.
//
// 등원 시각은 학생 명부의 요일별 선택 칸(`월등원`…`토등원`)에서 읽는다. 아이마다
// 요일마다 시간이 달라서 요일별로 나눴다. 안 오는 요일은 비워 둔다.
//
// 🔴 학부모에게는 아무것도 나가지 않는다. 카카오워크 채널 한 통이 전부다.
// ------------------------------------------------------------------

const _DOW = ['일', '월', '화', '수', '목', '금', '토']; // getUTCDay 0=일

/** 유예 시간(분). 정각에 딱 맞춰 오는 아이가 드물면 배포 없이 env 로 늘린다. */
const GRACE_MIN = Number(process.env.ARRIVAL_GRACE_MIN || 15);

/**
 * 너무 늦게 울리지 않게 하는 창(분). 서버가 오후 내내 죽어 있다가 살아나면
 * 2시 반 아이를 저녁 8시에 알려 봐야 소음이다. 이 창을 넘으면 조용히 건너뛴다.
 */
const LATE_WINDOW_MIN = Number(process.env.ARRIVAL_LATE_WINDOW_MIN || 90);

/** 한국 시간 기준 지금. 크론 콜백 안의 맨 new Date() 는 서버 시간이라 쓰면 안 된다. */
function kstNow() {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return {
        dayChar: _DOW[kst.getUTCDay()],
        minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
        hhmm: `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`,
    };
}

const toMinutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 요일 → 명부 속성 이름. 일요일은 수업이 없다. */
const DAY_PROPS = { '월': '월등원', '화': '화등원', '수': '수등원', '목': '목등원', '금': '금등원', '토': '토등원' };

/**
 * 명부 선택 칸의 값을 `HH:MM` 으로 맞춘다. 못 읽으면 null.
 * 노션 선택 속성은 새 값을 타이핑하면 옵션이 생겨 버리므로("3시" 같은 것),
 * 못 읽은 값은 조용히 버리지 않고 하루 한 번 감사 알림에 실어 보낸다.
 */
export function normalizeTime(raw) {
    const m = /^(\d{1,2})\s*:\s*(\d{2})$/.exec(String(raw || '').trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

export function initializeArrivalAlert({
    app, requireAuth, fetchNotion, cron, dbIds, notifyChannel,
    getKSTTodayRange, getActivePause,
}) {
    const { STUDENT_DATABASE_ID, PROGRESS_DATABASE_ID, ABSENCE_DB_ID } = dbIds || {};
    if (!STUDENT_DATABASE_ID || !PROGRESS_DATABASE_ID) {
        console.warn('⚠️ 미도착 알림 비활성화 — STUDENT/PROGRESS DB ID 없음');
        return;
    }

    const plain = (p) => ((p?.rich_text || p?.title || []).map(t => t.plain_text).join('') || '').trim();

    async function queryAll(dbId, body = {}) {
        const out = [];
        let cursor, more = true;
        while (more) {
            const d = await fetchNotion(`https://api.notion.com/v1/databases/${dbId}/query`, {
                method: 'POST', body: JSON.stringify({ page_size: 100, ...body, start_cursor: cursor }),
            });
            out.push(...(d.results || []));
            more = d.has_more; cursor = d.next_cursor;
        }
        return out;
    }

    /**
     * 오늘 등원 예정인 재원생을 셋으로 나눠 돌려준다.
     *   ok         : 시각을 읽은 학생 (판정 대상)
     *   badFormat  : 값은 있는데 HH:MM 이 아닌 학생
     *   missing    : 그 요일 칸이 비어 있는 학생
     * 뒤의 둘은 판정에서 빠지므로 하루 한 번 사람에게 알린다 — 조용히 빠지는 게 제일 위험하다.
     */
    async function readTodayRoster(dayChar) {
        const dayProp = DAY_PROPS[dayChar];
        const pages = await queryAll(STUDENT_DATABASE_ID);
        const ok = [], badFormat = [], missing = [];
        for (const page of pages) {
            const p = page.properties;
            const enroll = p['재원상태']?.select?.name || '';
            if (enroll === '퇴원' || enroll === '휴원') continue;
            const days = p['수강요일']?.multi_select?.map(d => d.name).join('') || '';
            if (!days.includes(dayChar)) continue;
            // 학습상태(숙제 정지 등)는 보지 않는다 — 숙제를 쉬는 아이도 등원은 한다.
            const name = p['이름']?.title?.[0]?.plain_text || '';
            if (!name) continue;
            const raw = p[dayProp]?.select?.name || '';
            const at = normalizeTime(raw);
            if (at) ok.push({ name, teacher: (p['담당쌤']?.multi_select?.map(t => t.name) || []).join(', '), at });
            else if (raw) badFormat.push({ name, raw });
            else missing.push(name);
        }
        return { ok, badFormat, missing };
    }

    /**
     * 오늘 결석·지각 신청이 들어온 학생 이름.
     * 조퇴는 빼지 않는다 — 등원은 하기 때문이다.
     * 지각은 예상 도착 시간을 자유 텍스트로 받아 파싱이 위태롭고, 어차피 신청 순간
     * 카카오워크로 이미 알려졌다. 그래서 그날은 통째로 대상에서 뺀다.
     */
    async function readExcusedNames(todayStr) {
        if (!ABSENCE_DB_ID) return new Set();
        const from = new Date(Date.parse(`${todayStr}T00:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10);
        let pages = [];
        try {
            pages = await queryAll(ABSENCE_DB_ID, {
                filter: { property: '결석일', date: { on_or_after: from } },
            });
        } catch (e) {
            console.error('미도착 알림 — 결석 조회 실패(신청자 제외 없이 진행):', e.message);
            return new Set();
        }
        const names = new Set();
        for (const pg of pages) {
            const p = pg.properties;
            const kind = p['유형']?.select?.name || '결석';
            if (kind === '조퇴') continue;
            // 노션 날짜 필터가 기간 속성의 시작·종료 중 무엇을 보는지 애매해서 JS 에서 다시 거른다.
            const start = p['결석일']?.date?.start || '';
            const end = p['결석일']?.date?.end || start;
            if (!start || todayStr < start || todayStr > end) continue;
            const nm = plain(p['학생명']);
            if (nm) names.add(nm);
        }
        return names;
    }

    // 진도 행이 아직 없는 학생은 노션에 발송 기록을 남길 자리가 없다. 그 학생만 메모리로 막는다.
    // (서버가 재시작하면 풀린다 — 카카오워크 한 통이 겹치는 정도라 감수한다.)
    const memoAlerted = new Set();

    // 등원시간 점검은 하루 한 번만. 매 틱마다 울리면 시끄러워서 아무도 안 본다.
    let auditedDate = '';
    /** 점검을 돌릴 시각(분). 첫 수업(14시)보다 앞이라 고칠 시간이 있다. */
    const AUDIT_AFTER_MIN = Number(process.env.ARRIVAL_AUDIT_AFTER || 13) * 60;

    /**
     * 오늘 등원인데 시각을 못 읽은 학생을 하루 한 번 알린다.
     * 🔴 이 알림이 이 기능의 안전망이다 — 시각이 비면 그 아이는 판정에서 조용히 빠지는데,
     *    조용히 빠지는 것이 "안 온 아이를 놓치는 것"으로 이어진다.
     */
    async function auditRoster(dateString, dayChar, roster) {
        if (auditedDate === dateString) return;
        if (!roster.badFormat.length && !roster.missing.length) { auditedDate = dateString; return; }
        auditedDate = dateString;   // 실패해도 다시 안 보낸다 — 매 틱 재시도하면 시끄럽다
        // 세팅 초기엔 미입력이 수십 명이라 이름을 다 실으면 아무도 안 읽는 벽이 된다.
        const cap = (arr, fmt) => arr.length > 15
            ? [...arr.slice(0, 15).map(fmt), `… 외 ${arr.length - 15}명`]
            : arr.map(fmt);
        const lines = [`${dateString} (${dayChar}) · 아래 학생은 미도착 알림에서 빠집니다`, ''];
        if (roster.missing.length) {
            lines.push(`▪ ${dayChar}등원 칸이 비어 있음 (${roster.missing.length}명)`);
            lines.push(...cap(roster.missing, n => `· ${n}`), '');
        }
        if (roster.badFormat.length) {
            lines.push(`▪ 시각을 못 읽음 (${roster.badFormat.length}명) — 14:00 처럼 적어 주세요`);
            lines.push(...cap(roster.badFormat, b => `· ${b.name} — "${b.raw}"`), '');
        }
        lines.push(`학생 명부의 ${dayChar}등원 칸을 채우면 다음 수업부터 잡힙니다.`);
        await notifyChannel('등원시간 점검', lines.join('\n'));
    }

    /**
     * 지금 시점에 안 온 학생을 골라 카카오워크로 한 통 보낸다.
     *   dryRun : 명단만 계산하고 보내지도 기록하지도 않는다(확인용)
     *   force  : 휴강(정지 기간)이어도 돈다
     */
    async function checkArrivals({ dryRun = false, force = false } = {}) {
        const { dateString } = getKSTTodayRange();
        const { dayChar, minutes: nowMin, hhmm } = kstNow();

        if (dayChar === '일') return { date: dateString, skipped: '일요일', due: [], sent: 0 };

        if (!force && getActivePause) {
            const pause = await getActivePause(dateString);
            if (pause) return { date: dateString, skipped: `휴강(${pause.reason || ''})`, due: [], sent: 0 };
        }

        const roster = await readTodayRoster(dayChar);
        if (!dryRun && nowMin >= AUDIT_AFTER_MIN) {
            // 점검 실패가 본 판정을 죽이면 안 된다.
            await auditRoster(dateString, dayChar, roster).catch(e => console.error('등원시간 점검 실패:', e.message));
        }

        // 유예가 지났고, 아직 너무 늦지는 않은 학생만.
        const due = roster.ok.filter(s => {
            const t = toMinutes(s.at);
            if (t === null) return false;
            const elapsed = nowMin - (t + GRACE_MIN);
            return elapsed >= 0 && elapsed <= LATE_WINDOW_MIN;
        });
        const audit = { badFormat: roster.badFormat, missing: roster.missing };
        if (!due.length) return { date: dateString, now: hhmm, due: [], audit, sent: 0 };

        // 여기서부터만 오늘 진도 행을 읽는다 — 대상이 없는 시각엔 노션을 건드리지 않는다.
        const rows = await queryAll(PROGRESS_DATABASE_ID, {
            filter: { property: '🕐 날짜', date: { equals: dateString } },
        });
        const rowByName = {};
        for (const pg of rows) {
            const p = pg.properties;
            const nm = p['이름']?.title?.[0]?.plain_text || '';
            if (!nm) continue;
            rowByName[nm] = {
                pageId: pg.id,
                출석: p['출석']?.checkbox || false,
                결석사유: plain(p['결석 사유']),
                알림일시: plain(p['미도착알림일시']),
            };
        }

        const excused = await readExcusedNames(dateString);

        const missing = [];
        for (const s of due) {
            if (excused.has(s.name)) continue;
            const row = rowByName[s.name];
            if (row) {
                if (row.출석 || row.결석사유 || row.알림일시) continue;
            } else if (memoAlerted.has(`${dateString}|${s.name}`)) {
                continue;
            }
            missing.push({ ...s, pageId: row?.pageId || '' });
        }

        if (!missing.length) return { date: dateString, now: hhmm, due: due.map(d => d.name), audit, sent: 0 };
        if (dryRun) return { date: dateString, now: hhmm, dryRun: true, due: due.map(d => d.name), missing, audit, sent: 0 };

        const lines = [
            `${dateString} (${dayChar}) ${hhmm} 기준 · 등원 체크 안 됨`,
            '',
            ...missing.map(s => `· ${s.name} — ${s.at} 등원 (담임: ${s.teacher || '미지정'})`),
            '',
            '숙제 플래너를 저장하면 자동으로 출석 처리됩니다.',
            '이미 와 있는 학생은 선생님 화면에서 출석을 켜 주세요.',
        ];
        await notifyChannel(`미도착 ${missing.length}명`, lines.join('\n'));

        // 발송 기록 — 같은 학생에게 하루 두 번 울리지 않게. 한 명 실패해도 나머지는 남긴다.
        for (const s of missing) {
            if (!s.pageId) { memoAlerted.add(`${dateString}|${s.name}`); continue; }
            try {
                await fetchNotion(`https://api.notion.com/v1/pages/${s.pageId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties: { '미도착알림일시': { rich_text: [{ text: { content: hhmm } }] } } }),
                });
            } catch (e) {
                // 기록만 실패한 것이라 알림은 이미 나갔다. 메모리로라도 막는다.
                memoAlerted.add(`${dateString}|${s.name}`);
                console.error(`미도착 알림 기록 실패(${s.name}):`, e.message);
            }
            await new Promise(r => setTimeout(r, 350)); // Notion 초당 3요청 제한
        }

        return { date: dateString, now: hhmm, due: due.map(d => d.name), missing: missing.map(m => m.name), sent: missing.length };
    }

    // 수동 트리거 — 크론이 배포와 겹쳐 건너뛰었을 때, 그리고 dryRun 으로 명단만 볼 때.
    app.post('/api/arrival/tick', requireAuth, async (req, res) => {
        try {
            const r = await checkArrivals({ dryRun: req.body?.dryRun === true, force: req.body?.force === true });
            res.json({ success: true, ...r });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // 수업은 정각 아니면 30분에 시작한다 → 유예 15분이면 매시 15분·45분에 판정하면 된다.
    // 판정 자체가 "등원 시각 + 유예가 지났는가"라, 한 틱을 놓쳐도 다음 틱이 주워 간다.
    cron.schedule('15,45 * * * *', async () => {
        const { minutes } = kstNow();
        if (minutes < 9 * 60 || minutes >= 23 * 60) return; // 수업이 없는 시간대엔 노션을 건드리지 않는다
        try {
            const r = await checkArrivals();
            if (r.sent) console.log(`🔔 미도착 알림 ${r.sent}명 (${r.date} ${r.now}): ${r.missing.join(', ')}`);
        } catch (e) {
            console.error('미도착 알림 Cron Error', e);
            notifyChannel('미도착 알림 실패', `${e.message}\n\n선생님 화면에서 출석을 직접 확인해 주세요.`)
                .catch(() => {});
        }
    }, { timezone: 'Asia/Seoul' });

    console.log(`✅ 미도착 알림 — 매시 15·45분 (유예 ${GRACE_MIN}분)`);
}
