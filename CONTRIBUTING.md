# 기여 가이드

Deplite JavaScript SDK에 관심을 가져주셔서 감사합니다.

## 브랜치 전략

| 브랜치 | 용도 |
| --- | --- |
| `main` | 릴리스 브랜치 — 항상 배포 가능한 상태를 유지합니다 |
| `develop` | 통합 브랜치 — 일상 작업의 기본 대상입니다 |
| `feature/<주제>` | 기능 작업 — `develop`에서 분기합니다 |
| `hotfix/<주제>` | 긴급 수정 — `main`에서 분기합니다 |

- 모든 변경은 PR로만 병합해주세요 (squash merge).
- `feature/*`는 `develop`으로, `hotfix/*`는 `main`으로 PR을 열어주세요.
- 릴리스는 `develop` → `main` PR 병합 후 `vX.Y.Z` 태그로 진행됩니다.

## 빌드 및 테스트

Node.js 20 이상이 필요합니다.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

unit 테스트와 e2e 테스트(로컬 mock 서버 기반)가 모두 `npm test`에 포함되어 별도 환경 없이 실행됩니다.

## CI

모든 PR과 `main`/`develop` push에서 lint·typecheck·테스트·빌드가 자동으로 실행됩니다.

CI가 통과해야 병합할 수 있습니다.
