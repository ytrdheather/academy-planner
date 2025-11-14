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