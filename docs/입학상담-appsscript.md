# 입학 상담 Apps Script — 노션 기록 추가분

구글폼 응답 시트의 Apps Script 에 **아래를 덧붙인다.** 기존 `onSubmit` 은 카카오워크만 보내는데,
Make 를 끄면서 노션 기록이 끊겼다. 노션에 남아야 예약 확인 알림톡을 보낼 수 있다
(원장이 노션에서 `안내 문구` 쓰고 `발송` 체크 → 서버 5분 크론이 발송).

## 설치

1. Apps Script 편집기 → 기존 코드 **아래에 이 파일 내용을 붙여넣는다**
2. `onSubmit` 안에서 `sendKakaoWork_(text)` 바로 다음 줄에 `writeNotion_(row);` 를 추가한다
3. ⚙️ 프로젝트 설정 → 스크립트 속성에 **`NOTION_TOKEN`** 을 넣는다 (Render 의 `NOTION_ACCESS_TOKEN` 과 같은 값)
4. `testNotify()` 로 한 번 확인 — 카카오워크 알림과 노션 행이 **둘 다** 생겨야 한다

## onSubmit 수정 모양

```javascript
function onSubmit() {
  try {
    const row = readLastResponse_();
    const text = buildMessage_(row);
    sendKakaoWork_(text);
    writeNotion_(row);              // ← 이 줄만 추가
    Logger.log('입학 상담 알림 발송 완료');
  } catch (err) {
    Logger.log('❌ 입학 상담 알림 실패: ' + err.message);
  }
}
```

> 카카오워크를 먼저 보내고 노션을 나중에 쓴다. 노션이 실패해도 **알림은 이미 나간 뒤**라
> 신청을 놓치지 않는다. 시트에도 원본이 그대로 남는다.

## 붙여넣을 코드

```javascript
// ── 노션 기록 ─────────────────────────────────────────────────
const NOTION_DB_ID = '18609320-bce2-804c-9aaa-ca82ca1256ff';   // 상담신청서 관리

/**
 * 시트 헤더(폼 질문) → 노션 속성 이름.
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

function writeNotion_(row) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('스크립트 속성 NOTION_TOKEN 이 없습니다');

  const props = {
    // 나중에 "이건 어디로 들어온 건이지?" 를 구분하려고 남긴다
    '접수 경로': { rich_text: [{ text: { content: '구글폼(Apps Script)' } }] },
    '상태': { select: { name: '접수' } },
  };

  NOTION_MAP.forEach(function (f) {
    const v = clean_(row[f.key]);
    if (!v) return;                                  // 빈 값은 아예 안 넣는다
    if (f.type === 'title') props[f.prop] = { title: [{ text: { content: v.slice(0, 200) } }] };
    else if (f.type === 'phone') props[f.prop] = { phone_number: v };
    else if (f.type === 'select') props[f.prop] = { select: { name: v.slice(0, 100) } };
    else props[f.prop] = { rich_text: [{ text: { content: v.slice(0, 2000) } }] };
  });

  // 이름이 없으면 노션에서 찾을 수가 없다. 최소한 자리는 만들어 둔다.
  if (!props['이름']) props['이름'] = { title: [{ text: { content: '(이름 없음)' } }] };

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28' },
    payload: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: props }),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code >= 300) throw new Error('노션 ' + code + ': ' + res.getContentText().slice(0, 300));
  Logger.log('노션 기록 완료');
}
```

## 그다음 원장이 하는 일

1. 노션 `상담신청서 관리` 에서 그 행을 연다
2. **`상담 확정일`** 에 날짜와 **시간까지** 넣는다 (시간을 넣어야 "오후 3시 30분"이 문자에 들어간다)
3. **`안내 문구`** 에 하고 싶은 말을 쓴다 (템플릿의 `#{상담메세지}` 자리)
4. **`발송`** 체크 → 5분 안에 알림톡이 나가고, 체크는 자동으로 꺼지며 `발송 일시`·`상태=예약확정` 이 기록된다

값이 비어 있으면 발송하지 않고 체크만 꺼진 뒤 **원장 카카오워크 DM 으로 무엇이 비었는지** 알려준다.

사용 템플릿: `상담예약 안내확인` (`KA01TP250223163830368xwWO2Ze1CcQ`).
버튼 링크는 `blog.naver.com/readitude` 로 고정돼 있고 `ACADEMY_HOMEPAGE` env 로 바꿀 수 있다.
