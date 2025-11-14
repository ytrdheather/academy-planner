/**
 * Readitude 학생 스터디 플래너 모듈
 */

class StudyPlanner {
    constructor() {
        this.api = window.API;
        this.autoSaveInterval = null;
        this.currentBooks = [];
        this.searchTimeout = null;
        this.studentInfo = null;
    }

    /**
     * 플래너 초기화
     */
    async initialize() {
        try {
            // 인증 확인
            if (!this.api.token) {
                window.location.href = '/';
                return;
            }

            // 학생 정보 로드
            await this.loadStudentInfo();

            // UI 초기화
            this.initializeUI();

            // 저장된 데이터 복원
            this.loadSavedData();

            // 오늘 서버에 저장된 데이터 불러오기
            await this.loadTodayData();

            // 이벤트 리스너 설정
            this.attachEventListeners();

            // 자동 저장 시작
            this.startAutoSave();

            // 책 자동완성 초기화
            this.initializeBookAutocomplete();

        } catch (error) {
            console.error('플래너 초기화 실패:', error);
            Utils.ui.showStatus('초기화 중 오류가 발생했습니다.', false);
        }
    }

    /**
     * 학생 정보 로드
     */
    async loadStudentInfo() {
        try {
            // 먼저 /api/student-info를 시도
            this.studentInfo = await this.api.getStudentInfo();
            
            // 학생 이름 표시
            const nameElement = document.getElementById('studentName');
            if (nameElement) {
                nameElement.textContent = `${this.studentInfo.studentName}(이)의`;
            }

            // 로컬 스토리지에 저장
            Utils.storage.save(CONFIG.STORAGE_KEYS.USER_ID, this.studentInfo.studentId);
            Utils.storage.save(CONFIG.STORAGE_KEYS.USER_NAME, this.studentInfo.studentName);

        } catch (error) {
            console.error('학생 정보 로드 실패, user-info로 재시도:', error);
            
            // /api/user-info로 폴백
            try {
                const userInfo = await this.api.getUserInfo();
                this.studentInfo = {
                    studentId: userInfo.userId,
                    studentName: userInfo.userName
                };
                
                // 학생 이름 표시
                const nameElement = document.getElementById('studentName');
                if (nameElement) {
                    nameElement.textContent = `${this.studentInfo.studentName}(이)의`;
                }

                // 로컬 스토리지에 저장
                Utils.storage.save(CONFIG.STORAGE_KEYS.USER_ID, this.studentInfo.studentId);
                Utils.storage.save(CONFIG.STORAGE_KEYS.USER_NAME, this.studentInfo.studentName);
                
            } catch (fallbackError) {
                console.error('user-info도 실패:', fallbackError);
                // 토큰이 유효하지 않은 경우 로그인 페이지로
                if (fallbackError.message.includes('401') || fallbackError.message.includes('인증')) {
                    window.location.href = '/';
                }
            }
        }
    }
 /**
     * 오늘 저장된 데이터 불러오기
     */
    async loadTodayData() {
        try {
            console.log('오늘 데이터 불러오기 시작...');
            
            const response = await fetch('/api/get-today-progress', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.api.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.log('데이터 로드 실패:', response.status);
                return;
            }

            const data = await response.json();
            
            if (data.success && data.progress) {
                console.log('불러온 데이터:', data.progress);
                this.fillFormWithData(data.progress);
                
                // 상태 메시지는 선택적으로 표시
                const statusElement = document.getElementById('autoSaveStatus');
                if (statusElement) {
                    statusElement.textContent = '저장된 데이터를 불러왔습니다';
                }
            }
        } catch (error) {
            console.log('오늘 데이터 로드 중 에러 (정상적일 수 있음):', error);
            // 첫 사용자는 데이터가 없을 수 있으므로 에러 메시지 표시 안 함
        }
    }

