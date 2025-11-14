/**
 * Readitude API 모듈
 * 서버와의 모든 통신을 담당합니다.
 */

class ReaditudeAPI {
    constructor() {
        this.baseURL = CONFIG.API_BASE_URL;
        this.token = null;
        this.loadToken();
    }

    /**
     * 토큰 로드
     */
    loadToken() {
        this.token = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
    }

    /**
     * 토큰 저장
     */
    setToken(token) {
        this.token = token;
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN, token);
    }

    /**
     * 토큰 제거
     */
    clearToken() {
        this.token = null;
        localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_TOKEN);
    }

    /**
     * API 요청 헬퍼
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        
        const headers = {
            ...options.headers
        };

        // GET 요청이 아닌 경우에만 Content-Type 추가
        if (options.method && options.method !== 'GET') {
            headers['Content-Type'] = 'application/json';
        }

        // 인증이 필요한 경우 토큰 추가
        if (this.token && !options.skipAuth) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        try {
            const fetchOptions = {
                method: options.method || 'GET',
                headers
            };

            // body는 GET 요청이 아닐 때만 추가
            if (options.body) {
                fetchOptions.body = options.body;
            }

            const response = await fetch(url, fetchOptions);

            // 인증 오류 처리
            if (response.status === 401) {
                this.clearToken();
                window.location.href = '/';
                throw new Error(CONFIG.MESSAGES.AUTH_EXPIRED);
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || `API Error: ${response.status}`);
            }

            return data;
        } catch (error) {
            console.error(`API Request Failed: ${endpoint}`, error);
            throw error;
        }
    }

    /**
     * 학생 로그인
     */
    async studentLogin(studentId, password) {
        const response = await this.request('/login', {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({
                studentId: studentId,
                studentPassword: password
            })
        });

        if (response.success && response.token) {
            this.setToken(response.token);
        }

        return response;
    }

    /**
     * 선생님 로그인
     */
    async teacherLogin(teacherId, password) {
        const response = await this.request('/teacher-login', {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({
                teacherId: teacherId,
                teacherPassword: password
            })
        });

        if (response.success && response.token) {
            this.setToken(response.token);
        }

        return response;
    }

    /**
     * 사용자 정보 가져오기
     */
    async getUserInfo() {
        return await this.request('/api/user-info');
    }

    /**
     * 학생 정보 가져오기
     */
    async getStudentInfo() {
        return await this.request('/api/student-info');
    }

    /**
     * 선생님 정보 가져오기
     */
    async getTeacherInfo() {
        return await this.request('/api/teacher/user-info');
    }

    /**
     * 진도 저장 (학생 플래너)
     */
    async saveProgress(formData) {
        return await this.request('/save-progress', {
            method: 'POST',
            body: JSON.stringify(formData)
        });
    }

    /**
     * 영어책 검색
     */
    async searchEnglishBooks(query) {
        return await this.request(`/api/search-books?query=${encodeURIComponent(query)}`);
    }

    /**
     * 한국책 검색
     */
    async searchKoreanBooks(query) {
        return await this.request(`/api/search-sayu-books?query=${encodeURIComponent(query)}`);
    }

    /**
     * 일일 리포트 데이터 가져오기
     */
    async getDailyReportData(date) {
        return await this.request(`/api/daily-report-data?date=${date}`);
    }

    /**
     * 숙제 업데이트 (선생님용)
     */
    async updateHomework(pageId, propertyName, newValue, propertyType) {
        return await this.request('/api/update-homework', {
            method: 'POST',
            body: JSON.stringify({
                pageId,
                propertyName,
                newValue,
                propertyType
            })
        });
    }

    /**
     * 선생님 목록 가져오기
     */
    async getTeachers() {
        return await this.request('/api/teachers');
    }

    /**
     * 학생별 진도 데이터 가져오기
     */
    async getStudentProgress(studentId, startDate, endDate) {
        const params = new URLSearchParams({
            studentId,
            startDate,
            endDate
        });
        return await this.request(`/api/student-progress?${params}`);
    }

    /**
     * 월간 리포트 데이터 가져오기
     */
    async getMonthlyReport(studentId, month) {
        const params = new URLSearchParams({
            studentId,
            month
        });
        return await this.request(`/api/monthly-report-data?${params}`);
    }

    /**
     * 로그아웃
     */
    logout() {
        this.clearToken();
        localStorage.removeItem(CONFIG.STORAGE_KEYS.USER_ID);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.USER_NAME);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.PLANNER_DATA);
    }
}

// 전역 API 인스턴스 생성
window.API = new ReaditudeAPI();