/**
 * 테스트용 가짜 바깥세상 — 노션 · Gemini · 카카오워크 · 솔라피 · express · 크론.
 *
 * 🔴 왜 이게 있나: 이 저장소는 **로컬에서 서버를 통째로 띄우면 학부모에게 진짜 알림톡이 나간다**
 * (5분 크론 셋이 실전 발송을 한다) → wiki/pitfalls/local-server-fires-crons.md
 * 그래서 검증은 항상 "모듈 하나만 올리고 바깥은 전부 가짜"로 한다.
 * 이 파일이 없던 동안은 세션마다 같은 하네스를 새로 짜고 버렸다.
 *
 * 쓰는 법: initializeXxx({ app, cron, fetchNotion, ... }) 에 여기 것들을 꽂고,
 * app.routes / cron.jobs 로 라우트·크론을 직접 부른다. 실제 네트워크는 한 번도 안 탄다.
 */

// ── 노션 속성 값 만들기 (실제 API 응답 모양 그대로) ──────────────────────────
export const prop = {
    title: (s) => ({ type: 'title', title: [{ plain_text: s, text: { content: s } }] }),
    text: (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s, text: { content: s } }] }),
    number: (n) => ({ type: 'number', number: n }),
    select: (s) => ({ type: 'select', select: s === null ? null : { name: s } }),
    multi: (arr) => ({ type: 'multi_select', multi_select: arr.map(name => ({ name })) }),
    date: (start, end = null) => ({ type: 'date', date: start === null ? null : { start, end } }),
    checkbox: (b) => ({ type: 'checkbox', checkbox: b }),
    url: (u) => ({ type: 'url', url: u }),
    relation: (ids) => ({ type: 'relation', relation: ids.map(id => ({ id })) }),
    /** 노션 수식은 87.77777777777779 같은 실수를 돌려준다 → wiki/pitfalls/monthly-report-float-leak.md */
    formulaNumber: (n) => ({ type: 'formula', formula: { type: 'number', number: n } }),
    formulaString: (s) => ({ type: 'formula', formula: { type: 'string', string: s } }),
    rollup: (items) => ({ type: 'rollup', rollup: { type: 'array', array: items } }),
};

/** 노션 페이지 하나. `page('id-1', { 이름: prop.title('김리디') })` */
export function page(id, properties) {
    return { id, object: 'page', properties };
}

/**
 * 가짜 노션.
 *   databases: { [dbId]: { rows: [page…], properties: { 이름: {...} } } }
 * 반환 객체에 queries / writes 가 쌓이므로 "무엇을 어떻게 물었나"까지 검사할 수 있다.
 * rows 대신 함수를 주면 (body) => rows 로 필터별 응답을 흉내낼 수 있고,
 * Error 를 주면 그 DB 는 던진다(404·409 재현).
 */
