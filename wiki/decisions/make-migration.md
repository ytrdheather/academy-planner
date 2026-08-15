---
id: make-migration
title: Make를 버리고 서버 크론으로 이전한다
type: decision
status: verified
source: memory/make-migration.md (2026-08-06)
updated: 2026-08-15
tags: [make, cron, migration, cost]
---

## 결정

**목표는 Make 완전 해지.** 원칙: **새 기능은 새 유료 서비스 없이 기존 Render 서버 + 무료 Apps Script 안에서 흡수한다.** (Render $7 Starter·Claude·Google Cloud 구독은 유지 OK — 2026-07-21 비용 방침)

## 진행 상황

| 시나리오 | 상태 |
|---|---|
| 데일리 리포트 **생성** | ✅ 이전 완료 (2026-07-20, 10:20 크론). 등원 53명 relation ID까지 100% 일치 검증 |
| 교재비 알림톡 | ✅ 이전 완료. 실발송 검증까지 끝남 → [[textbook-fee]] |
| 결석·보강 신청 | ✅ 구글폼 → 자체 폼 `/absence` → [[absence-notice]] |
| **데일리 리포트 발송** | 🔴 **아직 Make.** 우리 코드에 발송 로직이 없다 → [[daily-report]] |
| 상담신청서 | 🔴 아직 Make (신입생은 Apps Script로 갈림 → [[counsel]]) |

## 계약

- 🔴 **Make 시나리오를 끄기 전에 우리 크론이 라이브에서 실제로 도는지 확인한다.** 하나라도 남으면 중복 생성·중복 알림이 난다.
- **한 번에 하나씩, Make는 마지막에 끈다.** 우리 크론이 멱등이라 병행이 안전하다.
- Make 무료 플랜은 **월 1,000 오퍼레이션 + 활성 시나리오 2개 제한**이다. 남은 시나리오가 2개를 넘으면 일부를 더 이전해야 무료로 내려갈 수 있다.

## 기각한 대안

**Slack 인터랙티브 버튼으로 원장 승인** — 2026-07-20에 확정했다가 폐기했다. 대신 **카카오워크 봇 DM + 링크 버튼**으로 갔다(학원이 이미 카카오워크를 쓰고 있어 Slack App을 새로 만들 이유가 없었다). 학생 명부 컬럼을 고치는 대신 **전용 DB를 신설**한 것도 같은 시점의 방향 전환이다 → [[textbook-fee]]

## 재검토 조건

데일리 리포트 발송까지 이전하면 Make는 상담신청서 하나만 남는다. 그것까지 Apps Script로 넘기면 해지 가능.

관련: [[daily-report]] · [[textbook-fee]] · [[absence-notice]] · [[counsel]] · [[cron-jobs]]
