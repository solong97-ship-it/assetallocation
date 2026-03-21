# 포트폴리오 투자 계산기

엑셀 5개 시트 구조를 React + TypeScript + Tailwind 기반 웹앱으로 옮긴 프로젝트입니다.

## 기술 스택

- React 18
- TypeScript
- Vite
- Tailwind CSS

## 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속.

## 빌드

```bash
npm run build
npm run preview
```

## 테스트

```bash
npm run test
```

JSON 샘플: `tests/json-samples/`  
QA 체크리스트: `docs/QA_CHECKLIST.md`

## 주요 기능

- 5개 포트폴리오 탭
  - A형_K_연금저축
  - B형_K_IRP
  - C형_DRC성장
  - D형_DRC은퇴
  - E형_DRC배당
- 투자금/원금, 현재가격, 비중, 배당률 수정 즉시 재계산
- 기본 투자금 3억원 기준(모든 기본 포트폴리오)
- 자동 계산
  - 주식수
  - 검산 금액
  - 비중 합계
  - 안전자산 비중(category 기반)
  - 월배당(만원)
- 검증
  - 비중 합계 100% 경고
  - 현재가격 0 이하 에러 표시
  - 숫자 입력만 허용
  - 검산 합계와 원금 차이 표시
- 부가 기능
  - 실시간 시세 갱신(네이버 API + 프록시 체인 + HTML 폴백)
  - 1년 시계열 기반 KPI(CAGR/MDD/Sharpe) 자동 갱신
  - 10분 주기 + 탭 복귀(focus/visibility) 자동 재조회
  - JSON 저장/불러오기
  - 비중 100% 맞추기
  - 포트폴리오 복사
  - 사용자 정의 포트폴리오 추가/삭제
  - 정수 매수 기준 토글
  - 엔터키로 다음 입력 셀 이동
  - 안전/위험 비중 도넛차트
  - KPI 툴팁

## 폴더 구조

```text
src/
  components/
    AllocationDonut.tsx
    CustomPortfolioForm.tsx
    KpiCards.tsx
    PortfolioSummary.tsx
    PortfolioTable.tsx
    PortfolioTabs.tsx
  data/
    portfolios.ts
  types/
    portfolio.ts
  utils/
    calculations.ts
    formatters.ts
  App.tsx
  index.css
  main.tsx
```

## 계산 로직 유틸

- `calcShareCount(principal, weight, price, options)`
- `calcCheckAmount(price, quantity)`
- `calcWeightSum(items)`
- `calcSafeAssetWeight(items)`
- `calcMonthlyDividend(principal, annualDividendYield)`
- `formatCurrencyKRW(value)`
- `formatPercent(value)`
- `formatNumber(value)`

## 확장 포인트

- 백엔드 API 연결을 위한 데이터 계층 분리 가능 (`src/data`, `src/utils`)
- 사용자 정의 포트폴리오 추가 시 `Portfolio` 타입 재사용 가능
- 저장/불러오기 포맷을 서버 JSON 스키마로 확장 가능