export function fakeNotion(databases = {}) {
    const queries = [];
    const writes = [];

    const fetchNotion = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : {};

        const q = url.match(/databases\/([^/]+)\/query$/);
        if (q) {
            const db = databases[q[1]];
            if (db instanceof Error) throw db;
            queries.push({ db: q[1], filter: body.filter, sorts: body.sorts, cursor: body.start_cursor });
            const rows = typeof db?.rows === 'function' ? db.rows(body) : (db?.rows || []);
            // 함수가 봉투째(results/has_more/next_cursor) 돌려주면 그대로 쓴다 — 페이지네이션 재현용
            if (rows && !Array.isArray(rows) && rows.results) {
                return { object: 'list', has_more: false, next_cursor: null, ...rows };
            }
            return { object: 'list', results: rows, has_more: false, next_cursor: null };
        }

        const d = url.match(/databases\/([^/?]+)$/);
        if (d) {
            const db = databases[d[1]];
            if (db instanceof Error) throw db;
            if (!db) throw new Error('404 object_not_found');
            return { object: 'database', properties: db.properties || {} };
        }

        if (/\/v1\/pages\/[^/]+$/.test(url) && opts.method === 'PATCH') {
            writes.push({ op: 'patch', id: url.split('/').pop(), properties: body.properties });
            return { id: url.split('/').pop() };
        }
        // 페이지 한 장 읽기(GET). 어느 DB 의 rows 에 있든 id 로 찾아 준다.
        // 🔴 이게 없어서 /report 렌더를 검사하지 못했고, 주입 누락을 놓쳤다(2026-09-03).
        if (/\/v1\/pages\/[^/]+$/.test(url) && !opts.method) {
            const id = url.split('/').pop();
            for (const db of Object.values(databases)) {
                if (db instanceof Error || typeof db?.rows === 'function') continue;
                const hit = (db?.rows || []).find(r => r.id === id);
                if (hit) return hit;
            }
            throw new Error('404 object_not_found: ' + id);
        }
        if (/\/v1\/pages$/.test(url)) {
            writes.push({ op: 'create', db: body.parent?.database_id, properties: body.properties });
            return { id: 'new-page-' + (writes.length) };
        }
        throw new Error('가짜 노션이 모르는 요청: ' + url);
    };

    return { fetchNotion, queries, writes };
}

/** 가짜 express. 등록된 핸들러를 `routes['POST /api/x']` 로 직접 부른다. */
export function fakeApp() {
    const routes = {};
    const reg = (method) => (path, ...handlers) => { routes[`${method} ${path}`] = handlers[handlers.length - 1]; };
    return { routes, get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use: () => {} };
}

/** 가짜 크론. 등록만 하고 절대 스스로 돌지 않는다. `jobs[0].run()` 으로 부른다. */
export function fakeCron() {
    const jobs = [];
    return {
        jobs,
        schedule: (expression, fn, options) => {
            jobs.push({ expression, options, run: fn });
            return { stop: () => {} };
        },
    };
}

/** 가짜 응답 객체. `res.body` / `res.code` 로 결과를 본다. */
export function fakeRes() {
    const res = { code: 200, body: null, sent: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (x) => { res.body = x; return res; };
    res.send = (x) => { res.sent = x; return res; };
    return res;
}

/** 가짜 Gemini. 고정 문자열을 돌려주고 받은 프롬프트를 모아둔다. */
export function fakeGemini(text = '### 🌟 종합\n안정적입니다.') {
    const prompts = [];
    return {
        prompts,
        model: {
            generateContent: async ({ contents }) => {
                prompts.push(contents[0].parts[0].text);
                return { response: { text: () => text } };
            },
        },
    };
}

/** 가짜 통지(카카오워크·원장 DM). 나간 것을 배열로 모은다. */
export function fakeNotify() {
    const sent = [];
    const fn = async (title, body) => { sent.push({ title, body }); return true; };
    fn.sent = sent;
    return fn;
}

/**
 * 🔴 가짜 학부모 발송. 절대 진짜로 보내지 않는다.
 * 테스트에서 실수로 진짜 sendSms 를 넘기지 않도록 항상 이걸 쓴다 → wiki/patterns/alimtalk-send.md
 */
export function fakeSend() {
    const sent = [];
    const fn = async (...args) => { sent.push(args); return { statusCode: '2000' }; };
    fn.sent = sent;
    return fn;
}

/** 모듈들이 주입받는 노션 헬퍼 4종의 최소 구현 (api/index.js 와 같은 동작). */
export const helpers = {
    getSimpleText: (p) => p?.rich_text?.[0]?.plain_text || p?.title?.[0]?.plain_text || '',
    getRollupValue: (p) => p?.rollup?.array?.[0]?.number ?? null,
    getKSTTodayRange: () => ({}),
    getKoreanDate: () => '',
    getPropByKeywords: (o, kws) => {
        for (const k of Object.keys(o || {})) if (kws.every(w => k.includes(w))) return o[k];
        return null;
    },
};
