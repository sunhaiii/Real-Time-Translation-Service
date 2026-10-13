# 실시간 통역 서비스 (Real-time Translation Service)

은행 상담 상황을 위한 실시간 통역 시스템입니다.  
프론트엔드(Next.js)와 백엔드(FastAPI + WebSocket)로 구성됩니다.

## 구성

- `frontend`: 사용자 UI, 음성 캡처, WebSocket/REST 통신
- `backend`: STT/번역/TTS 처리, 채팅 저장(SQLite), WebSocket 브로드캐스트

## 기술 스택

- Frontend: Next.js 14, React 18, TypeScript, Tailwind CSS
- Backend: FastAPI, WebSocket, Python
- Translation: Google Gemini (`services/translator.py`)
- STT/TTS: Google Cloud Speech-to-Text / Text-to-Speech
- DB: SQLite (`qstt.db`)
- Container: Docker / docker-compose

## 파이프라인

### 텍스트 번역 파이프라인

```text
사용자 입력(text)
  -> Frontend(WebSocket `text`)
  -> Backend(main.py)
  -> TranslatorService(Gemini 번역)
  -> WebSocket `translation_complete` 응답
  -> Frontend 화면 반영
  -> (옵션) TTSService 합성 후 `tts_audio` 전송/재생
```

### 음성 스트리밍 파이프라인

```text
마이크 입력
  -> AudioWorklet(pcm-capture-processor.js, 16k PCM 프레임)
  -> Frontend(WebSocket `audio_stream` 청크 전송)
  -> STTService(스트리밍 STT)
  -> WebSocket `transcription`(interim/final)
  -> final 문장 누적 후 TranslatorService 번역
  -> WebSocket `translation_completed` / `translation_complete`
  -> (옵션) TTSService 합성 후 `tts_audio` 전송/재생
```

## 로컬 실행

### 1) 백엔드 실행

```bash
cd app_root/backend
python -m venv venv
# Windows
.\venv\Scripts\Activate.ps1
# Linux/Mac
# source venv/bin/activate

pip install -r requirements.txt
python main.py
```

백엔드:
- `http://localhost:8001`
- `http://localhost:8001/docs`

### 2) 프론트엔드 실행

```bash
cd app_root/frontend
npm install
npm run dev
```

프론트엔드:
- `http://localhost:3000`

### Windows 통합 런처 (정적 빌드 + 백엔드 + Chrome)

저장소 기준으로 `app_root`에서 백엔드 폴더와 정적 `out`을 한 번에 쓰려면:

```bash
cd app_root/frontend
npm install
npm run build
npm run launch:win
```

단일 `exe`는 `frontend`에서 `npm run pkg:win`으로 빌드한 뒤, `app_root/dist/qstt.exe`와 함께 **`out/`**·**`backend/`**를 같은 디렉터리에 두고 실행합니다. 자세한 트리와 선행 조건은 [Frontend README](./frontend/README.md)의 «Windows exe 배포»를 참고하세요.

## 환경 변수

### backend/.env

```env
GOOGLE_API_KEY=your_google_api_key
GEMINI_MODEL_TEXT=gemini-2.5-flash-lite
HOST=0.0.0.0
PORT=8001
GCP_STT_DEFAULT_LANG=ko-KR
GCP_TTS_VOICE_NAME=
GCP_TTS_GENDER=NEUTRAL
```

Google Cloud STT/TTS를 쓸 경우 인증도 필요합니다.
- 예: `GOOGLE_APPLICATION_CREDENTIALS=./credentials.json`

### frontend/.env.local (선택)

```env
NEXT_PUBLIC_WS_URL=ws://localhost:8001
```

미설정 시 프론트는 현재 호스트 기준으로 WebSocket URL을 생성합니다.

## Docker 실행

프로젝트 루트(`docker-compose.yml` 위치)에서 실행:

```bash
docker-compose up --build
```

접속:
- Frontend: `http://localhost:3000`
- Backend API Docs: `http://localhost:8001/docs`

중지:

```bash
docker-compose down
```

로그:

```bash
docker-compose logs -f
```

## 디렉터리 구조

```text
app_root/
├─ backend/
│  ├─ main.py
│  ├─ requirements.txt
│  ├─ qstt.db
│  └─ services/
│     ├─ database.py
│     ├─ stt.py
│     ├─ translator.py
│     └─ tts.py
├─ frontend/
│  ├─ public/worklets/pcm-capture-processor.js
│  └─ src/
│     ├─ app/
│     ├─ components/
│     └─ lib/
└─ README.md
```

## 주요 기능

- 상담원/고객 역할 분리
- 세션 기반 실시간 번역(WebSocket)
- 텍스트 번역 + 음성 인식/합성
- 스트리밍 오디오(`audio_stream`) 기반 실시간 자막
- 채팅방/메시지 저장 및 조회

## 참고 문서

- [Backend README](./backend/README.md)
- [Frontend README](./frontend/README.md)
- [Frontend Migration Guide](./frontend/MIGRATION.md)

## 보안 주의

다음 파일은 저장소에 커밋하지 마세요.

- `.env`, `.env.local`
- `credentials.json`
- `venv/`, `node_modules/`, `.next/`
- API 키/인증 정보가 포함된 파일
