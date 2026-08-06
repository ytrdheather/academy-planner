# 입학 상담 Apps Script — 노션 기록 + 링크 버튼

구글폼 응답 시트의 Apps Script. Make 를 끄면서 노션 기록이 끊겼는데, 노션에 남아야
예약 확인 알림톡을 보낼 수 있다(원장이 노션에서 `안내 문구` 쓰고 `발송` 체크 → 서버 5분 크론이 발송).

## 이 판에서 달라진 것

1. **노션을 먼저 쓰고, 만든 페이지 주소를 카카오워크 메시지에 버튼으로 단다.**
   알림만 받고 노션은 손으로 찾아야 하면 반쪽이다.
2. **노션 기록이 실패하면 카카오워크 메시지에 그 사실을 적어 보낸다.**
   실행 기록을 열어봐야만 아는 건 결국 아무도 모르는 것과 같다.
3. 노션이 실패해도 **알림은 반드시 나간다.** 신청을 놓치는 것이 최악이다.

## 설치

1. Apps Script 편집기에서 **기존 코드를 이 파일의 코드로 통째로 바꾼다**
   (`onSubmit` 이름을 그대로 써서 트리거를 다시 걸 필요가 없다)
2. ⚙️ 프로젝트 설정 → 스크립트 속성에 두 개가 있어야 한다
   - `KAKAOWORK_APP_KEY` (기존)
   - **`NOTION_TOKEN`** ← Render 의 `NOTION_ACCESS_TOKEN` 과 같은 값
3. `testNotify()` 실행 → 카카오워크 알림에 **[노션에서 열기] 버튼**이 붙어 오면 성공

## 전체 코드

