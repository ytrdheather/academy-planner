/**
 * 코드가 의존하는 노션 속성 이름 선언.
 *
 * 왜 있나 — 이 저장소에서 가장 자주, 가장 조용히 나는 사고가
 * "노션에서 이름을 바꿨더니 코드가 멈춘 것"이다. pitfalls 7장 중 3장이 그것이다:
 *   · 담임 롤업 이름이 바뀌어 14건이 묻혔다      → wiki/pitfalls/teacher-rollup-name.md
 *   · 반 이름을 바꿔 문법 코멘트 저장이 막혔다    → wiki/pitfalls/grammar-class-rename.md
 *   · 교재 제목 끝 NBSP 로 배정이 막혔다          → wiki/pitfalls/textbook-name-whitespace.md
 *
 * 🔴 여기 적힌 이름은 **필터·정렬·쓰기에 쓰이는 것**들이다. 노션은 없는 속성으로
 * 필터를 걸거나 쓰면 값을 못 찾는 게 아니라 **요청 자체를 400 으로 거절한다.**
 * 즉 하나가 사라지면 그 기능이 통째로 죽는다. 화면엔 아무 말도 안 나온다.
 *
 * 유지 방법 — 코드가 새 속성을 필터·정렬·쓰기에 쓰기 시작하면 여기에도 한 줄 넣는다.
 * 읽기만 하는 속성은 굳이 안 넣어도 된다(없으면 undefined 로 흘러가지 실패하진 않는다).
 * 노션에 속성을 **추가**하는 건 알림이 안 온다 — 사라진 것만 본다.
 *
 * 점검: 매일 07:30 크론 + `POST /api/schema-check/tick` → api/schemaCheckModule.js
 */

export const REQUIRED_PROPERTIES = {
    STUDENT_DATABASE_ID: {
        label: '학생 명부',
        props: ['이름', '재원상태', '학생 ID'],
    },
    PROGRESS_DATABASE_ID: {
        label: '진도 관리',
        props: ['이름', '🕐 날짜', '학생 명부 관리'],
    },
    GRAMMAR_DB_ID: {
        label: '문법 진도',
        // 🔴 '반이름'(select)으로 페이지를 찾다가 개명에 막혔다. 지금은 제목으로 찾는다.
        props: ['제목', '이름', '학생', '날짜', '🕐 날짜', '생성 일시', '오늘 문법 진도', '문법 숙제 내용'],
    },
    MONTHLY_REPORT_DB_ID: {
        label: '월간 리포트',
        props: [
            '이름', '학생', '리포트 월', '월간리포트URL', 'AI 요약',
            '숙제수행율(평균)', '어휘점수(평균)', '문법점수(평균)',
            '독해 통과율(%)', '총 읽은 권수', '읽은 책 목록',
        ],
    },
    ABSENCE_DB_ID: {
        label: '결석·보강',
        props: ['학생명', '학생ID', '담임', '유형', '사유', '상태', '결석일', '시각', '매칭상태', '보강 희망', '요청사항'],
    },
    COUNSEL_DB_ID: {
        label: '재원생 상담',
        props: ['학생명', '학생ID', '담임', '상태', '매칭상태', '문의 내용', '밤10시 이후 통화', '통화 예정일', '확정발송', '확정발송일시'],
    },
    COUNSEL_LOG_DB_ID: {
        label: '학생 상담기록',
        props: ['학생', '학생명', '날짜', '기록', '코멘트', '작성자'],
    },
    ADMISSION_DB_ID: {
        label: '신입생 상담',
        props: ['상담예약함', '알림톡 발송완료'],
    },
    NOTICE_DB_ID: {
        label: '공지·달력',
        props: ['제목', '유형', '날짜', '게시', '보강시간'],
    },
    PAUSE_DB_ID: {
        label: '숙제 정지 기간',
        props: ['시작일', '종료일', '사유', '활성'],
    },
    ENG_BOOKS_ID: {
        label: '영어 원서',
        props: ['책제목'],
    },
    TEXTBOOK_UNIT_DB_ID: {
        label: '교재 단원',
        props: ['교재'],
    },
    EXAM_DB_ID: {
        label: '시험지',
        props: ['시험명', '시험종류', '시험년도', '학교', '학년', '학기', '등록자'],
    },
    STUDENT_RESULT_DB_ID: {
        label: '학생 채점 결과',
        props: ['시험', '학생명', '학생결과'],
    },
};
