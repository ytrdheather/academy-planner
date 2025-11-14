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

            // [--- 수정된 부분 ---]
            // 책 검색 자동완성 기능을 초기화합니다.
            const engBookInput = document.getElementById('englishBookTitle');
            const korBookInput = document.getElementById('koreanBookTitle');
            
            if (engBookInput) {
                console.log('영어책 검색 기능 초기화');
                this.setupBookSearch(engBookInput, 'english');
            }
            if (korBookInput) {
                console.log('한국책 검색 기능 초기화');
                this.setupBookSearch(korBookInput, 'korean');
            }
            // [--- 수정 종료 ---]

            // 자동 저장 시작
            this.startAutoSave();


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
        // Notion DB의 속성 이름 (progress 객체의 key)을 기반으로 폼을 채웁니다.
        
        // Notion 속성명 -> HTML name 속성 매핑 (일치하지 않는 경우)
        const nameMap = {
            '단어(맞은 개수)': '단어 (맞은 개수)',
            '단어(전체 개수)': '단어 (전체 개수)',
            '문법(전체 개수)': '문법 (전체 개수)',
            '문법(틀린 개수)': '문법 (틀린 개수)',
            '독해(틀린 개수)': '독해 (틀린 개수)',
            '국어 독서 제목': '오늘 읽은 한국 책', // 롤업된 제목이 이 키로 올 수 있음
            '📕 책 읽는 거인': '📕 책 읽는 거인',
            // '오늘 읽은 영어 책'은 롤업 속성('📖 책제목 (롤업)')을 통해 이름이 채워짐
            '📖 책제목 (롤업)': '오늘 읽은 영어 책'
        };
        
        // 값 변환이 필요한 select/status 필드 목록
        const conversionMap = {
            // 숙제 상태
            "숙제 없음": "해당없음",
            "안 해옴": "안 해옴",
            "숙제 함": "숙제 함",
            
            // 리스닝 상태
            "진행하지 않음": "진행하지 않음",
            "완료": "완료",
            "미완료": "미완료",
            
            // 독서 관련 (📖 영어독서)
            "못함": "못함",
            "완료함": "완료함",
            
            // 어휘학습
            "안함": "안함",
            "했음": "했음",
            
            // Writing
            "안함": "안함",
            "완료": "완료",

            // 하브루타
            "숙제없음": "숙제없음",
            "못하고감": "못하고감",
            "완료함": "완료함",
            
            // 책 읽는 거인 (📕 책 읽는 거인)
            "못함": "못함",
            "시작함": "시작함",
            "절반": "절반",
            "거의다읽음": "거의다읽음",
            "완료함": "완료함"
        };
        
        for (const notionKey in progress) {
            const value = progress[notionKey];
            if (value === null || value === undefined) continue;

            // 1. HTML의 name 속성 찾기
            // '이름' 같은 기본 속성은 nameMap에 없을 수 있으므로, notionKey 자체도 확인
            const htmlName = nameMap[notionKey] || notionKey;
            
            // 2. 해당 name 속성을 가진 요소 찾기
            const element = document.querySelector(`[name="${htmlName}"]`);
            if (!element) {
                // console.log(`[fillForm] '${htmlName}' 요소를 찾을 수 없습니다 (NotionKey: ${notionKey})`);
                continue;
            }

            // 3. 값 변환 (필요한 경우)
            // conversionMap에 value가 키로 존재하면 변환된 값을 사용, 아니면 원래 값 사용
            element.value = conversionMap[value] || value;
        }
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
        // [fillFormWithData] 함수 내부 로직과 중복되어 해당 함수로 통합함.
        // 이 함수는 이전 버전 호환성을 위해 남겨둘 수 있으나,
        // loadTodayData -> fillFormWithData 로직에서는 더 이상 직접 사용되지 않음.
        const reverseMapping = {
            "숙제 없음": "해당없음",
            "안 해옴": "안 해옴",
            "숙제 함": "숙제 함",
            "진행하지 않음": "진행하지 않음",
            "완료": "완료",
            "미완료": "미완료",
            "못함": "못함",
            "완료함": "완료함",
            "안함": "안함",
            "했음": "했음",
            "숙제없음": "숙제없음",
            "못하고감": "못하고감",
            "시작함": "시작함",
            "절반": "절반",
            "거의다읽음": "거의다읽음"
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
     * 책 자동완성 초기화 (이전 버전 - 현재 미사용)
     */
   initializeBookAutocomplete() {
    // 이 함수는 setupBookSearch로 대체되었습니다.
    // ... (이전 코드 생략) ...
   }

    /**
     * 책 검색 설정
     */
    setupBookSearch(input, type = 'english') {
        const suggestionsList = type === 'english' 
            ? document.getElementById('bookSuggestions')
            : document.getElementById('korBookSuggestions');

        if (!suggestionsList) {
            console.error(`[setupBookSearch] ${type} suggestions list를 찾을 수 없습니다.`);
            return;
        }

        // 입력 이벤트
        input.addEventListener('input', () => {
            const query = input.value.trim();
            
            // [--- 수정 ---]
            // 사용자가 직접 입력한 경우, 관련 ID를 지웁니다.
            // (선택한 후에 다시 타이핑을 시작하는 경우)
            const idInput = type === 'english'
                ? document.getElementById('englishBookId')
                : document.getElementById('koreanBookId');
            if (idInput) {
                idInput.value = '';
            }
            // [--- 수정 종료 ---]
            
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
            // 사용자가 제안을 클릭할 시간을 주기 위해 약간 지연
            setTimeout(() => {
                this.hideSuggestions(suggestionsList);
            }, 200);
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
        
        const endpoint = type === 'english' 
            ? `/api/search-books?query=${encodeURIComponent(query)}`
            : `/api/search-sayu-books?query=${encodeURIComponent(query)}`;
            
        const response = await fetch(endpoint, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            }
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }
        
        const books = await response.json();
        
        console.log(`검색 결과:`, books);
        this.currentBooks = books;
        this.showSuggestions(books, suggestionsList, type);

    } catch (error) {
        console.error(`책 검색 오류 (${type}):`, error);
        suggestionsList.innerHTML = '<div class="autocomplete-suggestion">❌ 검색 중 오류가 발생했습니다</div>';
        suggestionsList.style.display = 'block';
        setTimeout(() => this.hideSuggestions(suggestionsList), 2000);
    }
}

    /**
     * 검색 결과 표시
     */
    showSuggestions(books, suggestionsList, type) {
        if (!books || books.length === 0) {
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

        // 클릭 이벤트 추가 (mousedown이 blur보다 먼저 실행됨)
        suggestionsList.querySelectorAll('.autocomplete-suggestion').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // blur 이벤트 방지
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
        
        if (suggestionsList.style.display === 'none' || !suggestionsList) return;

        const suggestions = suggestionsList.querySelectorAll('.autocomplete-suggestion');
        if (suggestions.length === 0) return;

        const activeItem = suggestionsList.querySelector('.autocomplete-suggestion.active');
        let activeIndex = Array.from(suggestions).indexOf(activeItem);

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
            suggestions[index].scrollIntoView({ block: 'nearest' });
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
            statusElement.textContent = '임시 저장됨 ' + new Date().toLocaleTimeString();
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
        
        // [--- 수정 ---]
        // 제출 시, ID가 없는 책 이름(직접 타이핑한 경우)을 Notion에 
        // 관계형으로 저장하려 시도하는 것을 방지하기 위해 ID 확인
        if (data['오늘 읽은 영어 책'] && !data['오늘 읽은 영어 책 ID']) {
            console.log('영어책 ID가 없습니다. 텍스트만 전송합니다.');
            // index.js의 /save-progress는 ID가 없으면 관계형 저장을 시도하지 않음
        }
        if (data['오늘 읽은 한국 책'] && !data['오늘 읽은 한국 책 ID']) {
            console.log('한국책 ID가 없습니다. 텍스트만 전송합니다.');
            // index.js의 /save-progress는 ID가 없으면 관계형 저장을 시도하지 않음
        }
        // [--- 수정 종료 ---]

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