```javascript
/**
 * 입학(신입생) 상담 신청 알림 — Make 제거판
 *   구글폼 → 스프레드시트 → Apps Script → 노션 기록 + 카카오워크 알림
 */

const KAKAOWORK_ADMISSION_CONV = '1004431253274498';           // 신입생 상담알림_BOT 채널
const NOTION_DB_ID = '18609320-bce2-804c-9aaa-ca82ca1256ff';   // 상담신청서 관리

const GROUPS = [
  {
    title: '학생 정보',
    rows: [
      { key: '학생 이름', label: '이름' },
      { key: '학생 학년', label: '학년' },
      { key: '학교 이름', label: '학교' },
    ],
  },
  { rows: [{ key: '학부모님 전화번호', label: '학부모님 연락처' }] },
  {
    title: '상담 요청 내용',
    rows: [
      { key: '상담 관심 과목', label: '관심 과목' },
      { key: '주로 상담하고 싶으신 내용에 체크해주세요.', label: '주요 상담 주제' },
      { key: '상담을 원하는 날짜와 시간', label: '상담 희망 일시' },
    ],
  },
  {
    title: '참고 정보',
    rows: [
      { key: '총 영어 학습 기간 (영어를 학습적으로 배운 기간 / 학원을 다닌 기간 을 위주로 적어주세요.)', label: '총 영어 학습 기간' },
      { key: '가장 최근의 AR 점수가 있다면 써주세요. (상담시 테스트지를 가지고 오시면 보다 더 정확한 상담에 도움이 됩니다.)', label: 'AR 점수' },
      { key: '중학생의 경우 가장 최근의 영어 내신성적과 전체 평균 성적을 적어주세요.', label: '중등 내신/평균' },
      { key: '리디튜드를 어떻게 알게 되셨나요?', label: '어떻게 우리를 알게 되었는지' },
      { key: '재원생 추천인', label: '재원생 추천인' },
    ],
  },
];

/**
 * 시트 헤더(폼 질문) → 노션 속성.
 * 🔴 왼쪽 문자열은 시트 1행의 값과 **정확히** 같아야 한다. 폼 질문을 고치면 여기도 고칠 것.
 */
const NOTION_MAP = [
  { key: '학생 이름', prop: '이름', type: 'title' },
  { key: '학부모님 전화번호', prop: '학부모님 연락처', type: 'phone' },
  { key: '학생 학년', prop: '학생 학년' },
  { key: '학교 이름', prop: '학교 이름' },
  { key: '상담 관심 과목', prop: '상담 관심과목', type: 'select' },
  { key: '상담을 원하는 날짜와 시간', prop: '상담을 원하는 날짜' },
  { key: '주로 상담하고 싶으신 내용에 체크해주세요.', prop: '주로 상담하고 싶은 내용 1' },
  { key: '총 영어 학습 기간 (영어를 학습적으로 배운 기간 / 학원을 다닌 기간 을 위주로 적어주세요.)', prop: '학생의 총 학습 기간' },
  { key: '가장 최근의 AR 점수가 있다면 써주세요. (상담시 테스트지를 가지고 오시면 보다 더 정확한 상담에 도움이 됩니다.)', prop: '최근의 AR 점수 혹은 내신 영어 점수' },
  { key: '중학생의 경우 가장 최근의 영어 내신성적과 전체 평균 성적을 적어주세요.', prop: '주로 상담하고 싶은 내용 2' },
  { key: '리디튜드를 어떻게 알게 되셨나요?', prop: '알게 된 경로' },
  { key: '재원생 추천인', prop: '재원생 추천인' },
];

function onSubmit() {
  const row = readLastResponse_();

  // 노션을 먼저 쓴다. 페이지 주소를 알림에 실어야 원장이 바로 열 수 있다.
  var url = '';
  var notionErr = '';
  try {
    url = writeNotion_(row);
  } catch (e) {
    notionErr = e.message;
    Logger.log('❌ 노션 기록 실패: ' + e.message);
  }

  // 노션이 실패해도 알림은 반드시 보낸다. 신청을 놓치는 것이 최악이다.
  try {
    sendKakaoWork_(buildMessage_(row, notionErr), url);
    Logger.log('입학 상담 알림 발송 완료' + (url ? ' / ' + url : ''));
  } catch (e) {
    Logger.log('❌ 카카오워크 발송 실패: ' + e.message);
  }
}

/** 시트의 마지막 응답 한 줄을 { 질문제목: 값 } 으로 읽는다. */
function readLastResponse_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('읽을 응답이 없습니다');

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const values = sheet.getRange(lastRow, 1, 1, lastCol).getValues()[0];

  const out = {};
  headers.forEach(function (h, i) { out[String(h).trim()] = values[i]; });
  return out;
}

function buildMessage_(row, notionErr) {
  const lines = ['[신입생 상담 신청]'];

  GROUPS.forEach(function (g) {
    lines.push('');
    if (g.title) lines.push(g.title);
    g.rows.forEach(function (f) {
      const v = clean_(row[f.key]) || '없음';
      lines.push((g.title ? '- ' : '') + f.label + ': ' + v);
    });
  });

  if (notionErr) {
    lines.push('', '🔴 노션 기록에 실패했습니다 — 손으로 옮겨 주세요', notionErr.slice(0, 200));
  } else {
    lines.push('', '→ 아래 버튼으로 열어 상담 확정일·안내 문구를 채우고 발송을 켜 주세요.');
  }
  return lines.join('\n');
}

/** 날짜 값이 그대로 오면 읽기 어려운 형식이라 다듬는다. */
function clean_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  return String(v).trim();
}

/** 노션에 한 줄 만들고, 만들어진 페이지 주소를 돌려준다. */
function writeNotion_(row) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('스크립트 속성 NOTION_TOKEN 이 없습니다');

  const props = {
    '접수 경로': { rich_text: [{ text: { content: '구글폼(Apps Script)' } }] },
    '상태': { select: { name: '접수' } },
  };

  NOTION_MAP.forEach(function (f) {
    const v = clean_(row[f.key]);
    if (!v) return;                                  // 빈 값은 아예 안 넣는다
    if (f.type === 'title') props[f.prop] = { title: [{ text: { content: v.slice(0, 200) } }] };
    else if (f.type === 'phone') props[f.prop] = { phone_number: v };
    // 선택지 이름에 앞뒤 공백이 있으면 노션이 다른 값으로 본다. 다듬어서 넣는다.
    else if (f.type === 'select') props[f.prop] = { select: { name: v.replace(/\s+/g, ' ').slice(0, 100) } };
    else props[f.prop] = { rich_text: [{ text: { content: v.slice(0, 2000) } }] };
  });

  if (!props['이름']) props['이름'] = { title: [{ text: { content: '(이름 없음)' } }] };

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28' },
    payload: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: props }),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code >= 300) throw new Error('노션 ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body).url || '';
}

/** 카카오워크 알림. url 이 있으면 노션으로 바로 가는 버튼을 단다. */
function sendKakaoWork_(text, url) {
  const key = PropertiesService.getScriptProperties().getProperty('KAKAOWORK_APP_KEY');
  if (!key) throw new Error('스크립트 속성 KAKAOWORK_APP_KEY 가 없습니다');

  const blocks = [{ type: 'text', text: text, markdown: false }];
  if (url) {
    blocks.push({
      type: 'button', text: '노션에서 열기', style: 'default',
      action_type: 'open_system_browser', value: url,
    });
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify({
      conversation_id: KAKAOWORK_ADMISSION_CONV,
      text: text + (url ? '\n' + url : ''),
      blocks: blocks,
    }),
    muteHttpExceptions: true,
  };

  // 일시적인 오류로 알림이 사라지지 않게 세 번까지 다시 보낸다.
  // 4xx 는 우리가 잘못 보낸 것이라 반복해도 같으므로 즉시 포기한다.
  var last = '';
  for (var i = 1; i <= 3; i++) {
    const res = UrlFetchApp.fetch('https://api.kakaowork.com/v1/messages.send', options);
    const code = res.getResponseCode();
    if (code < 300) return;
    last = '카카오워크 ' + code + ': ' + res.getContentText().slice(0, 200);
    if (code >= 400 && code < 500 && code !== 429) break;
    Utilities.sleep(i * 1000);
  }
  throw new Error(last);
}

/** 설치 후 한 번 실행해 확인한다. 시트의 마지막 응답으로 실제 알림을 보낸다. */
function testNotify() {
  onSubmit();
}
```

