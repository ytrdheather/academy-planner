/**
 * Readitude 학생 스터디 플래너 모듈
 * (오리지널 코드 기반 + 다중 책/AR 기능 통합)
 */

class StudyPlanner {
    constructor() {
        this.api = window.API;
        this.autoSaveInterval = null;
        this.currentBooks = [];
        this.searchTimeout = null;
        this.studentInfo = null;

        // [신규] 선택된 책 목록 관리 (배열)
        this.selectedBooks = {
            english: [], 
            korean: []
        };
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

            // 저장된 데이터 복원 (로컬 스토리지)
            this.loadSavedData();

            // 오늘 서버에 저장된 데이터 불러오기
            await this.loadTodayData();

            // 이벤트 리스너 설정
            this.attachEventListeners();

            // [복구] 책 검색 자동완성 기능 초기화 (오리지널 코드 반영)
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

            // 자동 저장 시작
            this.startAutoSave();

        } catch (error) {
            console.error('플래너 초기화 실패:', error);
            Utils.ui.showStatus('초기화 중 오류가 발생했습니다.', false);
        }
    }

    /**
     * 학생 정보 로드 (오리지널 코드 반영: Fallback 로직)
     */
    async loadStudentInfo() {
        try {
            // 1. /api/student-info 시도
            this.studentInfo = await this.api.getStudentInfo();
            
            const nameElement = document.getElementById('studentName');
            if (nameElement) {
                nameElement.textContent = `${this.studentInfo.studentName}(이)의`;
            }
            
            // 로컬 스토리지 저장
            if(window.CONFIG) {
                Utils.storage.save(CONFIG.STORAGE_KEYS.USER_ID, this.studentInfo.studentId);
                Utils.storage.save(CONFIG.STORAGE_KEYS.USER_NAME, this.studentInfo.studentName);
            }

        } catch (error) {
            console.error('학생 정보 로드 실패, user-info로 재시도:', error);
            
            // 2. /api/user-info로 폴백 (재시도)
            try {
                const userInfo = await this.api.getUserInfo(); // api.js에 getUserInfo가 있다고 가정
                this.studentInfo = {
                    studentId: userInfo.userId,
                    studentName: userInfo.userName
                };
                
                const nameElement = document.getElementById('studentName');
                if (nameElement) {
                    nameElement.textContent = `${this.studentInfo.studentName}(이)의`;
                }
            } catch (fallbackError) {
                console.error('user-info도 실패:', fallbackError);
                if (fallbackError.message && (fallbackError.message.includes('401') || fallbackError.message.includes('인증'))) {
                    window.location.href = '/';
                }
            }
        }
    }

    /**
     * 오늘 데이터 불러오기
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

                // [신규] 책 데이터(배열) 복원
                if (data.progress.englishBooks) {
                    this.selectedBooks.english = data.progress.englishBooks;
                    this.renderSelectedBooks('english');
                }
                if (data.progress.koreanBooks) {
                    this.selectedBooks.korean = data.progress.koreanBooks;
                    this.renderSelectedBooks('korean');
                }
                
                const statusElement = document.getElementById('autoSaveStatus');
                if (statusElement) {
                    statusElement.textContent = '저장된 데이터를 불러왔습니다';
                }
            }
        } catch (error) {
            console.log('오늘 데이터 로드 중 에러 (신규 작성일 수 있음):', error);
        }
    }

    /**
     * 폼 채우기 (오리지널 매핑 로직 반영)
     */
    fillFormWithData(progress) {
        // Notion 속성명 -> HTML name 매핑
        const nameMap = {
            '단어(맞은 개수)': '단어 (맞은 개수)',
            '단어(전체 개수)': '단어 (전체 개수)',
            '문법(전체 개수)': '문법 (전체 개수)',
            '문법(틀린 개수)': '문법 (틀린 개수)',
            '독해(틀린 개수)': '독해 (틀린 개수)',
            '국어 독서 제목': '오늘 읽은 한국 책', // [복구]
            '📕 책 읽는 거인': '📕 책 읽는 거인',
            '📖 책제목 (롤업)': '오늘 읽은 영어 책' // [복구]
        };
        
        // 값 변환 매핑 (오리지널 반영)
        const conversionMap = {
            "숙제 없음": "해당없음",
            "안 해옴": "안 해옴",
            "숙제 함": "숙제 함",
            "진행하지 않음": "진행하지 않음",
            "완료": "완료",
            "미완료": "미완료",
            "못함": "못함",
            "완료함": "완료함",
            "SKIP": "SKIP",
            "안함": "안함",
            "숙제없음": "숙제없음",
            "못하고감": "못하고감",
            "시작함": "시작함",
            "절반": "절반",
            "거의다읽음": "거의다읽음"
        };
        
        for (const notionKey in progress) {
            // 책 배열은 별도 처리하므로 건너뜀
            if (notionKey === 'englishBooks' || notionKey === 'koreanBooks') continue;

            const value = progress[notionKey];
            if (value === null || value === undefined) continue;

            const htmlName = nameMap[notionKey] || notionKey;
            const element = document.querySelector(`[name="${htmlName}"]`);
            
            if (element) {
                // 변환된 값이 있으면 사용, 없으면 원래 값 사용
                element.value = conversionMap[value] || value;
            }
        }
    }

    initializeUI() {
        const dateElement = document.getElementById('currentDate');
        if (dateElement) {
            dateElement.textContent = '날짜 : ' + Utils.date.getTodayString();
        }
    }

    attachEventListeners() {
        const form = document.getElementById('plannerForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleSubmit(e));
            form.addEventListener('change', () => this.autoSave());
            form.addEventListener('input', Utils.debounce(() => this.autoSave(), 1000));
        }
        const logoutBtn = document.querySelector('.logout-button');
        if(logoutBtn) logoutBtn.addEventListener('click', () => this.logout());
        
        const manualSaveBtn = document.getElementById('autoSaveBtn');
        if(manualSaveBtn) {
            manualSaveBtn.addEventListener('click', () => {
                this.autoSave();
                Utils.ui.showStatus('임시 저장되었습니다.');
            });
        }
    }

    setupBookSearch(input, type = 'english') {
        const listId = type === 'english' ? 'bookSuggestions' : 'korBookSuggestions';
        const suggestionsList = document.getElementById(listId);

        if (!suggestionsList) return;

        input.addEventListener('input', () => {
            const query = input.value.trim();
            // 입력 시 기존 ID 초기화
            const idInputId = type === 'english' ? 'englishBookId' : 'koreanBookId';
            const idInput = document.getElementById(idInputId);
            if(idInput) idInput.value = '';

            clearTimeout(this.searchTimeout);
            
            if (query.length < 2) {
                this.hideSuggestions(suggestionsList);
                return;
            }

            this.showLoadingState(suggestionsList);
            this.searchTimeout = setTimeout(() => this.searchBooks(query, type, suggestionsList), 500);
        });
        
        input.addEventListener('blur', () => setTimeout(() => this.hideSuggestions(suggestionsList), 200));
        
        // 키보드 네비게이션 등은 생략 (필요시 추가)
    }

    showLoadingState(list) {
        list.innerHTML = '<div class="autocomplete-suggestion">🔍 검색 중...</div>';
        list.style.display = 'block';
    }

    async searchBooks(query, type, suggestionsList) {
        try {
            const endpoint = type === 'english' 
                ? `/api/search-books?query=${encodeURIComponent(query)}`
                : `/api/search-sayu-books?query=${encodeURIComponent(query)}`;
            
            const res = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${this.api.token}` } });
            if (!res.ok) throw new Error('검색 실패');

            const books = await res.json();
            this.currentBooks = books;
            this.showSuggestions(books, suggestionsList, type);
        } catch (e) { 
            console.error(e);
            suggestionsList.innerHTML = '<div class="autocomplete-suggestion">오류 발생</div>';
        }
    }

    showSuggestions(books, list, type) {
        if (!books.length) {
            list.innerHTML = '<div class="autocomplete-suggestion">검색 결과 없음</div>';
            list.style.display = 'block';
            return;
        }
        
        list.innerHTML = books.map((book, idx) => {
            let metaInfo = '';
            if (type === 'english') {
                const arText = book.ar ? `AR ${book.ar}` : '';
                const lexText = book.lexile ? `Lex ${book.lexile}` : '';
                metaInfo = [arText, lexText].filter(Boolean).join(' / ');
            } else {
                metaInfo = book.author || '';
            }

            return `
            <div class="autocomplete-suggestion" data-index="${idx}">
                <div class="book-title">${book.title}</div>
                <div class="book-author" style="font-size: 0.85em; color: #666;">
                    ${metaInfo || book.author || ''}
                </div>
            </div>
            `;
        }).join('');
        list.style.display = 'block';

        list.querySelectorAll('.autocomplete-suggestion').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.selectBook(parseInt(item.dataset.index), type);
            });
        });
    }

    selectBook(index, type = 'english') {
        const book = this.currentBooks[index];
        if (!book) return;

        // 1. 다중 책 목록(배열)에 추가
        const list = type === 'english' ? this.selectedBooks.english : this.selectedBooks.korean;
        if (!list.some(b => b.id === book.id)) {
            list.push({ id: book.id, title: book.title, ar: book.ar, lexile: book.lexile });
        } else {
            Utils.ui.showStatus('이미 추가된 책입니다.', false);
        }

        // 2. UI 렌더링 (태그)
        this.renderSelectedBooks(type);

        // 3. 입력창 초기화 및 ID 저장 (단일 호환성 유지)
        const titleId = type === 'english' ? 'englishBookTitle' : 'koreanBookTitle';
        const idId = type === 'english' ? 'englishBookId' : 'koreanBookId'; // [중요] ID 필드 채워줌
        document.getElementById(titleId).value = ''; 
        const idElem = document.getElementById(idId);
        if(idElem) idElem.value = book.id; // 서버 필터링에서 걸러지겠지만, 일단 값은 넣어둠

        this.hideSuggestions(document.getElementById(type === 'english' ? 'bookSuggestions' : 'korBookSuggestions'));
        this.autoSave();
    }

    renderSelectedBooks(type) {
        const list = type === 'english' ? this.selectedBooks.english : this.selectedBooks.korean;
        const containerId = type === 'english' ? 'selectedEngBooks' : 'selectedKorBooks';
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = list.map((book, idx) => {
            let badgeText = book.title;
            if (type === 'english' && (book.ar || book.lexile)) {
                const info = [book.ar ? `AR ${book.ar}` : '', book.lexile ? `Lex ${book.lexile}` : ''].filter(Boolean).join('/');
                badgeText += ` <span style="font-weight:normal; opacity:0.8; font-size:0.9em;">(${info})</span>`;
            }
            return `<div class="book-tag"><span>${badgeText}</span><span class="remove-btn" onclick="window.plannerInstance.removeBook('${type}', ${idx})">×</span></div>`;
        }).join('');
    }

    removeBook(type, index) {
        const list = type === 'english' ? this.selectedBooks.english : this.selectedBooks.korean;
        list.splice(index, 1);
        this.renderSelectedBooks(type);
        this.autoSave();
    }

    hideSuggestions(list) { if(list) list.style.display = 'none'; }

    autoSave() {
        const formData = new FormData(document.getElementById('plannerForm'));
        const data = Object.fromEntries(formData);
        if(window.CONFIG) Utils.storage.save(CONFIG.STORAGE_KEYS.PLANNER_DATA, data);
        const status = document.getElementById('autoSaveStatus');
        if(status) status.textContent = '임시 저장됨 ' + new Date().toLocaleTimeString();
    }

    loadSavedData() {
        if(!window.CONFIG) return;
        const savedData = Utils.storage.load(CONFIG.STORAGE_KEYS.PLANNER_DATA);
        if (savedData) {
            Object.keys(savedData).forEach(key => {
                const element = document.querySelector(`[name="${key}"]`);
                if (element) element.value = savedData[key];
            });
            const status = document.getElementById('autoSaveStatus');
            if(status) status.textContent = '이전 데이터 복원됨';
        }
    }

    startAutoSave() { 
        this.autoSaveInterval = setInterval(() => this.autoSave(), 30000);
    }

    async handleSubmit(event) {
        event.preventDefault();
        const formData = new FormData(event.target);
        const data = Object.fromEntries(formData);
        
        // [핵심] 책 배열 데이터 추가
        data.englishBooks = this.selectedBooks.english;
        data.koreanBooks = this.selectedBooks.korean;

        // [수정] ID 없는 텍스트 제거 (오리지널 코드 참고)
        if (data['오늘 읽은 영어 책'] && !data['오늘 읽은 영어 책 ID']) delete data['오늘 읽은 영어 책'];
        if (data['오늘 읽은 한국 책'] && !data['오늘 읽은 한국 책 ID']) delete data['오늘 읽은 한국 책'];

        Utils.ui.showLoading('저장 중...');
        try {
            const response = await fetch('/save-progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.api.token}` },
                body: JSON.stringify(data)
            });
            const result = await response.json();
            
            Utils.ui.hideLoading();
            if(result.success || response.ok) {
                Utils.ui.showStatus('저장 완료!', true);
                if(window.CONFIG) Utils.storage.remove(CONFIG.STORAGE_KEYS.PLANNER_DATA);
                document.getElementById('autoSaveStatus').textContent = '정식 저장 완료';
            } else {
                throw new Error(result.message || '저장 실패');
            }
        } catch (error) {
            Utils.ui.hideLoading();
            Utils.ui.showStatus('저장 실패: ' + error.message, false);
        }
    }

    async logout() {
        if(await Utils.ui.confirm('로그아웃 하시겠습니까?')) {
            this.api.logout();
            window.location.href = '/';
        }
    }
    
    destroy() { 
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
        if (this.searchTimeout) clearTimeout(this.searchTimeout);
    }
}

window.StudyPlanner = StudyPlanner;
document.addEventListener('DOMContentLoaded', () => {
    window.plannerInstance = new StudyPlanner();
    window.plannerInstance.initialize();
});