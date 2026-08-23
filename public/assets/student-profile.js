/* ------------------------------------------------------------------
 * 학생 프로필 카드 — 이름을 누르면 뜨는 한 장짜리 요약.
 *
 * 어느 화면에서든 아래 한 줄이면 붙는다:
 *     <script src="/assets/student-profile.js"></script>
 * 그 다음 이름에 onclick 을 건다:
 *     <span onclick="openStudentProfile('김윤하')">김윤하</span>
 *     openStudentProfile(이름, 명부pageId)  ← pageId 를 알면 조회가 한 번 줄어든다
 *
 * 이 파일은 아무것도 import 하지 않고 CSS 도 스스로 넣는다.
 * 붙이는 화면의 클래스·스타일과 부딪히지 않게 전부 rp- 접두사를 쓴다.
 * ------------------------------------------------------------------ */
(function () {
    if (window.openStudentProfile) return;   // 두 번 붙어도 안전하게

    var API = window.API_BASE_URL || window.location.origin;
    var DAYS = ['월', '화', '수', '목', '금', '토'];
    var state = { profile: null, busy: false };

    function token() {
        return localStorage.getItem('teacher_auth_token') || localStorage.getItem('authToken') || '';
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function todayKST() {
        // 서버는 해외에 있고 사용자는 한국이다. 브라우저 시계도 믿지 않고 KST 로 고정한다.
        var d = new Date(Date.now() + (new Date().getTimezoneOffset() * 60000) + 9 * 3600000);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /* AI 요약은 마크다운으로 저장돼 있다. 라이브러리 없이 쓰는 만큼만 옮긴다. */
    function md(text) {
        var out = esc(text)
            .replace(/^###\s?(.*)$/gm, '<h4 class="rp-md-h">$1</h4>')
            .replace(/^##\s?(.*)$/gm, '<h4 class="rp-md-h">$1</h4>')
            .replace(/^#\s?(.*)$/gm, '<h4 class="rp-md-h">$1</h4>')
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/^[-*]\s+(.*)$/gm, '<li>$1</li>');
        out = out.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul class="rp-md-ul">$1</ul>');
        return out.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
    }

    /* ── 스타일 ─────────────────────────────────────────────────── */
    var CSS = ''
        + '.rp-ov{position:fixed;inset:0;background:rgba(15,42,38,.5);z-index:9000;display:none;align-items:flex-start;justify-content:center;padding:28px 16px;overflow-y:auto;}'
        + '.rp-ov.show{display:flex;}'
        + '.rp-card{background:#fff;border-radius:18px;width:100%;max-width:860px;box-shadow:0 24px 60px rgba(10,108,98,.25);font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937;overflow:hidden;}'
        + '.rp-head{background:linear-gradient(135deg,#0d9488 0%,#0a6c62 100%);color:#fff;padding:18px 22px;display:flex;align-items:flex-start;gap:14px;}'
        + '.rp-head h2{margin:0;font-size:22px;font-weight:800;letter-spacing:-.3px;}'
        + '.rp-sub{font-size:13px;opacity:.92;margin-top:4px;}'
        + '.rp-x{margin-left:auto;background:rgba(255,255,255,.18);border:none;color:#fff;width:32px;height:32px;border-radius:9px;cursor:pointer;font-size:15px;flex:0 0 auto;}'
        + '.rp-x:hover{background:rgba(255,255,255,.32);}'
        + '.rp-body{padding:18px 22px 24px;max-height:calc(100vh - 150px);overflow-y:auto;}'
        + '.rp-sec{margin-bottom:20px;}'
        + '.rp-sec>h3{font-size:14px;font-weight:800;color:#0a6c62;margin:0 0 9px;display:flex;align-items:center;gap:6px;}'
        + '.rp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;}'
        + '.rp-f{background:#f4f7f7;border:1px solid #e2eceb;border-radius:10px;padding:8px 11px;}'
        + '.rp-f .k{font-size:11px;color:#6b8480;font-weight:700;}'
        + '.rp-f .v{font-size:14px;font-weight:700;margin-top:2px;word-break:break-all;}'
        + '.rp-chip{display:inline-block;background:#e4f3f0;color:#0a6c62;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;margin:0 5px 5px 0;}'
        + '.rp-chip.off{background:#f1f5f4;color:#9aa8a5;}'
        + '.rp-days{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;}'
        + '.rp-day{border:1px solid #e2eceb;border-radius:10px;padding:7px 5px;text-align:center;background:#fafcfc;}'
        + '.rp-day.on{border-color:#7ecfc4;background:#e4f3f0;}'
        + '.rp-day .d{font-size:13px;font-weight:800;color:#0a6c62;}'
        + '.rp-day select{width:100%;margin-top:5px;border:1px solid #d6e4e2;border-radius:7px;padding:3px 2px;font-size:12px;background:#fff;color:#1f2937;font-family:inherit;}'
        + '.rp-tbl{width:100%;border-collapse:collapse;font-size:13px;}'
        + '.rp-tbl th{background:#e4f3f0;color:#0a6c62;font-size:12px;padding:7px 8px;text-align:left;font-weight:800;white-space:nowrap;}'
        + '.rp-tbl td{border-bottom:1px solid #eef3f2;padding:7px 8px;vertical-align:top;}'
        + '.rp-scroll{overflow-x:auto;border:1px solid #e2eceb;border-radius:10px;}'
        + '.rp-num{font-weight:800;}'
        + '.rp-hi{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px;margin-bottom:10px;}'
        + '.rp-hi>div{border-radius:12px;padding:10px;text-align:center;background:#f4f7f7;border:1px solid #e2eceb;}'
        + '.rp-hi .k{font-size:11px;color:#6b8480;font-weight:700;}'
        + '.rp-hi .v{font-size:22px;font-weight:800;color:#0a6c62;line-height:1.15;margin-top:2px;}'
        + '.rp-acc{border:1px solid #e2eceb;border-radius:10px;margin-bottom:7px;overflow:hidden;}'
        + '.rp-acc>summary{cursor:pointer;padding:9px 12px;background:#f4f7f7;font-weight:800;font-size:13px;color:#0a6c62;list-style:none;}'
        + '.rp-acc>summary::-webkit-details-marker{display:none;}'
        + '.rp-acc>summary:before{content:"▸ ";}'
        + '.rp-acc[open]>summary:before{content:"▾ ";}'
        + '.rp-acc .rp-md{padding:11px 14px;font-size:13px;line-height:1.75;}'
        + '.rp-md-h{font-size:13px;font-weight:800;color:#0a6c62;margin:10px 0 4px;}'
        + '.rp-md-ul{margin:4px 0 4px 18px;padding:0;}'
        + '.rp-note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:10px;padding:9px 12px;font-size:12.5px;line-height:1.6;}'
        + '.rp-empty{color:#9aa8a5;font-size:13px;padding:8px 2px;}'
        + '.rp-log{border-left:3px solid #7ecfc4;background:#fafcfc;border-radius:0 10px 10px 0;padding:8px 12px;margin-bottom:7px;}'
        + '.rp-log .m{font-size:11.5px;color:#6b8480;font-weight:700;margin-bottom:3px;}'
        + '.rp-log .c{font-size:13.5px;line-height:1.65;white-space:pre-wrap;}'
        + '.rp-form{background:#f4f7f7;border:1px solid #e2eceb;border-radius:12px;padding:11px;margin-bottom:11px;}'
        + '.rp-form textarea{width:100%;box-sizing:border-box;min-height:66px;resize:vertical;border:1px solid #d6e4e2;border-radius:8px;padding:8px 10px;font-size:13.5px;font-family:inherit;}'
        + '.rp-form .row{display:flex;gap:8px;align-items:center;margin-top:8px;}'
        + '.rp-form input[type=date]{border:1px solid #d6e4e2;border-radius:8px;padding:6px 9px;font-size:13px;font-family:inherit;}'
        + '.rp-btn{background:#0d9488;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit;}'
        + '.rp-btn:hover{background:#0a6c62;}.rp-btn:disabled{background:#a7c4c0;cursor:default;}'
        + '.rp-status{font-size:12.5px;font-weight:700;margin-left:auto;}'
        + '.rp-name-link{cursor:pointer;border-bottom:1px dashed #7ecfc4;}'
        + '.rp-name-link:hover{color:#0a6c62;}'
        + '@media(max-width:640px){.rp-days{grid-template-columns:repeat(3,1fr);}.rp-body{padding:14px;}}';

    function mount() {
        if (document.getElementById('rpProfileOverlay')) return;
        var st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);

        var ov = document.createElement('div');
        ov.id = 'rpProfileOverlay';
        ov.className = 'rp-ov';
        ov.innerHTML = '<div class="rp-card">'
            + '<div class="rp-head"><div><h2 id="rpName">불러오는 중…</h2><div class="rp-sub" id="rpSub"></div></div>'
            + '<button class="rp-x" onclick="closeStudentProfile()">✕</button></div>'
            + '<div class="rp-body" id="rpBody"><div class="rp-empty">불러오는 중…</div></div></div>';
        ov.addEventListener('click', function (e) { if (e.target === ov) closeStudentProfile(); });
        document.body.appendChild(ov);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && ov.classList.contains('show')) closeStudentProfile();
        });
    }

    /* ── 섹션 렌더러 ────────────────────────────────────────────── */

    function fld(k, v) { return '<div class="rp-f"><div class="k">' + esc(k) + '</div><div class="v">' + (v ? esc(v) : '—') + '</div></div>'; }

    function secBasic(p) {
        var f = fld('학교', p.school) + fld('학년', p.grade) + fld('나이', p.age ? p.age + '세' : '')
            + fld('수강과정', p.course) + fld('수강과목', p.subject)
            + fld('문법반', p.grammarClass) + fld('클래스', p.classCode)
            + fld('담당쌤', (p.teachers || []).join(', '));
        if (p.canSeeContact) {
            f += fld('학부모 연락처', p.parentPhone) + fld('학생 연락처', p.studentPhone);
        } else {
            f += '<div class="rp-f"><div class="k">연락처</div><div class="v" style="color:#9aa8a5;font-size:12.5px;">원장 계정에서만</div></div>';
        }
        return '<div class="rp-sec"><h3>👤 기본 정보</h3><div class="rp-grid">' + f + '</div></div>';
    }

    function secAttend(p) {
        var a = p.attend || { days: [], times: {}, options: {} };
        // 🔴 요일마다 선택지가 다르다. 월수금 14~17시 / 화목 15~19시 — 합쳐서 뿌리면
        //    노션에 없던 옵션이 생긴다. 서버도 그 요일 옵션이 아니면 거절한다.
        var opts = a.options || {};
        var cells = DAYS.map(function (d) {
            var on = (a.days || []).indexOf(d) >= 0;
            var cur = a.times[d] || '';
            var dayOpts = opts[d] || [];
            // 노션에 이미 다른 값이 들어 있으면(옛 데이터) 목록에서 빠지지 않게 끼워 넣는다
            if (cur && dayOpts.indexOf(cur) < 0) dayOpts = [cur].concat(dayOpts);
            var sel = '<option value="">—</option>' + dayOpts.map(function (o) {
                return '<option value="' + esc(o) + '"' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>';
            }).join('');
            return '<div class="rp-day' + (on ? ' on' : '') + '"><div class="d">' + d + '</div>'
                + '<select data-day="' + d + '" onchange="rpSaveAttend(this)">' + sel + '</select></div>';
        }).join('');
        var noTime = DAYS.every(function (d) { return !a.times[d]; });
        return '<div class="rp-sec"><h3>🚪 등원 요일 · 시간</h3>'
            + '<div class="rp-days">' + cells + '</div>'
            + (noTime ? '<div class="rp-note" style="margin-top:9px;">등원 시각이 아직 비어 있습니다. 여기서 고르면 노션 명부에 바로 저장되고, <b>미도착 알림</b>도 그때부터 이 학생에게 돕니다.</div>' : '')
            + '</div>';
    }

    function bookLine(label, arr, unit) {
        var body;
        if (!arr || !arr.length) body = '<span class="rp-chip off">없음</span>';
        else body = arr.map(function (b) {
            var t = b.name + (b.totalUnits ? ' (총 ' + b.totalUnits + '유닛)' : '');
            return '<span class="rp-chip">' + esc(t) + '</span>';
        }).join('');
        var u = (unit === null || unit === undefined || unit === '') ? '' : ' <span class="rp-chip" style="background:#fff7ed;color:#c2410c;">현재 ' + esc(unit) + '유닛</span>';
        return '<tr><th style="width:88px;">' + esc(label) + '</th><td>' + body + u + '</td></tr>';
    }

    function secBooks(p) {
        var b = p.books || {}, u = p.units || {};
        var g = b.grammar || { className: '', recent: [] };
        var gBody;
        if (!g.className) gBody = '<span class="rp-chip off">문법반 미지정</span>';
        else {
            gBody = '<span class="rp-chip">' + esc(g.className) + '반</span>';
            if (g.recent && g.recent.length) {
                gBody += '<div style="font-size:12.5px;color:#4b5f5c;margin-top:4px;line-height:1.6;">'
                    + g.recent.map(function (r) { return '<div>· <b>' + esc(r.date) + '</b> ' + esc(r.progress || '진도 미기재') + '</div>'; }).join('')
                    + '</div>';
            } else {
                gBody += '<span style="font-size:12.5px;color:#9aa8a5;">최근 진도 기록 없음</span>';
            }
        }
        return '<div class="rp-sec"><h3>📚 진행중인 교재</h3><div class="rp-scroll"><table class="rp-tbl">'
            + bookLine('어휘', b.vocab, u.vocab)
            + '<tr><th>문법</th><td>' + gBody + '</td></tr>'
            + bookLine('독해서', b.mainReading, u.mainReading)
            + bookLine('부교재', b.subReading, u.subReading)
            + bookLine('리스닝', b.listening, '')
            + '</table></div>'
            + '<div style="font-size:11.5px;color:#9aa8a5;margin-top:6px;">문법은 학생별 교재 칸이 명부에 없어 <b>문법반 + 최근 진도</b>로 대신 보여줍니다.</div>'
            + '</div>';
    }

    function secPast(p) {
        var rows = (p.fees || []).map(function (r) {
            return '<tr><td style="white-space:nowrap;">' + esc(r.sentAt || r.createdAt || '') + '</td>'
                + '<td>' + esc(r.books || r.title) + '</td>'
                + '<td style="white-space:nowrap;">' + esc(r.status) + (r.paid ? ' · 입금✓' : '') + '</td>'
                + '<td style="white-space:nowrap;" class="rp-num">' + (r.amount ? r.amount.toLocaleString() + '원' : '—') + '</td></tr>';
        }).join('');
        var done = (p.books && p.books.done) || [];
        return '<div class="rp-sec"><h3>📖 진행했던 교재</h3>'
            + (rows
                ? '<div class="rp-scroll"><table class="rp-tbl"><tr><th>날짜</th><th>교재</th><th>상태</th><th>금액</th></tr>' + rows + '</table></div>'
                : '<div class="rp-empty">교재비 내역이 없습니다.</div>')
            + (done.length
                ? '<div style="margin-top:9px;"><div style="font-size:12px;font-weight:800;color:#6b8480;margin-bottom:5px;">완료 처리된 교재 (명부)</div>'
                + done.map(function (b) { return '<span class="rp-chip">' + esc(b.name) + (b.subject ? ' · ' + esc(b.subject) : '') + '</span>'; }).join('') + '</div>'
                : '')
            + '</div>';
    }

    function pct(v) { return (v === null || v === undefined) ? '—' : Math.round(v) + '%'; }
    function sco(v) { return (v === null || v === undefined) ? '—' : Math.round(v) + '점'; }

    function secScores(p) {
        var m = p.monthly || [];
        if (!m.length) return '<div class="rp-sec"><h3>📊 근래 수행율 · 성적</h3><div class="rp-empty">월간 리포트가 아직 없습니다.</div></div>';
        var last = m[0];
        var recent = m.slice(0, 6);
        var avg = function (key) {
            var xs = recent.map(function (r) { return r[key]; }).filter(function (x) { return x !== null && x !== undefined; });
            return xs.length ? Math.round(xs.reduce(function (a, b) { return a + b; }, 0) / xs.length) : null;
        };
        var hi = '<div class="rp-hi">'
            + '<div><div class="k">' + esc(last.month) + ' 숙제수행율</div><div class="v">' + pct(last.homeworkRate) + '</div></div>'
            + '<div><div class="k">' + esc(last.month) + ' 어휘</div><div class="v">' + sco(last.vocab) + '</div></div>'
            + '<div><div class="k">' + esc(last.month) + ' 문법</div><div class="v">' + sco(last.grammar) + '</div></div>'
            + '<div><div class="k">' + esc(last.month) + ' 독해통과</div><div class="v">' + pct(last.reading) + '</div></div>'
            + '<div><div class="k">최근 ' + recent.length + '개월 수행율</div><div class="v">' + pct(avg('homeworkRate')) + '</div></div>'
            + '</div>';
        var rows = m.map(function (r) {
            return '<tr><td style="white-space:nowrap;font-weight:800;">' + esc(r.month) + '</td>'
                + '<td class="rp-num">' + pct(r.homeworkRate) + '</td>'
                + '<td class="rp-num">' + sco(r.vocab) + '</td>'
                + '<td class="rp-num">' + sco(r.grammar) + '</td>'
                + '<td class="rp-num">' + pct(r.reading) + '</td>'
                + '<td>' + (r.bookCount === null || r.bookCount === undefined ? '—' : r.bookCount + '권') + '</td>'
                + '<td>' + (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="color:#0d9488;font-weight:700;">열기</a>' : '—') + '</td></tr>';
        }).join('');
        return '<div class="rp-sec"><h3>📊 근래 수행율 · 성적</h3>' + hi
            + '<div class="rp-scroll"><table class="rp-tbl">'
            + '<tr><th>월</th><th>숙제수행율</th><th>어휘</th><th>문법</th><th>독해통과</th><th>독서</th><th>리포트</th></tr>'
            + rows + '</table></div></div>';
    }

    function secComments(p) {
        var m = (p.monthly || []).filter(function (r) { return r.summary; });
        if (!m.length) return '<div class="rp-sec"><h3>💬 근래 코멘트</h3><div class="rp-empty">월간 리포트 코멘트가 아직 없습니다.</div></div>';
        var items = m.slice(0, 6).map(function (r, i) {
            return '<details class="rp-acc"' + (i === 0 ? ' open' : '') + '>'
                + '<summary>' + esc(r.month) + ' 월간 코멘트</summary>'
                + '<div class="rp-md">' + md(r.summary) + '</div></details>';
        }).join('');
        return '<div class="rp-sec"><h3>💬 근래 코멘트</h3>' + items + '</div>';
    }

    function secCounsel(p) {
        if (p.counselLog === null) {
            return '<div class="rp-sec"><h3>📝 상담 기록</h3><div class="rp-note">상담기록 DB가 서버에 설정되지 않았습니다. Render 환경변수 <b>COUNSEL_LOG_DB_ID</b> 를 확인해 주세요.</div></div>';
        }
        var logs = p.counselLog || [];
        var form = '<div class="rp-form">'
            + '<textarea id="rpCounselText" placeholder="상담 내용을 적어 주세요. 저장하면 아래에 날짜순으로 쌓입니다."></textarea>'
            + '<div class="row"><input type="date" id="rpCounselDate" value="' + todayKST() + '">'
            + '<button class="rp-btn" id="rpCounselBtn" onclick="rpAddCounsel()">＋ 기록 남기기</button>'
            + '<span class="rp-status" id="rpCounselStatus"></span></div></div>';
        var list = logs.length
            ? logs.map(function (l) {
                return '<div class="rp-log"><div class="m">' + esc(l.date) + (l.author ? ' · ' + esc(l.author) : '') + '</div>'
                    + '<div class="c">' + esc(l.comment) + '</div></div>';
            }).join('')
            : '<div class="rp-empty">아직 상담 기록이 없습니다.</div>';
        return '<div class="rp-sec"><h3>📝 상담 기록 <span style="font-weight:600;color:#9aa8a5;font-size:12px;">' + logs.length + '건</span></h3>'
            + form + '<div id="rpCounselList">' + list + '</div></div>';
    }

    function render(p, failed) {
        document.getElementById('rpName').textContent = p.name;
        var bits = [p.school, p.grade, p.grammarClass ? p.grammarClass + '반' : '', (p.teachers || []).join('·'), p.enroll].filter(Boolean);
        if (p.studyStatus && p.studyStatus !== '정상') bits.push('⚠ ' + p.studyStatus);
        var sub = esc(bits.join('  ·  '));
        if (p.notionUrl) sub += ' &nbsp;<a href="' + esc(p.notionUrl) + '" target="_blank" rel="noopener" style="color:#d6f5ef;text-decoration:underline;">노션 ↗</a>';
        document.getElementById('rpSub').innerHTML = sub;

        var warn = (failed && failed.length)
            ? '<div class="rp-note" style="margin-bottom:14px;">' + esc(failed.join(', ')) + ' 을(를) 불러오지 못했습니다. 나머지는 정상입니다.</div>'
            : '';
        document.getElementById('rpBody').innerHTML = warn
            + secBasic(p) + secAttend(p) + secBooks(p) + secPast(p) + secScores(p) + secComments(p) + secCounsel(p);
    }

    /* ── 공개 함수 ──────────────────────────────────────────────── */

    window.openStudentProfile = function (name, pageId) {
        mount();
        var ov = document.getElementById('rpProfileOverlay');
        ov.classList.add('show');
        document.getElementById('rpName').textContent = name || '학생';
        document.getElementById('rpSub').textContent = '불러오는 중…';
        document.getElementById('rpBody').innerHTML = '<div class="rp-empty">노션에서 명부 · 교재비 · 월간 리포트를 모으는 중입니다… (2~4초)</div>';
        state.profile = null;

        // 이름은 항상 같이 보낸다. pageId 가 명부의 것이 아니면 서버가 이름으로 되짚는다.
        var qs = 'name=' + encodeURIComponent(name || '') + (pageId ? '&pageId=' + encodeURIComponent(pageId) : '');
        fetch(API + '/api/student-profile?' + qs, { headers: { 'Authorization': 'Bearer ' + token() } })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok || !res.j.success) throw new Error(res.j.message || '불러오지 못했습니다');
                state.profile = res.j.profile;
                render(res.j.profile, res.j.failed);
            })
            .catch(function (e) {
                document.getElementById('rpSub').textContent = '';
                document.getElementById('rpBody').innerHTML = '<div class="rp-note">' + esc(e.message) + '</div>';
            });
    };

    window.closeStudentProfile = function () {
        var ov = document.getElementById('rpProfileOverlay');
        if (ov) ov.classList.remove('show');
    };

    window.rpSaveAttend = function (sel) {
        var p = state.profile;
        if (!p) return;
        var day = sel.getAttribute('data-day');
        var prev = p.attend.times[day] || '';
        var val = sel.value;
        sel.disabled = true;
        fetch(API + '/api/student-profile/attend-time', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
            body: JSON.stringify({ pageId: p.pageId, day: day, time: val })
        })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (!j.success) throw new Error(j.message || '저장 실패');
                p.attend.times[day] = val;
                sel.style.borderColor = '#0d9488';
                setTimeout(function () { sel.style.borderColor = '#d6e4e2'; }, 900);
            })
            .catch(function (e) {
                sel.value = prev;              // 저장이 안 됐는데 화면만 바뀌어 있으면 안 된다
                alert('등원 시각을 저장하지 못했습니다: ' + e.message);
            })
            .finally(function () { sel.disabled = false; });
    };

    window.rpAddCounsel = function () {
        var p = state.profile;
        if (!p || state.busy) return;
        var ta = document.getElementById('rpCounselText');
        var text = (ta.value || '').trim();
        var stEl = document.getElementById('rpCounselStatus');
        if (!text) { stEl.textContent = '내용을 입력해 주세요'; stEl.style.color = '#dc2626'; return; }

        state.busy = true;
        var btn = document.getElementById('rpCounselBtn');
        btn.disabled = true;
        stEl.textContent = '저장 중…'; stEl.style.color = '#6b8480';

        fetch(API + '/api/student-profile/counsel-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
            body: JSON.stringify({
                pageId: p.pageId,
                studentName: p.name,
                date: document.getElementById('rpCounselDate').value,
                comment: text
            })
        })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (!j.success) throw new Error(j.message || '저장 실패');
                p.counselLog = p.counselLog || [];
                p.counselLog.unshift(j.entry);
                p.counselLog.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
                ta.value = '';
                stEl.textContent = '저장했습니다'; stEl.style.color = '#0d9488';
                document.getElementById('rpCounselList').innerHTML = p.counselLog.map(function (l) {
                    return '<div class="rp-log"><div class="m">' + esc(l.date) + (l.author ? ' · ' + esc(l.author) : '') + '</div>'
                        + '<div class="c">' + esc(l.comment) + '</div></div>';
                }).join('');
            })
            .catch(function (e) { stEl.textContent = e.message; stEl.style.color = '#dc2626'; })
            .finally(function () { state.busy = false; btn.disabled = false; });
    };

    /** 이름에 링크 모양을 입히는 헬퍼. 화면 쪽 템플릿에서 쓴다. */
    window.studentNameLink = function (name, pageId) {
        var n = esc(name);
        return '<span class="rp-name-link" title="' + n + ' 프로필 보기" onclick="event.stopPropagation();openStudentProfile(\''
            + n.replace(/'/g, '&#39;') + '\'' + (pageId ? ',\'' + esc(pageId) + '\'' : '') + ')">' + n + '</span>';
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