    /**
     * 폼에 데이터 채우기
     */
    fillFormWithData(progress) {
        // 숙제 확인 섹션
        this.setFieldValue('[name="⭕ 지난 문법 숙제 검사"]', progress['⭕ 지난 문법 숙제 검사'], true);
        this.setFieldValue('[name="1️⃣ 어휘 클카 암기 숙제"]', progress['1️⃣ 어휘 클카 암기 숙제'], true);
        this.setFieldValue('[name="2️⃣ 독해 단어 클카 숙제"]', progress['2️⃣ 독해 단어 클카 숙제'], true);
        this.setFieldValue('[name="4️⃣ Summary 숙제"]', progress['4️⃣ Summary 숙제'], true);
        this.setFieldValue('[name="5️⃣ 매일 독해 숙제"]', progress['5️⃣ 매일 독해 숙제'], true);
        this.setFieldValue('[name="6️⃣ 영어일기 or 개인 독해서"]', progress['6️⃣ 영어일기 or 개인 독해서'], true);
        
        // 시험 결과 섹션 (괄호 앞 공백 주의!)
        this.setFieldValue('[name="단어 (맞은 개수)"]', progress['단어(맞은 개수)']);  // DB는 공백 없음
        this.setFieldValue('[name="단어 (전체 개수)"]', progress['단어(전체 개수)']);
        this.setFieldValue('[name="어휘유닛"]', progress['어휘유닛']);
        this.setFieldValue('[name="문법 (전체 개수)"]', progress['문법(전체 개수)']);
        this.setFieldValue('[name="문법 (틀린 개수)"]', progress['문법(틀린 개수)']);
        this.setFieldValue('[name="독해 (틀린 개수)"]', progress['독해(틀린 개수)']);
        this.setFieldValue('[name="독해 하브루타"]', progress['독해 하브루타'], true);
        
        // 리스닝 학습 섹션
        this.setFieldValue('[name="영어 더빙 학습 완료"]', progress['영어 더빙 학습 완료'], true);
        this.setFieldValue('[name="더빙 워크북 완료"]', progress['더빙 워크북 완료'], true);
        
        // 원서 독서 섹션
        this.setFieldValue('[name="오늘 읽은 영어 책"]', progress['오늘 읽은 영어 책']);
        this.setFieldValue('[name="📖 영어독서"]', progress['📖 영어독서'], true);
        this.setFieldValue('[name="어휘학습"]', progress['어휘학습'], true);
        this.setFieldValue('[name="Writing"]', progress['Writing'], true);
        
        // 한국 독서 섹션
        this.setFieldValue('[name="국어 독서 제목"]', progress['국어 독서 제목']);
        this.setFieldValue('[name="완료 여부"]', progress['📕 책 읽는 거인'], true);
        
        // 학습 소감
        this.setFieldValue('[name="오늘의 학습 소감"]', progress['오늘의 학습 소감']);
    }

    /**
     * 필드 값 설정 헬퍼 함수
     */
    setFieldValue(selector, value, needsConversion = false) {
        if (!value) return;
        
        const element = document.querySelector(selector);
        if (element) {
            if (needsConversion) {
                element.value = this.convertNotionToWebValue(value);
            } else {
                element.value = value;
            }
        }
    }

    /**
     * Notion 값을 웹앱 표시 값으로 변환
     */
    convertNotionToWebValue(value) {
        const reverseMapping = {
            // 숙제 상태
            "숙제 없음": "해당없음",
            "안 해옴": "안 해옴",
            "숙제 함": "숙제 함",
            
            // 리스닝 상태
            "진행하지 않음": "진행하지 않음",
            "완료": "완료",
            "미완료": "미완료",
            
            // 독서 관련
            "못함": "못함",
            "완료함": "완료함",
            "진행하지 않음": "진행하지 않음",
            "미완료": "미완료",
            
            // 어휘학습
            "못함": "못함",
            "완료함": "완료함",
            
            // Writing
            "3 SENTENCE": "3 SENTENCE",
            "SKIP": "SKIP",
            "북 리포트": "북 리포트",

            // 하브루타
            "숙제없음": "숙제없음",
            "못하고감": "못하고감",
            "완료함": "완료함"
        };
        
        return reverseMapping[value] || value;
    }

    
    /**
     * UI 초기화
     */
    initializeUI() {
        // 현재 날짜 표시
        const dateElement = document.getElementById('currentDate');
        if (dateElement) {
            dateElement.textContent = '날짜 : ' + Utils.date.getTodayString();
        }

        // 환영 메시지 업데이트
        const welcomeElement = document.getElementById('welcomeMessage');
        if (welcomeElement && this.studentInfo) {
            welcomeElement.querySelector('#studentName').textContent = `${this.studentInfo.studentName}(이)의`;
        }
    }

