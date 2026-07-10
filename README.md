# Deplite SDK (TypeScript)

[Deplite](https://deplite.io)를 Node에서 호출하는 공식 SDK 입니다.<br/>
서버, CLI, Electron, CI 어디서나 동작합니다.

CBT 기간에는 GitHub 저장소에서 직접 가져옵니다.

```sh
npm install github:Deplite/sdk-js#v0.1.0
```

Node.js 20 이상.

## 어떤 모드를 써야 할까

| | External | Embedded |
| --- | --- | --- |
| 언제 쓰나 | 내 앱·CI·서버에서 Deplite를 **호출**할 때 | 내 앱·기기가 Deplite의 **작업 노드**가 될 때 |
| 인증 | API 토큰 | 1회용 설치 코드로 등록 후 Ed25519 서명 |
| 대표 예 | 트리거 발사, 파일 업로드/다운로드 | 키오스크, 무인 단말기, 디바이스 자동화 |

## 빠른 시작 (External)

```ts
import { Deplite } from '@deplite/sdk';

const deplite = new Deplite({ apiToken: process.env.DEPLITE_API_TOKEN! });

const job = await deplite.triggers.run({
  triggerId: '00000000-0000-0000-0000-000000000000',
  params: { ref: 'main' },
});

const uploaded = await deplite.files.upload({ file: { path: '/tmp/build.apk' } });
```

ESM과 CommonJS 모두 지원합니다.

## 무엇에 접근할 수 있는지 확인하기

기기 ID나 워크플로우 이름을 미리 알지 못해도, 토큰이 닿을 수 있는 범위를 SDK로 바로 조회할 수 있습니다.

```ts
const info = await deplite.token.info();
const agents = await deplite.agents.list();
const workflows = await deplite.workflows.list();
```

조회 결과는 언제나 토큰에 부여된 권한 범위로만 한정됩니다.

---

더 자세한 내용은 [Deplite 가이드](https://docs.deplite.io/guide)를 참고해주세요.

## 라이선스

[Apache-2.0](LICENSE) 라이선스로 제공됩니다.
