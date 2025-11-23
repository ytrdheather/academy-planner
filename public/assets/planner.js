/**
 * Readitude 학생 스터디 플래너 모듈 (다중 책 + AR/Lexile 지원)
 * 위치: public/assets/planner.js
 */

class StudyPlanner {
    constructor() {
        this.api = window.API;
        this.autoSaveInterval = null;
        this.currentBooks = []; // 검색된 책 목록 (임시)
        this.searchTimeout = null;
        this.studentInfo = null;

        // [신규] 선택된 책 목록 관리 (배열)
        // 구조: { id, title, ar, lexile, author }
        this.selectedBooks = {
            english: [], 
            korean: []
        };
    }

    async initialize() {
        try {
            // 인증 확인
            if (!this.api.token) {
                window.location.href = '/';
                return;
            }

            // 학생 정보 로드
            await this.loadStudentInfo();

            // UI 초기화 (날짜 등)
            this.initializeUI();

            // [중요] 오늘 서버에 저장된 데이터 불러오기 (이게 가장 정확함)
            await this.loadTodayData();

            // 이벤트 리스너 설정
            this.attachEventListeners();

            // 책 검색 기능 초기화
            const engBookInput = document.getElementById('englishBookTitle');
            const korBookInput = document.getElementById('koreanBookTitle');
            if (engBookInput) this.setupBookSearch(engBookInput, 'english');
            if (korBookInput) this.setupBookSearch(korBookInput, 'korean');

            // 자동 저장 시작
            this.startAutoSave();

        } catch (error) {
            console.error('Init Error:', error);
            Utils.ui.showStatus('오류 발생: 초기화 실패', false);
        }
    }

    async loadStudentInfo() {
        try {
            this.studentInfo = await this.api.getStudentInfo();
            const nameEl = document.getElementById('studentName');
            if (nameEl) {
                nameEl.textContent = `${this.studentInfo.studentName}(이)의`;
            }
        } catch (e) { 
            console.error('학생 정보 로드 실패:', e);
        }
    }

    // 오늘 데이터 불러오기
    async loadTodayData() {
        try {
            const response = await fetch('/api/get-today-progress', {
                headers: { 'Authorization': `Bearer ${this.api.token}` }
            });
            const data = await response.json();
            
            if (data.success && data.progress) {
                // 1. 일반 폼 데이터 채우기
                this.fillFormWithData(data.progress);
                
                // 2. [신규] 저장된 책 데이터(배열) 복원
                if (data.progress.englishBooks) {
                    this.selectedBooks.english = data.progress.englishBooks;
                    this.renderSelectedBooks('english');
                }
                if (data.progress.koreanBooks) {
                    this.selectedBooks.korean = data.progress.koreanBooks;
                    this.renderSelectedBooks('korean');
                }
                
                // 상태 표시
                const statusElement = document.getElementById('autoSaveStatus');
                if (statusElement) statusElement.textContent = '불러오기 완료';
            }
        } catch (error) { 
            console.log('데이터 로드 중 오류 (신규 작성일 수 있음):', error); 
        }
    }

