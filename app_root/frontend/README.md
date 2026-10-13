# Frontend - 실시간 통역 UI (Next.js)

실시간 통역 서비스의 프론트엔드 애플리케이션입니다.  
Next.js 14(App Router) 기반이며 WebSocket/REST로 백엔드와 통신합니다.

## 기술 스택

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- WebSocket (실시간 번역/음성 이벤트)
- AudioWorklet (`public/worklets/pcm-capture-processor.js`)

## 주요 기능

- 상담원/고객 역할 선택
- 세션 공유(URL 기반)
- 텍스트 실시간 번역
- 음성 스트리밍 전송(`audio_stream`) + 실시간 자막(`transcription`)
- 서버 TTS 재생(`tts_audio`) 및 브라우저 TTS 폴백
- 채팅방 목록/메시지 조회/저장(REST API 연동)
- 글자 크기 조절

## 실행 방법

```bash
npm install
npm run dev
```

브라우저:
- `http://localhost:3000`

정적보내기(`output: 'export'`) 후 `out/`이 생성됩니다.

프론트만 미리보기(백엔드 없음):

```bash
npm run build
npm start
```

Windows에서 백엔드(uvicorn :8001) + 정적 서버(:3000) + Chrome(상담자/고객)까지 한 번에:

```bash
npm run build
npm run launch:win
```

## Windows exe 배포

1. `npm run build`로 `frontend/out/` 생성.
2. `npm run pkg:win`으로 `app_root/dist/qstt.exe` 생성 (**CMD 창 없음** — GUI 서브시스템 + 백엔드 숨김). 디버깅용으로 콘솔이 필요하면 `npm run pkg:win:cui`.

   **사용 기한:** `qstt.exe`(pkg)만, 빌드 시점부터 기본 **30일**이 지나면 실행 시 안내 창만 띄우고 종료합니다. `QSTT_EXE_VALID_DAYS=90`으로 일수 변경. **테스트:** 빌드 전 `QSTT_EXE_VALID_MINUTES=10`이면 10분 후 만료(분이 설정되면 일수보다 우선). `npm run launch:win`은 만료 검사 없음.
3. 배포 폴더 예시(세 항목을 **같은 폴더**에 둠):

```text
Qstt/
  qstt.exe
  out/          ← frontend/out *안의 파일들* (index.html이 out 바로 아래 또는 out/out 아래)
  backend/      ← 아래 둘 중 하나
```

**`out` 폴더:** `Qstt/out/index.html` 이 있어야 합니다.

**백엔드 방식 (택일):**

- **Python 실행:** `backend`에 `main.py` + `.venv` 또는 `venv` + `.env` (기존 방식).
- **단일 exe:** `backend`에 **`backend.exe`** + `.env` (+ GCP용 `credentials.json` 등). `main.py`·venv 없이 동작. 빌드는 `app_root/backend`에서 `python -m PyInstaller pyinstaller.spec` (자세한 절차는 backend README).

**선행 조건:** Google Chrome 설치, `backend/.env`(예: `GOOGLE_API_KEY`). Python 방식일 때만 venv·의존성 필요. `pkg:win`으로 만든 `qstt.exe`는 **콘솔이 없으므로** 종료는 상담 화면 **시스템 종료** 버튼(Chrome·런처 정리) 또는 작업 관리자에서 프로세스 종료를 사용합니다.

**실행이 안 될 때**

- `Qstt/qstt-launcher.log` (pkg로 빌드한 exe만 기록) — 마지막 줄에 실패 원인 힌트.
- 포트 **8001·3000** 이 다른 프로그램에 잡혀 있으면 백엔드/정적 서버가 실패합니다. 작업 관리자에서 정리하거나 해당 앱을 종료하세요.
- Windows가 exe를 막는 경우: 파일 우클릭 → 속성 → **차단 해제** 후 다시 실행.
- 기본 `pkg:win`은 콘솔이 없어 오류가 안 보일 수 있습니다. `qstt-launcher.log`를 보거나 `npm run pkg:win:cui`로 콘솔 있는 exe를 빌드해 원인을 확인하세요.

## 환경 변수

`.env.local` 예시:

```env
# 선택: WebSocket 서버 기본값 오버라이드
# 미설정 시 현재 호스트 기준 ws(s)://{host}:8001/ws/{session_id}
NEXT_PUBLIC_WS_URL=ws://localhost:8001
```

참고:
- REST API는 현재 코드에서 항상 현재 호스트의 `:8001`로 호출합니다.
  - 예: `http(s)://{host}:8001/api/...`
- 개발 시 프론트(3000)와 백엔드(8001)를 함께 실행해야 정상 동작합니다.

## Docker

개발 이미지:
```bash
docker build -f Dockerfile.dev -t translation-frontend-dev .
docker run -p 3000:3000 translation-frontend-dev
```

프로덕션 이미지:
```bash
docker build -t translation-frontend .
docker run -p 3000:3000 translation-frontend
```

## 디렉터리 구조

```text
frontend/
├─ public/
│  └─ worklets/
│     └─ pcm-capture-processor.js
├─ src/
│  ├─ app/
│  │  ├─ globals.css
│  │  ├─ layout.tsx
│  │  └─ page.tsx
│  ├─ components/
│  │  ├─ CounselorScreen.tsx
│  │  ├─ ClientScreen.tsx
│  │  ├─ LanguageSelectScreen.tsx
│  │  ├─ ChatInput.tsx
│  │  ├─ ChatMessage.tsx
│  │  └─ ...
│  └─ lib/
│     ├─ websocket.ts
│     ├─ browserSTT.ts
│     └─ languageList.ts
├─ package.json
├─ Dockerfile
└─ Dockerfile.dev
```

## 통신 요약

클라이언트 -> 서버(WebSocket):
- `ping`
- `text`
- `audio`
- `audio_stream`
- `language_selected`
- `interim_text`
- `client_tts_set`

서버 -> 클라이언트(WebSocket):
- `connected`
- `pong`
- `transcription`
- `translation_complete`
- `translation_completed`
- `tts_audio`
- `chat_list_updated`
- `error`

## 브라우저/오디오 유의사항

- 마이크 권한이 필요합니다.
- 일부 브라우저는 사용자 상호작용 전 자동 오디오 재생을 차단할 수 있습니다.
- 음성 입력은 `AudioContext + AudioWorklet` 경로를 사용합니다.
- `pcm-capture-processor.js`는 16kHz PCM 청크를 생성해 스트리밍 전송에 사용됩니다.

## 문제 해결

### 1) 백엔드 연결 실패
- 백엔드가 `8001` 포트에서 실행 중인지 확인
- `NEXT_PUBLIC_WS_URL` 값 확인
- 브라우저 개발자 도구 Network 탭에서 WebSocket 핸드셰이크 확인

### 2) 마이크 입력/음성 전송 안 됨
- 브라우저 마이크 권한 허용
- HTTPS 또는 localhost 환경 확인
- 콘솔에서 `audio stream` 관련 에러 확인

### 3) 서버 TTS 재생 안 됨
- 사용자 클릭/키입력 후 재생되는지 확인(자동재생 정책)
- 백엔드의 `tts_audio` 메시지 수신 여부 확인
