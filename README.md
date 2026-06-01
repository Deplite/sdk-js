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

---

더 자세한 내용은 [Deplite 가이드](https://docs.deplite.io/guide)를 참고해주세요.

## 라이선스

[Apache-2.0. LICENSE](LICENSE)
