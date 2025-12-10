/**
 * Readitude 학생 스터디 플래너 모듈
 * (모바일 터치 지원 추가 + Writing 옵션 대응)
 */

class StudyPlanner {
    constructor() {
        this.api = window.API;
        this.autoSaveInterval = null;
        this.currentBooks = [];
        this.searchTimeout = null;
        this.studentInfo = null;
        this.selectedBooks = {
            english: [], 
            korean: []
        };
    }

    async initialize() {
        try {
            if (!this.api.token) { window.location.href = '/'; return; }
            await this.loadStudentInfo();
            this.initializeUI();
            this.loadSavedData();
            await this.loadTodayData();
            this.attachEventListeners();

            const engBookInput = document.getElementById('englishBookTitle');
            const korBookInput = document.getElementById('koreanBookTitle');
            
            if (engBookInput) this.setupBookSearch(engBookInput, 'english');
            if (korBookInput) this.setupBookSearch(korBookInput, 'korean');

            this.startAutoSave();
        } catch (error) {
            console.error('플래너 초기화 실패:', error);
            if(window.Utils && window.Utils.ui) {
                Utils.ui.showStatus('초기화 중 오류가 발생했습니다.', false);
            }
        }
    }

    async loadStudentInfo() {
        try {
            this.studentInfo = await this.api.getStudentInfo();
            const nameElement = document.getElementById('studentName');
            if (nameElement) {
                nameElement.textContent = `${this.studentInfo.studentName}(이)의`;
            }
            if(window.CONFIG && window.Utils) {
                Utils.storage.save(CONFIG.STORAGE_KEYS.USER_ID, this.studentInfo.studentId);
                Utils.storage.save(CONFIG.STORAGE_KEYS.USER_NAME, this.studentInfo.studentName);
            }
        } catch (error) {
            console.error('학생 정보 로드 실패, user-info로 재시도:', error);
            try {
                const userInfo = await this.api.getUserInfo();
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

    async loadTodayData() {
        try {
            const response = await fetch('/api/get-today-progress', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.api.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) return;

            const data = await response.json();
            
            if (data.success && data.progress) {
                this.fillFormWithData(data.progress);

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
            console.log('오늘 데이터 로드 중 에러:', error);
        }
    }

    fillFormWithData(progress) {
        const nameMap = {
            '단어 (맞은 개수)': '단어 (맞은 개수)',
            '단어 (전체 개수)': '단어 (전체 개수)',
            '문법 (전체 개수)': '문법 (전체 개수)',
            '문법 (틀린 개수)': '문법 (틀린 개수)',
            '독해 (틀린 개수)': '독해 (틀린 개수)',
            '국어 독서 제목': '오늘 읽은 한국 책',
            '📕 책 읽는 거인': '📕 책 읽는 거인',
            '📖 책제목 (롤업)': '오늘 읽은 영어 책'
        };
        
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
            "원서독서로 대체": "원서독서로 대헤",
            "듣기평가교재 완료": "듣기평가교재 완료",
            
        };
        
        for (const notionKey in progress) {
            if (notionKey === 'englishBooks' || notionKey === 'koreanBooks') continue;

            const value = progress[notionKey];
            if (value === null || value === undefined) continue;

            const htmlName = nameMap[notionKey] || notionKey;
            const element = document.querySelector(`[name="${htmlName}"]`);
            
            if (element) {
                element.value = conversionMap[value] || value;
            }
        }
    }

    initializeUI() {
        const dateElement = document.getElementById('currentDate');
        if (dateElement && window.Utils) {
            dateElement.textContent = '날짜 : ' + Utils.date.getTodayString();
        }
    }

    attachEventListeners() {
        const form = document.getElementById('plannerForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleSubmit(e));
            form.addEventListener('change', () => this.autoSave());
            if(window.Utils) {
                form.addEventListener('input', Utils.debounce(() => this.autoSave(), 1000));
            }
        }
        const logoutBtn = document.querySelector('.logout-button');
        if(logoutBtn) logoutBtn.addEventListener('click', () => this.logout());
        
        const manualSaveBtn = document.getElementById('autoSaveBtn');
        if(manualSaveBtn) {
            manualSaveBtn.addEventListener('click', () => {
                this.autoSave();
                if(window.Utils) Utils.ui.showStatus('임시 저장되었습니다.');
            });
        }
    }

    setupBookSearch(input, type = 'english') {
        const listId = type === 'english' ? 'bookSuggestions' : 'korBookSuggestions';
        const suggestionsList = document.getElementById(listId);

        if (!suggestionsList) return;

        input.addEventListener('input', () => {
            const query = input.value.trim();
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
        
        // [모바일 수정] blur 지연 시간을 조금 더 늘려 터치 이벤트 확보
        input.addEventListener('blur', () => setTimeout(() => this.hideSuggestions(suggestionsList), 300));
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

        // [모바일 수정] mousedown 뿐만 아니라 touchstart도 지원하여 모바일 터치 인식
        list.querySelectorAll('.autocomplete-suggestion').forEach(item => {
            const selectHandler = (e) => {
                e.preventDefault(); // blur 이벤트 발생 방지
                this.selectBook(parseInt(item.dataset.index), type);
            };
            
            item.addEventListener('mousedown', selectHandler);
            item.addEventListener('touchstart', selectHandler); // 모바일용
        });
    }

    selectBook(index, type = 'english') {
        const book = this.currentBooks[index];
        if (!book) return;

        const list = type === 'english' ? this.selectedBooks.english : this.selectedBooks.korean;
        if (!list.some(b => b.id === book.id)) {
            list.push({ id: book.id, title: book.title, ar: book.ar, lexile: book.lexile });
        } else {
            if(window.Utils) Utils.ui.showStatus('이미 추가된 책입니다.', false);
        }

        this.renderSelectedBooks(type);

        const titleId = type === 'english' ? 'englishBookTitle' : 'koreanBookTitle';
        const idId = type === 'english' ? 'englishBookId' : 'koreanBookId';
        document.getElementById(titleId).value = ''; 
        const idElem = document.getElementById(idId);
        if(idElem) idElem.value = book.id; 

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
        if(window.CONFIG && window.Utils) Utils.storage.save(CONFIG.STORAGE_KEYS.PLANNER_DATA, data);
        const status = document.getElementById('autoSaveStatus');
        if(status) status.textContent = '임시 저장됨 ' + new Date().toLocaleTimeString();
    }

    loadSavedData() {
        if(!window.CONFIG || !window.Utils) return;
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
        
        data.englishBooks = this.selectedBooks.english;
        data.koreanBooks = this.selectedBooks.korean;

        if (data['오늘 읽은 영어 책'] && !data['오늘 읽은 영어 책 ID']) delete data['오늘 읽은 영어 책'];
        if (data['오늘 읽은 한국 책'] && !data['오늘 읽은 한국 책 ID']) delete data['오늘 읽은 한국 책'];

        if(window.Utils) Utils.ui.showLoading('저장 중...');
        
        try {
            const response = await fetch('/save-progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.api.token}` },
                body: JSON.stringify(data)
            });
            
            const result = await response.json();
            
            if(window.Utils) Utils.ui.hideLoading();
            
            if(result.success || response.ok) {
                if(window.Utils) Utils.ui.showStatus('저장 완료!', true);
                if(window.CONFIG && window.Utils) Utils.storage.remove(CONFIG.STORAGE_KEYS.PLANNER_DATA);
                document.getElementById('autoSaveStatus').textContent = '정식 저장 완료';
            } else {
                throw new Error(result.message || '저장 실패');
            }
        } catch (error) {
            if(window.Utils) {
                Utils.ui.hideLoading();
                Utils.ui.showStatus('저장 실패: ' + error.message, false);
            }
            console.error('저장 중 에러:', error);
        }
    }

    async logout() {
        if(window.Utils && await Utils.ui.confirm('로그아웃 하시겠습니까?')) {
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