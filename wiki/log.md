# 작업 이력

append-only. 새 항목은 맨 아래에. 포맷은 `wiki/SCHEMA.md` 참조.

```bash
grep "^## \[" wiki/log.md | tail -10
```

---

## [2026-08-15] bootstrap | 위키 개설

Karpathy LLM-wiki 패턴으로 `wiki/` 층 신설. 목적은 세션마다 반복되는 코드 재탐색 비용 제거.

- 뼈대: `CLAUDE.md`(루트, 짧게), `wiki/SCHEMA.md`, `wiki/index.md`, `wiki/log.md`
- 언어 정책: 파일명·태그·식별자 영어, 본문 한국어 (하이브리드)
- 위치: repo `/wiki`, git 추적. 기존 `docs/` 5개 문서는 손대지 않고 raw source로 인용만
- `status: verified|inferred|stale` 로 페이지 신뢰도를 표시하기로 함

## [2026-08-15] ingest | 1차 33페이지 작성

`api/` 코드와 `docs/`, 메모리 17개를 원본으로 삼아 33페이지 작성.

| 디렉토리 | 개수 | 무엇 |
|---|---|---|
| `patterns/` | 9 | 공용 헬퍼 — `api/index.js` 상단을 직접 읽고 씀 |
| `entities/` | 8 | Notion DB 맵, 환경변수, 크론 13개, 라우트, 화면 28개, 외부 서비스, Solapi·KakaoWork 실측 |
| `systems/` | 9 | 교재비·결석·상담·숙제·데일리·문법·시험·월간·챗봇 동작 계약 |
| `decisions/` | 4 | Render 수동배포, Supabase 보류, Make 이전, 브랜드 |
| `pitfalls/` | 3 | 담임 롤업 사고, 발신번호 오타, 노션 지연 |

슬래시 커맨드 3종 신설: `/wiki-ingest` `/wiki-query` `/wiki-lint` (`.claude/commands/`).
`MEMORY.md` 머리에 "상세는 위키" 포인터 추가 + 항목마다 대응 위키 페이지 명시. **메모리 본문은 지우지 않았다** — 위키가 몇 번 검증될 때까지 원본으로 남겨 둔다.

## [2026-08-15] lint | 첫 검진 — 링크·index·source 전부 통과

| 항목 | 결과 |
|---|---|
| 페이지 수 | 33 |
| 끊긴 링크 | `progress-automation-design` 1건 — **index의 "미작성" 표에 등재됨(정상)** |
| 고아 페이지 | 없음 |
| index 누락 | 없음 |
| `source:` 라인 검증 | **30건 전수 확인, 전부 일치** (`api/index.js` 19건 + 모듈 11건) |
| `status: inferred` | 1건 — `systems/monthly-report` (`monthlyReportModule.js` 본문 미정독) |
| 모순 | 1건 발견·해소 → 아래 |
| 40줄 초과 | 6건 (표 위주라 허용, 다음 lint에서 재검토) |

**해소한 모순**: `memory/readiplan-brand.md`(2026-07-21)의 "푸시 시 Render auto-deploy 트리거"는 틀렸다. `memory/render-manual-deploy.md`(2026-08-07)가 최신이고 **자동 배포는 꺼져 있다.** 두 위키 페이지 양쪽에 경고를 박아 뒀다.

**정정**: 작업 중 크론 타임존을 잘못 적었다가 고쳤다 — **13개 크론 전부 `{ timezone: 'Asia/Seoul' }`을 갖고 있다.** 다만 크론 콜백 *안*의 맨 `new Date()`는 여전히 서버 시간이며, `monthlyReportModule.js:593`이 그 패턴을 쓴다.

### 다음에 팔 것

1. `api/monthlyReportModule.js` 정독 → `systems/monthly-report`를 `verified`로
2. `.env.example`이 심하게 낡음(Vercel·Replit 시절, 실사용 변수 대부분 누락) → `entities/env-vars` 기준으로 재작성
3. `patterns/` 미작성 후보 — 노션 페이지네이션(100건 상한 처리), `teacherDm` 카드 메시지 구조
4. `progress-automation-design` 페이지 (`docs/진도자동화-핸드오프.md` 기반)