## 그다음 원장이 하는 일

1. 카카오워크 알림의 **[노션에서 열기]** 버튼을 누른다
2. **`상담 확정일`** 에 날짜와 **시간까지** 넣는다 (시간을 넣어야 "오후 3시 30분"이 문자에 들어간다)
3. **`안내 문구`** 에 하고 싶은 말을 쓴다 (템플릿의 `#{상담메세지}` 자리)
4. **`발송`** 체크 → 5분 안에 알림톡이 나가고, 체크는 자동으로 꺼지며
   `발송 일시`·`상태=예약확정` 이 기록된다. 결과는 같은 채널에 뜬다

값이 비어 있으면 발송하지 않고 체크만 꺼진 뒤 **무엇이 비었는지 + 노션 링크**가 채널에 온다.

사용 템플릿: `상담예약 안내확인` (`KA01TP250223163830368xwWO2Ze1CcQ`).
버튼 링크는 `blog.naver.com/readitude` 고정이며 `ACADEMY_HOMEPAGE` env 로 바꿀 수 있다.

## 노션 기록이 안 될 때

카카오워크 메시지에 `🔴 노션 기록에 실패했습니다` 가 함께 온다. 거기 적힌 코드로 원인을 안다.

| 코드 | 원인 |
|---|---|
| `NOTION_TOKEN 이 없습니다` | 스크립트 속성을 안 넣었다 |
| `노션 401` | 토큰이 틀렸다 |
| `노션 404` | DB 가 통합에 공유돼 있지 않다 |
| `노션 400 ... is not a property that exists` | `NOTION_MAP` 의 `prop` 이름이 노션 속성과 다르다 |
| `노션 400 ... expected to be title` | 시트 헤더가 바뀌어 `이름` 이 안 잡혔다 |
