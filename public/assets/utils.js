/**
 * Readitude 유틸리티 함수 모음
 */

const Utils = {
    /**
     * 날짜 관련 유틸리티
     */
    date: {
        // 한국 시간 기준 현재 날짜
        getKoreanDate() {
            const now = new Date();
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            return new Date(utc + (9 * 3600000));
        },

        // 날짜를 'YYYY년 MM월 DD일' 형식으로 포맷
        formatDisplay(date) {
            if (!date) date = this.getKoreanDate();
            if (typeof date === 'string') date = new Date(date);
            
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            
            return `${year}년 ${month}월 ${day}일`;
        },

        // 날짜를 'YYYY-MM-DD' 형식으로 포맷 (API용)
        formatAPI(date) {
            if (!date) date = this.getKoreanDate();
            if (typeof date === 'string') date = new Date(date);
            
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            
            return `${year}-${month}-${day}`;
        },

        // 요일 가져오기
        getDayName(date) {
            if (!date) date = this.getKoreanDate();
            if (typeof date === 'string') date = new Date(date);
            
            const days = ['일', '월', '화', '수', '목', '금', '토'];
            return days[date.getDay()] + '요일';
        },

        // 오늘 날짜를 완전한 문자열로
        getTodayString() {
            const today = this.getKoreanDate();
            return `${this.formatDisplay(today)} ${this.getDayName(today)}`;
        }
    },

    /**
     * 로컬 스토리지 관련 유틸리티
     */
    storage: {
        // 데이터 저장
        save(key, data) {
            try {
                const jsonData = typeof data === 'string' ? data : JSON.stringify(data);
                localStorage.setItem(key, jsonData);
                return true;
            } catch (error) {
                console.error('Storage save error:', error);
                return false;
            }
        },

        // 데이터 로드
        load(key) {
            try {
                const data = localStorage.getItem(key);
                if (!data) return null;
                
                try {
                    return JSON.parse(data);
                } catch {
                    return data; // JSON이 아닌 경우 그대로 반환
                }
            } catch (error) {
                console.error('Storage load error:', error);
                return null;
            }
        },

        // 데이터 삭제
        remove(key) {
            localStorage.removeItem(key);
        },

        // 전체 클리어
        clear() {
            localStorage.clear();
        }
    },

    /**
     * UI 관련 유틸리티
     */
    ui: {
        // 상태 메시지 표시
        showStatus(message, isSuccess = true, duration = 3000) {
            // 기존 메시지 제거
            const existingStatus = document.querySelector('.status-message-popup');
            if (existingStatus) {
                existingStatus.remove();
            }

            // 새 메시지 생성
            const statusDiv = document.createElement('div');
            statusDiv.className = `status-message-popup ${isSuccess ? 'success' : 'error'}`;
            statusDiv.textContent = message;
            statusDiv.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 24px;
                background: ${isSuccess ? '#10b981' : '#ef4444'};
                color: white;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                z-index: 10000;
                animation: slideIn 0.3s ease;
                font-weight: 500;
            `;

            document.body.appendChild(statusDiv);

            // 자동 제거
            setTimeout(() => {
                statusDiv.style.animation = 'slideOut 0.3s ease';
                setTimeout(() => statusDiv.remove(), 300);
            }, duration);
        },

        // 로딩 표시
        showLoading(message = '로딩중...') {
            const existingLoading = document.getElementById('global-loading');
            if (existingLoading) return;

            const loadingDiv = document.createElement('div');
            loadingDiv.id = 'global-loading';
            loadingDiv.innerHTML = `
                <div style="
                    position: fixed;
                    inset: 0;
                    background: rgba(0,0,0,0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                ">
                    <div style="
                        background: white;
                        padding: 20px 30px;
                        border-radius: 12px;
                        display: flex;
                        align-items: center;
                        gap: 15px;
                        box-shadow: 0 10px 25px rgba(0,0,0,0.2);
                    ">
                        <div style="
                            width: 40px;
                            height: 40px;
                            border: 4px solid #e2e8f0;
                            border-top-color: #6b46c1;
                            border-radius: 50%;
                            animation: spin 1s linear infinite;
                        "></div>
                        <span style="color: #2d3748; font-weight: 500;">${message}</span>
                    </div>
                </div>
            `;

            document.body.appendChild(loadingDiv);

            // 스피너 애니메이션 추가
            if (!document.querySelector('#loading-spinner-style')) {
                const style = document.createElement('style');
                style.id = 'loading-spinner-style';
                style.textContent = `
                    @keyframes spin {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                    @keyframes slideIn {
                        from { transform: translateX(100%); opacity: 0; }
                        to { transform: translateX(0); opacity: 1; }
                    }
                    @keyframes slideOut {
                        from { transform: translateX(0); opacity: 1; }
                        to { transform: translateX(100%); opacity: 0; }
                    }
                `;
                document.head.appendChild(style);
            }
        },

        // 로딩 숨기기
        hideLoading() {
            const loadingDiv = document.getElementById('global-loading');
            if (loadingDiv) {
                loadingDiv.remove();
            }
        },

        // 확인 다이얼로그
        async confirm(message, title = '확인') {
            return new Promise((resolve) => {
                const modal = document.createElement('div');
                modal.style.cssText = `
                    position: fixed;
                    inset: 0;
                    background: rgba(0,0,0,0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                `;

                modal.innerHTML = `
                    <div style="
                        background: white;
                        padding: 25px;
                        border-radius: 12px;
                        max-width: 400px;
                        width: 90%;
                        box-shadow: 0 10px 25px rgba(0,0,0,0.2);
                    ">
                        <h3 style="
                            margin: 0 0 15px 0;
                            color: #2d3748;
                            font-size: 18px;
                        ">${title}</h3>
                        <p style="
                            margin: 0 0 25px 0;
                            color: #4a5568;
                            line-height: 1.5;
                        ">${message}</p>
                        <div style="
                            display: flex;
                            justify-content: flex-end;
                            gap: 10px;
                        ">
                            <button onclick="this.closest('div[style]').remove(); window.confirmResolve(false)" style="
                                padding: 8px 20px;
                                border: 1px solid #e2e8f0;
                                background: white;
                                color: #4a5568;
                                border-radius: 8px;
                                cursor: pointer;
                                font-weight: 500;
                            ">취소</button>
                            <button onclick="this.closest('div[style]').remove(); window.confirmResolve(true)" style="
                                padding: 8px 20px;
                                border: none;
                                background: #6b46c1;
                                color: white;
                                border-radius: 8px;
                                cursor: pointer;
                                font-weight: 500;
                            ">확인</button>
                        </div>
                    </div>
                `;

                window.confirmResolve = resolve;
                document.body.appendChild(modal);
            });
        }
    },

    /**
     * 디바운스 함수
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * 쓰로틀 함수
     */
    throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
};

// 전역으로 사용 가능하도록 설정
window.Utils = Utils;