    fillFormWithData(progress) {
        // Notion DB 속성명 -> HTML name 매핑
        const nameMap = {
            '단어(맞은 개수)': '단어 (맞은 개수)', 
            '단어(전체 개수)': '단어 (전체 개수)',
            '문법(전체 개수)': '문법 (전체 개수)', 
            '문법(틀린 개수)': '문법 (틀린 개수)', 
            '독해(틀린 개수)': '독해 (틀린 개수)',
            '📕 책 읽는 거인': '📕 책 읽는 거인'
        };

        for (const key in progress) {
            // 책 배열은 별도 처리하므로 건너뜀
            if (key === 'englishBooks' || key === 'koreanBooks') continue;

            const htmlName = nameMap[key] || key;
            const element = document.querySelector(`[name="${htmlName}"]`);
            if (element) {
                element.value = progress[key];
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
            // 저장 버튼 (submit)
            form.addEventListener('submit', (e) => this.handleSubmit(e));
            
            // 입력 변경 시 자동 저장 (디바운스 적용)
            form.addEventListener('change', () => this.autoSave());
            form.addEventListener('input', Utils.debounce(() => this.autoSave(), 1000));
        }

        const logoutBtn = document.querySelector('.logout-button');
        if(logoutBtn) {
            logoutBtn.addEventListener('click', () => this.logout());
        }
        
        // 임시 저장 버튼 (수동)
        const manualSaveBtn = document.getElementById('autoSaveBtn');
        if(manualSaveBtn) {
            manualSaveBtn.addEventListener('click', () => {
                this.autoSave();
                Utils.ui.showStatus('임시 저장되었습니다.');
            });
        }
    }

    setupBookSearch(input, type) {
        const listId = type === 'english' ? 'bookSuggestions' : 'korBookSuggestions';
        const suggestionsList = document.getElementById(listId);

        if (!suggestionsList) return;

        input.addEventListener('input', () => {
            const query = input.value.trim();
            
            // 입력 시 기존 선택 ID 초기화 (새로 검색하는 것이므로)
            const idInput = document.getElementById(type === 'english' ? 'englishBookId' : 'koreanBookId');
            if(idInput) idInput.value = '';

            clearTimeout(this.searchTimeout);
            
            if (query.length < 2) {
                this.hideSuggestions(suggestionsList);
                return;
            }

            this.showLoadingState(suggestionsList);
            this.searchTimeout = setTimeout(() => this.searchBooks(query, type, suggestionsList), 500);
        });
        
        // 포커스 잃으면 목록 숨김 (클릭 시간 확보)
        input.addEventListener('blur', () => setTimeout(() => this.hideSuggestions(suggestionsList), 200));
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
            
            const res = await fetch(endpoint, { 
                headers: { 'Authorization': `Bearer ${this.api.token}` } 
            });
            
            if (!res.ok) throw new Error('검색 실패');

            const books = await res.json();
            this.currentBooks = books; // 검색 결과 저장
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
            // 영어책은 AR/Lexile 표시
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

        // 클릭 이벤트
        list.querySelectorAll('.autocomplete-suggestion').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.selectBook(parseInt(item.dataset.index), type);
            });
        });
    }

    selectBook(index, type) {
        const book = this.currentBooks[index];
        if (!book) return;

        const list = type === 'english' ? this.selectedBooks.english : this.selectedBooks.korean;
        
        // 중복 체크
        if (list.some(b => b.id === book.id)) {
            Utils.ui.showStatus('이미 추가된 책입니다.', false);
            return;
        }

        // 목록에 추가
        list.push({ 
            id: book.id, 
            title: book.title,
            ar: book.ar,
            lexile: book.lexile
        });
        
        this.renderSelectedBooks(type);
        
        // 입력창 초기화
        const inputId = type === 'english' ? 'englishBookTitle' : 'koreanBookTitle';
        document.getElementById(inputId).value = '';
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
            // 태그에 점수 표시
            if (type === 'english' && (book.ar || book.lexile)) {
                const arStr = book.ar ? `AR ${book.ar}` : '';
                const lexStr = book.lexile ? `Lex ${book.lexile}` : '';
                const info = [arStr, lexStr].filter(Boolean).join('/');
                badgeText += ` <span style="font-weight:normal; opacity:0.8; font-size:0.9em;">(${info})</span>`;
            }

            return `
            <div class="book-tag">
                <span>${badgeText}</span>
                <span class="remove-btn" onclick="window.plannerInstance.removeBook('${type}', ${idx})">×</span>
            </div>
            `;
        }).join('');
    }

    removeBook(type, index) {
        const list = type === 'english' ? this.selectedBooks.english : this.selectedBooks.korean;
        list.splice(index, 1); // 배열에서 삭제
        this.renderSelectedBooks(type); // 다시 그리기
        this.autoSave();
    }

    hideSuggestions(list) { if(list) list.style.display = 'none'; }

    autoSave() {
        const status = document.getElementById('autoSaveStatus');
        if(status) status.textContent = '작성 중...';
        
        // (선택 사항) 로컬 스토리지 저장 로직을 원하시면 여기에 추가 가능
        // 현재는 복잡성 방지를 위해 UI 상태만 업데이트
    }

    startAutoSave() { 
        this.autoSaveInterval = setInterval(() => {
            // 주기적으로 자동 저장 (필요시 구현)
            // this.handleSubmit(new Event('submit')); // 자동 제출은 위험하므로 생략
        }, 30000);
    }

    async handleSubmit(event) {
        if (event) event.preventDefault();
        
        const formData = new FormData(document.getElementById('plannerForm'));
        const data = Object.fromEntries(formData);
        
        // [핵심] 책 배열 데이터 추가
        data.englishBooks = this.selectedBooks.english;
        data.koreanBooks = this.selectedBooks.korean;

        // 직접 타이핑한 책 제목 처리 (ID 없는 경우)
        // 현재 로직은 검색된 책만 허용하지만, 필요시 예외 처리 가능

        Utils.ui.showLoading('저장 중...');
        try {
            const response = await fetch('/save-progress', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${this.api.token}` 
                },
                body: JSON.stringify(data)
            });
            const result = await response.json();
            
            Utils.ui.hideLoading();
            if(result.success) {
                Utils.ui.showStatus('저장 완료!', true);
                const status = document.getElementById('autoSaveStatus');
                if(status) status.textContent = '저장됨';
            } else {
                throw new Error(result.message);
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

// 전역 인스턴스 (HTML에서 접근용)
window.StudyPlanner = StudyPlanner;
// DOM 로드 시 자동 실행
document.addEventListener('DOMContentLoaded', () => {
    // 전역 변수에 할당하여 onclick 이벤트 등에서 접근 가능하게 함
    window.plannerInstance = new StudyPlanner();
    window.plannerInstance.initialize();
});