// ==================================================================
// [학사일정 달력 그림] 원장 달력(/calendar)과 학부모 안내(/notice)가 같은 그림을 쓴다.
// 원장이 "이미지로 저장"해 보내는 달력과 학부모가 페이지에서 보는 달력이 달라지지 않게
// 그리는 코드를 여기 하나로 모았다.
//
// 표기 규칙 (2026-09-30, 학부모가 "너무 복잡하다"고 해서 바꿨다)
//  - 동그라미는 두 가지만: 수업 요일 색(월수금·화목)과 휴강(노란색 + 숫자 밑에 "휴강").
//  - 시험기간·학원 행사·보강일은 숫자 밑에 색 선을 긋고 이름을 적는다.
//    예전에는 이것들도 동그라미 색을 바꿔서, 수업하는 날인지 아닌지가 가려졌다.
//  - 오른쪽 위에 트랙별 이 달 수업 횟수, 목표에 못 미치는 달에는 원장이 남긴 안내 문구.
// ==================================================================
(function () {
  const TRACKS = [
    { name: '월수금', days: [1, 3, 5], target: 12 },
    { name: '화목',   days: [2, 4],    target: 8  },
    { name: '화목금', days: [2, 4, 5], target: 12 },
  ];
  // 트랙별 안내 문구를 공지 DB에 이 유형으로 둔다 (제목=트랙 이름, 내용=문구, 날짜=그 달 1일)
  const NOTE_TYPE = '시수메모';

  const CLASS_FILL = { 1: '#fbd4d9', 3: '#fbd4d9', 5: '#fbd4d9', 2: '#a9d6c4', 4: '#a9d6c4' };
  const OFF_FILL = '#e0b64a';
  const LINE_COLOR = { '이벤트': '#b89ad6', '시험기간': '#8fb4e6', '보강일': '#ef9ec4' };
  // 이름을 안 지어 준 표시는 종류 이름으로 적는다. 선만 있으면 뭔지 모른다.
  const DEFAULT_LABEL = { '휴강': '휴강', '이벤트': '행사', '시험기간': '시험기간', '보강일': '보강' };
  const WD = ['일', '월', '화', '수', '목', '금', '토'];

  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m0, d) => y + '-' + pad(m0 + 1) + '-' + pad(d);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function daysOf(it) {
    const out = [];
    const a = new Date(it.start + 'T00:00:00');
    const b = new Date((it.end || it.start) + 'T00:00:00');
    if (isNaN(a) || isNaN(b)) return out;
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
      out.push(iso(d.getFullYear(), d.getMonth(), d.getDate()));
    }
    return out;
  }

  // 휴강만 수업일에서 뺀다. 행사·시험기간은 수업하는 날, 보강일은 결석생 보강이라 시수와 무관하다.
  // 다른 달에서 넘어온 휴강도 이 달 수업일을 지우므로 함께 센다.
  function countSessions(y, m0, items) {
    const off = new Set();
    items.filter(it => it.type === '휴강').forEach(it => daysOf(it).forEach(d => off.add(d)));
    const byDow = {};
    const days = new Date(y, m0 + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      if (off.has(iso(y, m0, d))) continue;
      const dow = new Date(y, m0, d).getDay();
      byDow[dow] = (byDow[dow] || 0) + 1;
    }
    return TRACKS.map(t => {
      const n = t.days.reduce((a, d) => a + (byDow[d] || 0), 0);
      return { name: t.name, n, target: t.target, diff: n - t.target };
    });
  }

  // SVG 에는 글자 폭 측정이 없어서 어림한다. 한글은 글자 크기만큼, 영문·숫자는 그 절반쯤.
  const charW = (ch, fs) => (/[\u0000-ÿ]/.test(ch) ? fs * 0.56 : fs * 0.98);
  const textW = (s, fs) => [...s].reduce((a, ch) => a + charW(ch, fs), 0);
  // 일정 이름은 자르지 않고 줄을 바꾼다. "국어 문해…" 로 잘리면 학부모가 무슨 일정인지 모른다.
  // 띄어쓰기에서 먼저 끊고, 한 낱말이 칸보다 길 때만 글자 단위로 끊는다.
  function wrapWords(s, fs, max) {
    const lines = [];
    let line = '';
    String(s).split(/\s+/).filter(Boolean).forEach(word => {
      const tryLine = line ? line + ' ' + word : word;
      if (textW(tryLine, fs) <= max) { line = tryLine; return; }
      if (line) lines.push(line);
      line = '';
      for (const ch of word) {
        if (line && textW(line + ch, fs) > max) { lines.push(line); line = ch; }
        else line += ch;
      }
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }
  function wrap(s, fs, max) {
    const lines = [];
    let line = '';
    for (const ch of s) {
      if (line && textW(line + ch, fs) > max) { lines.push(line); line = ch === ' ' ? '' : ch; }
      else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * @param {object} o
   *  year, month(0부터), items[{type,start,end,title}], counts(countSessions 결과),
   *  notes{트랙이름: 문구}, title(연·월 제목을 그릴지 — 이미지로 내보낼 때),
   *  pending(점선 동그라미를 칠 날짜), locked(Set: 다른 달 소속이라 못 고치는 날짜)
   */
  function draw(o) {
    const y = o.year, m0 = o.month;
    const items = o.items || [];
    const monthKey = y + '-' + pad(m0 + 1);
    const days = new Date(y, m0 + 1, 0).getDate();
    const lead = new Date(y, m0, 1).getDay();
    const rows = Math.ceil((lead + days) / 7);

    const W = 1080, PAD = 34, CELL = (W - PAD * 2) / 7;
    const idxOf = d => lead + d - 1;
    const colOf = d => idxOf(d) % 7;
    const rowOf = d => Math.floor(idxOf(d) / 7);

    // ── 숫자 밑 줄(레인) 배정 ──
    // 같은 날에 일정이 겹치면 줄을 한 칸씩 내린다. 휴강 글씨가 맨 위 줄을 먼저 차지한다.
    const lanes = items
      .filter(it => DEFAULT_LABEL[it.type])
      .map(it => ({ it, days: daysOf(it).filter(d => d.slice(0, 7) === monthKey).map(d => Number(d.slice(8))) }))
      .filter(x => x.days.length)
      .sort((a, b) => ((a.it.type === '휴강' ? 0 : 1) - (b.it.type === '휴강' ? 0 : 1))
        || a.it.start.localeCompare(b.it.start) || (b.days.length - a.days.length));
    const used = [];
    lanes.forEach(x => {
      let lane = 0;
      while (used[lane] && x.days.some(d => used[lane].has(d))) lane++;
      (used[lane] = used[lane] || new Set());
      x.days.forEach(d => used[lane].add(d));
      x.lane = lane;
    });

    // 선 조각(같은 주에 붙은 날끼리)과 조각마다 이름 줄을 미리 구한다. 줄 수만큼 레인 높이가 늘어난다.
    const LABEL_FS = 23, LABEL_MIN_FS = 16;
    lanes.forEach(x => {
      const it = x.it;
      x.label = (it.title && it.title !== it.type) ? it.title : DEFAULT_LABEL[it.type];
      x.segs = [];
      if (it.type === '휴강') return;
      x.days.forEach(d => {
        const seg = x.segs[x.segs.length - 1];
        const prev = seg && seg.days[seg.days.length - 1];
        if (seg && d === prev + 1 && rowOf(d) === rowOf(prev)) seg.days.push(d);
        else x.segs.push({ days: [d] });
      });
      x.segs.forEach(seg => {
        seg.x1 = PAD + CELL * colOf(seg.days[0]) + 9;
        seg.x2 = PAD + CELL * (colOf(seg.days[seg.days.length - 1]) + 1) - 9;
        // 두 줄 안에 다 들어갈 때까지 글자를 줄인다. 가장 작게 해도 넘치면 세 줄 이상으로 둔다 —
        // 잘라서 "…" 을 붙이는 일은 없다.
        seg.fs = LABEL_FS;
        seg.lines = wrapWords(x.label, seg.fs, seg.x2 - seg.x1 + 8);
        while (seg.lines.length > 2 && seg.fs > LABEL_MIN_FS) {
          seg.fs--;
          seg.lines = wrapWords(x.label, seg.fs, seg.x2 - seg.x1 + 8);
        }
        seg.lh = seg.fs + 4;
      });
      x.h = Math.max(...x.segs.map(g => g.lines.length * g.lh));
    });
    // 레인 높이는 달 전체에서 그 레인의 가장 긴 이름에 맞춘다(행 높이를 고르게 두려고)
    const laneH = [];
    lanes.forEach(x => { laneH[x.lane] = Math.max(laneH[x.lane] || 0, 14 + (x.it.type === '휴강' ? 27 : x.h)); });
    const laneOffset = [];
    laneH.reduce((acc, h, i) => { laneOffset[i] = acc; return acc + (h || 0); }, 0);
    const lanesTotal = laneH.reduce((a, h) => a + (h || 0), 0);
    const offDays = new Set();
    lanes.filter(x => x.it.type === '휴강').forEach(x => x.days.forEach(d => offDays.add(d)));

    // ── 머리: 왼쪽 연·월(선택), 오른쪽 트랙별 횟수, 그 밑에 안내 문구 ──
    const TOP = 34;
    const titleH = o.title ? 112 : 0;
    const counts = o.counts || [];
    const COUNT_FS = 30, COUNT_LH = 42;
    const countsH = counts.length * COUNT_LH;
    const NOTE_FS = 25, NOTE_LH = 36;
    const noteLines = [];
    counts.forEach(c => {
      const t = String((o.notes || {})[c.name] || '').trim();
      if (t) wrap('※ ' + t, NOTE_FS, W - PAD * 2 - 20).forEach(l => noteLines.push(l));
    });
    let cy0 = TOP + Math.max(titleH, countsH);
    const notesTop = cy0 + (noteLines.length ? 16 : 0);
    cy0 = notesTop + noteLines.length * NOTE_LH;
    const weekTop = cy0 + 50;
    const gridTop = weekTop + 26;

    const ROW = Math.max(104, 74 + lanesTotal + 18);
    const legendY = gridTop + rows * ROW + 38;
    const H = legendY + 44;

    let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" font-family="Pretendard, \'Apple SD Gothic Neo\', \'Malgun Gothic\', sans-serif">';
    s += '<rect width="' + W + '" height="' + H + '" fill="#e9eff1"/>';

    if (o.title) {
      s += '<text x="' + PAD + '" y="' + (TOP + 30) + '" font-size="30" font-weight="700" fill="#5b656e">' + y + '</text>';
      s += '<text x="' + PAD + '" y="' + (TOP + 100) + '" font-size="68" font-weight="800" fill="#3a4047">' + (m0 + 1) + '월</text>';
    }
    counts.forEach((c, i) => {
      s += '<text x="' + (W - PAD) + '" y="' + (TOP + 30 + i * COUNT_LH) + '" text-anchor="end" font-size="' + COUNT_FS + '" fill="#3a4047">'
        + '<tspan font-weight="800">' + esc(c.name) + '</tspan> : 총 ' + c.n + '회</text>';
    });
    noteLines.forEach((l, i) => {
      s += '<text x="' + (W - PAD) + '" y="' + (notesTop + 26 + i * NOTE_LH) + '" text-anchor="end" font-size="' + NOTE_FS + '" font-weight="600" fill="#a15b06">' + esc(l) + '</text>';
    });

    for (let i = 0; i < 7; i++) {
      s += '<text x="' + (PAD + CELL * i + CELL / 2) + '" y="' + weekTop + '" text-anchor="middle" font-size="26" fill="'
        + (i === 0 ? '#b4544b' : '#5b656e') + '">' + WD[i] + '</text>';
    }

    // ── 날짜 칸: 동그라미 + 숫자 + 누르는 영역 ──
    for (let d = 1; d <= days; d++) {
      const x0 = PAD + CELL * colOf(d), top = gridTop + rowOf(d) * ROW;
      const cx = x0 + CELL / 2, cy = top + 36;
      const key = iso(y, m0, d);
      const dow = new Date(y, m0, d).getDay();
      const fill = offDays.has(d) ? OFF_FILL : (CLASS_FILL[dow] || '');
      const locked = o.locked && o.locked.has(key);
      s += '<g class="cell' + (locked ? ' locked' : '') + '" data-date="' + key + '">';
      s += '<rect class="hit" x="' + (x0 + 3) + '" y="' + (top + 2) + '" width="' + (CELL - 6) + '" height="' + (ROW - 4) + '" rx="12" fill="transparent"/>';
      if (fill) s += '<circle cx="' + cx + '" cy="' + cy + '" r="29" fill="' + fill + '"/>';
      if (o.pending === key) s += '<circle cx="' + cx + '" cy="' + cy + '" r="33" fill="none" stroke="#0a6c62" stroke-width="4" stroke-dasharray="7 5"/>';
      s += '<text x="' + cx + '" y="' + (cy + 10) + '" text-anchor="middle" font-size="29" fill="#3a4047">' + d + '</text>';
      s += '</g>';
    }

    // ── 숫자 밑 줄과 이름 ──
    s += '<g pointer-events="none">';
    lanes.forEach(x => {
      const laneTop = (d) => gridTop + rowOf(d) * ROW + 72 + laneOffset[x.lane];

      // 휴강은 선 없이 날마다 "휴강" 글씨. 노란 동그라미와 함께 한눈에 쉬는 날로 읽힌다.
      if (x.it.type === '휴강') {
        x.days.forEach(d => {
          s += '<text x="' + (PAD + CELL * colOf(d) + CELL / 2) + '" y="' + (laneTop(d) + 26) + '" text-anchor="middle" font-size="23" font-weight="800" fill="#9a7412">휴강</text>';
        });
        return;
      }

      // 같은 주에 붙은 날끼리 한 선으로. 주가 바뀌면 끊고 이름을 다시 적는다.
      x.segs.forEach(seg => {
        const lt = laneTop(seg.days[0]);
        s += '<rect x="' + seg.x1 + '" y="' + (lt + 2) + '" width="' + (seg.x2 - seg.x1) + '" height="7" rx="3.5" fill="' + LINE_COLOR[x.it.type] + '"/>';
        seg.lines.forEach((ln, i) => {
          s += '<text x="' + ((seg.x1 + seg.x2) / 2) + '" y="' + (lt + 10 + seg.fs + i * seg.lh) + '" text-anchor="middle" font-size="' + seg.fs + '" font-weight="700" fill="#3a4047">'
            + esc(ln) + '</text>';
        });
      });
    });
    s += '</g>';

    // ── 범례: 동그라미 세 가지만. 선은 이름이 붙어 있어서 범례가 필요 없다 ──
    [{ c: CLASS_FILL[1], t: '월 · 수 · 금 수업' }, { c: CLASS_FILL[2], t: '화 · 목 수업' }, { c: OFF_FILL, t: '휴강' }]
      .forEach((L, i) => {
        const lx = PAD + 10 + i * ((W - PAD * 2) / 3);
        s += '<circle cx="' + (lx + 16) + '" cy="' + legendY + '" r="15" fill="' + L.c + '"/>';
        s += '<text x="' + (lx + 42) + '" y="' + (legendY + 9) + '" font-size="25" fill="#4a545c">' + L.t + '</text>';
      });

    return s + '</svg>';
  }

  window.ReadiCal = { TRACKS, NOTE_TYPE, daysOf, countSessions, draw };
})();