    /**
     * 이벤트 리스너 설정
     */
    attachEventListeners() {
        // 폼 제출
        const form = document.getElementById('plannerForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleSubmit(e));
            
            // 입력 변경시 자동 저장
            form.addEventListener('change', () => this.autoSave());
            form.addEventListener('input', Utils.debounce(() => this.autoSave(), 1000));
        }

        // 임시 저장 버튼
        const saveBtn = document.getElementById('autoSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.autoSave();
                Utils.ui.showStatus('데이터가 임시 저장되었습니다.');
            });
        }

        // 로그아웃 버튼
        const logoutBtn = document.querySelector('.logout-button');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.logout());
        }
    }

    /**
     * 책 자동완성 초기화
     */
    initializeBookAutocomplete() {
        const bookInput = document.getElementById('englishBookTitle');
        const korBookInput = document.getElementById('koreanBookTitle');

        if (bookInput) {
            this.setupBookSearch(bookInput, 'english');
        }

        if (korBookInput) {
            this.setupBookSearch(korBookInput, 'korean');
        }
    }

    /**
     * 책 검색 설정
     */
    setupBookSearch(input, type = 'english') {
        const suggestionsList = type === 'english' 
            ? document.getElementById('bookSuggestions')
            : document.getElementById('korBookSuggestions');

        if (!suggestionsList) return;

        // 입력 이벤트
        input.addEventListener('input', () => {
            const query = input.value.trim();
            
            clearTimeout(this.searchTimeout);
            
            if (query.length < CONFIG.BOOK_SEARCH.MIN_QUERY_LENGTH) {
                this.hideSuggestions(suggestionsList);
                return;
            }

            this.showLoadingState(suggestionsList);

            this.searchTimeout = setTimeout(() => {
                this.searchBooks(query, type, suggestionsList);
            }, CONFIG.BOOK_SEARCH.DEBOUNCE_TIME);
        });

        // 포커스 아웃
        input.addEventListener('blur', () => {
            setTimeout(() => this.hideSuggestions(suggestionsList), 200);
        });

        // 키보드 네비게이션
        input.addEventListener('keydown', (event) => {
            this.handleKeyboardNavigation(event, suggestionsList, type);
        });
    }

    /**
     * 책 검색 실행
     */
    async searchBooks(query, type, suggestionsList) {
        try {
            console.log(`책 검색 시작: ${type}, 쿼리: ${query}`);
            
            const books = type === 'english' 
                ? await this.api.searchEnglishBooks(query)
                : await this.api.searchKoreanBooks(query);

            console.log(`검색 결과:`, books);
            this.currentBooks = books;
            this.showSuggestions(books, suggestionsList, type);

        } catch (error) {
            console.error(`책 검색 오류 (${type}):`, error);
            
            // 인증 오류인 경우 특별 처리
            if (error.message.includes('401')) {
                suggestionsList.innerHTML = '<div class="autocomplete-suggestion">⚠️ 로그인이 필요합니다</div>';
            } else {
                suggestionsList.innerHTML = '<div class="autocomplete-suggestion">❌ 검색 중 오류가 발생했습니다</div>';
            }
            suggestionsList.style.display = 'block';
            
            // 2초 후 숨기기
            setTimeout(() => this.hideSuggestions(suggestionsList), 2000);
        }
    }

    /**
     * 검색 결과 표시
     */
    showSuggestions(books, suggestionsList, type) {
        if (books.length === 0) {
            suggestionsList.innerHTML = '<div class="autocomplete-suggestion">📚 검색 결과가 없습니다</div>';
            suggestionsList.style.display = 'block';
            return;
        }

        suggestionsList.innerHTML = books.map((book, index) => {
            if (type === 'english') {
                return `
                    <div class="autocomplete-suggestion" data-index="${index}" data-id="${book.id}">
                        <div class="book-title">${book.title || 'No Title'}</div>
                        ${book.author ? `<div class="book-author">by ${book.author}</div>` : ''}
                        ${book.level ? `<div class="book-level">Level ${book.level}</div>` : ''}
                    </div>
                `;
            } else {
                return `
                    <div class="autocomplete-suggestion" data-index="${index}" data-id="${book.id}">
                        <div class="book-title">${book.title || 'No Title'}</div>
                        ${book.author ? `<div class="book-author">저자: ${book.author}</div>` : ''}
                        ${book.publisher ? `<div class="book-author">출판: ${book.publisher}</div>` : ''}
                    </div>
                `;
            }
        }).join('');

        // 클릭 이벤트 추가
        suggestionsList.querySelectorAll('.autocomplete-suggestion').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                this.selectBook(index, type);
            });
        });

        suggestionsList.style.display = 'block';
    }

    /**
     * 책 선택
     */
    selectBook(index, type = 'english') {
        const book = this.currentBooks[index];
        if (!book) return;

        if (type === 'english') {
            document.getElementById('englishBookTitle').value = book.title;
            document.getElementById('englishBookId').value = book.id;
            this.hideSuggestions(document.getElementById('bookSuggestions'));
        } else {
            document.getElementById('koreanBookTitle').value = book.title;
            document.getElementById('koreanBookId').value = book.id;
            this.hideSuggestions(document.getElementById('korBookSuggestions'));
        }

        // 자동 저장
        this.autoSave();
    }

    /**
     * 로딩 상태 표시
     */
    showLoadingState(suggestionsList) {
        suggestionsList.innerHTML = '<div class="autocomplete-suggestion">🔍 검색 중...</div>';
        suggestionsList.style.display = 'block';
    }

    /**
     * 제안 숨기기
     */
    hideSuggestions(suggestionsList) {
        if (suggestionsList) {
            suggestionsList.style.display = 'none';
            suggestionsList.innerHTML = '';
        }
    }

    /**
     * 키보드 네비게이션
     */
    handleKeyboardNavigation(event, suggestionsList, type) {
        if (event.key === 'Escape') {
            this.hideSuggestions(suggestionsList);
            return;
        }

        const suggestions = suggestionsList.querySelectorAll('.autocomplete-suggestion');
        const activeIndex = Array.from(suggestions).findIndex(s => s.classList.contains('active'));

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            const nextIndex = activeIndex < suggestions.length - 1 ? activeIndex + 1 : 0;
            this.setActiveSuggestion(suggestions, nextIndex);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            const prevIndex = activeIndex > 0 ? activeIndex - 1 : suggestions.length - 1;
            this.setActiveSuggestion(suggestions, prevIndex);
        } else if (event.key === 'Enter' && activeIndex >= 0) {
            event.preventDefault();
            this.selectBook(activeIndex, type);
        }
    }

    /**
     * 활성 제안 설정
     */
    setActiveSuggestion(suggestions, index) {
        suggestions.forEach(s => s.classList.remove('active'));
        if (suggestions[index]) {
            suggestions[index].classList.add('active');
        }
    }

    /**
     * 자동 저장
     */
    autoSave() {
        const formData = new FormData(document.getElementById('plannerForm'));
        const data = Object.fromEntries(formData);
        
        // 로컬 스토리지에 저장
        Utils.storage.save(CONFIG.STORAGE_KEYS.PLANNER_DATA, data);
        
        // 상태 표시
        const statusElement = document.getElementById('autoSaveStatus');
        if (statusElement) {
            statusElement.textContent = '자동 저장됨 ' + new Date().toLocaleTimeString();
        }
    }

    /**
     * 저장된 데이터 로드
     */
    loadSavedData() {
        const savedData = Utils.storage.load(CONFIG.STORAGE_KEYS.PLANNER_DATA);
        if (!savedData) return;

        Object.keys(savedData).forEach(key => {
            const element = document.querySelector(`[name="${key}"]`);
            if (element) {
                element.value = savedData[key];
            }
        });

        const statusElement = document.getElementById('autoSaveStatus');
        if (statusElement) {
            statusElement.textContent = '이전 데이터 복원됨';
        }
    }

    /**
     * 자동 저장 시작
     */
    startAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
        }
        
        this.autoSaveInterval = setInterval(() => {
            this.autoSave();
        }, CONFIG.AUTO_SAVE_INTERVAL);
    }

    /**
     * 폼 제출 처리
     */
    async handleSubmit(event) {
        event.preventDefault();

        const formData = new FormData(event.target);
        const data = Object.fromEntries(formData);

        Utils.ui.showLoading('저장 중...');

        try {
            const response = await this.api.saveProgress(data);
            
            Utils.ui.hideLoading();
            Utils.ui.showStatus(response.message || CONFIG.MESSAGES.SAVE_SUCCESS, true);
            
            // 임시 저장 데이터 삭제
            Utils.storage.remove(CONFIG.STORAGE_KEYS.PLANNER_DATA);
            
            const statusElement = document.getElementById('autoSaveStatus');
            if (statusElement) {
                statusElement.textContent = '정식 저장 완료';
            }

        } catch (error) {
            Utils.ui.hideLoading();
            Utils.ui.showStatus(error.message || CONFIG.MESSAGES.SAVE_FAILED, false);
            
            // 인증 오류시 로그인 페이지로
            if (error.message.includes('401') || error.message.includes('인증')) {
                setTimeout(() => {
                    window.location.href = '/';
                }, 2000);
            }
        }
    }

    /**
     * 로그아웃
     */
    async logout() {
        if (await Utils.ui.confirm('로그아웃 하시겠습니까?')) {
            this.api.logout();
            Utils.storage.clear();
            window.location.href = '/';
        }
    }

    /**
     * 정리
     */
    destroy() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
        }
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }
    }
}

// 전역 플래너 인스턴스
window.StudyPlanner = StudyPlanner;