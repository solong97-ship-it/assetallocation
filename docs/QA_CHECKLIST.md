# UI QA 체크리스트

기준: 포트폴리오 투자 계산기(vite/react) 최신 코드

## 자동 검증 완료

- [x] 타입체크 통과 (`npm run typecheck`)
- [x] JSON 회귀 테스트 통과 (`npm run test`)
- [x] 프로덕션 빌드 통과 (`npm run build`)
- [x] JSON 로드 시 스키마/타입 보정 동작 확인
- [x] 잘못된 JSON 구조(배열 아님, item 없음) 차단 확인
- [x] 중복 포트폴리오 ID 자동 보정 확인

## 수동 UI 확인 항목 (로컬 브라우저)

- [ ] 탭 전환 시 요약/KPI/표가 즉시 반영되는지
- [ ] 원금/투자금 수정 시 주식수/검산 합계가 즉시 업데이트되는지
- [ ] 비중 합계가 100%가 아닐 때 경고 문구가 표시되는지
- [ ] `비중 100% 맞추기` 클릭 후 합계가 100%가 되는지
- [ ] `정수 매수 기준` 체크 시 주식수가 내림 처리되는지
- [ ] `JSON 저장` 후 파일이 정상 다운로드되는지
- [ ] `JSON 불러오기`에서 정상 파일은 반영되고 비정상 파일은 경고되는지
- [ ] `포트폴리오 복사/삭제`가 정상 동작하는지
- [ ] `웹 시세 갱신` 중 버튼 비활성화/상태문구가 정상인지
- [ ] 모바일 뷰(좁은 화면)에서 표 스크롤/레이아웃이 깨지지 않는지

## JSON 샘플 파일

- `tests/json-samples/valid-basic.json`
- `tests/json-samples/valid-dirty-duplicate-ids.json`
- `tests/json-samples/invalid-not-array.json`
- `tests/json-samples/invalid-empty-items.json`
