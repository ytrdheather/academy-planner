/**
 * Readitude 학원 시스템 설정 파일
 */

const CONFIG = {
    // API 엔드포인트
    API_BASE_URL: window.location.origin,
    
    // 숙제 타입 (planner.html에서 사용)
    HOMEWORK_TYPES: {
        GRAMMAR_CHECK: '⭕ 지난 문법 숙제 검사',
        VOCAB_CARD: '1️⃣ 어휘 클카 암기 숙제',
        READING_VOCAB: '2️⃣ 독해 단어 클카 숙제',
        SUMMARY: '4️⃣ Summary 숙제',
        DAILY_READING: '5️⃣ 매일 독해 숙제',
        DIARY_OR_READING: '6️⃣ 영어일기 or 개인 독해서'
    },
    
    // 숙제 상태 옵션
    HOMEWORK_STATUS: ['해당없음', '안 해옴', '숙제 함','원서독서로 대체','듣기평가교재 완료'],
    
    // 리스닝 학습 상태
    LISTENING_STATUS: ['진행하지 않음', '완료', '미완료'],
    
    // 독서 상태
    READING_STATUS: ['못함', '완료함'],
    
    // 하브루타 상태
    HAVRUTA_STATUS: ['숙제없음', '완료함', '못하고감'],
    
    // 책 읽는 거인 상태
    GIANT_STATUS: ['진행하지 않음', '미완료', '완료'],
    
    // 쓰기 상태
    WRITING_STATUS: ['안함', '완료'],
    
    // 로컬 스토리지 키
    STORAGE_KEYS: {
        AUTH_TOKEN: 'authToken',
        USER_ID: 'studentId',
        USER_NAME: 'studentName',
        PLANNER_DATA: 'plannerData',
        LAST_SAVE: 'lastSaveTime'
    },
    
    // 자동 저장 간격 (밀리초)
    AUTO_SAVE_INTERVAL: 30000, // 30초
    
    // 책 검색 설정
    BOOK_SEARCH: {
        MIN_QUERY_LENGTH: 2,
        DEBOUNCE_TIME: 500,
        MAX_SUGGESTIONS: 10
    },
    
    // UI 메시지
    MESSAGES: {
        LOGIN_SUCCESS: '로그인 성공!',
        LOGIN_FAILED: '아이디 또는 비밀번호가 올바르지 않습니다.',
        SAVE_SUCCESS: '저장이 완료되었습니다!',
        SAVE_FAILED: '저장에 실패했습니다.',
        AUTO_SAVE: '자동 저장됨',
        DATA_RESTORED: '이전 데이터 복원됨',
        AUTH_EXPIRED: '인증 정보가 만료되었습니다. 다시 로그인해주세요.',
        NETWORK_ERROR: '네트워크 오류가 발생했습니다.',
        LOADING: '로딩중...',
        NO_RESULTS: '검색 결과가 없습니다'
    },
    
    // 날짜 포맷
    DATE_FORMAT: {
        DISPLAY: 'YYYY년 MM월 DD일',
        API: 'YYYY-MM-DD'
    }
};

// 전역으로 사용 가능하도록 설정
window.CONFIG = CONFIG;