# Backend - 실시간 통역 서비스

FastAPI + WebSocket 기반 백엔드 서버입니다.  
텍스트 번역(Gemini), 음성 인식(STT), 음성 합성(TTS), 채팅 저장(SQLite)을 제공합니다.

## 빠른 실행

### Windows
```bash
.\start_server.bat
```

### Linux/Mac
```bash
chmod +x start_server.sh
./start_server.sh
```

서버 기본 주소:
- `http://0.0.0.0:8001`
- API 문서: `http://0.0.0.0:8001/docs`

## 설치

### 1) 가상환경 생성
```bash
python -m venv venv
```

### 2) 가상환경 활성화
Windows PowerShell:
```powershell
.\venv\Scripts\Activate.ps1
```

Windows CMD:
```cmd
venv\Scripts\activate.bat
```

Linux/Mac:
```bash
source venv/bin/activate
```

### 3) 의존성 설치
```bash
pip install -r requirements.txt
```

## 환경 변수 (.env)

`.env` 파일 예시:

```env
# Gemini 번역 필수
GOOGLE_API_KEY=your_google_api_key

# 선택
GEMINI_MODEL_TEXT=gemini-2.5-flash-lite
HOST=0.0.0.0
PORT=8001
GCP_STT_DEFAULT_LANG=ko-KR
GCP_TTS_VOICE_NAME=
GCP_TTS_GENDER=NEUTRAL
```

Google Cloud STT/TTS를 사용하려면 서비스 계정 인증도 필요합니다.
- 예: `GOOGLE_APPLICATION_CREDENTIALS=./credentials.json`

## Windows 단일 파일 빌드 (PyInstaller → `backend.exe`)

Python 소스·가상환경 없이 백엔드만 실행하려면 `backend.exe` 한 개로 묶을 수 있습니다.  
프론트의 `qstt.exe` 런처(`launch-windows-stack.js`)는 **`backend/backend.exe`가 있으면 자동으로 이것을 우선 실행**합니다 (`main.py`·`venv` 불필요).

### 빌드 절차

1. **가급적 깨끗한 가상환경에서 빌드**하세요. 전역 Python에 Jupyter·numpy 등이 있으면 exe에 불필요한 라이브러리가 같이 들어가 용량이 커집니다.

   ```powershell
   cd app_root\backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   pip install -r requirements-build.txt
   ```

2. **단일 exe 생성**

   ```powershell
   python -m PyInstaller pyinstaller.spec
   ```

3. 산출물: **`dist\backend.exe`**

### 배포 시 폴더 구성

`backend.exe`와 **같은 폴더**에 다음을 둡니다.

- **`.env`** — `GOOGLE_API_KEY` 등 (PyInstaller 빌드 시 `.env`는 exe에 포함되지 않음)
- **`credentials.json`** 등 — `.env`의 `GOOGLE_APPLICATION_CREDENTIALS`가 상대경로면 이 폴더 기준으로 배치

**`qstt.db`**(SQLite)는 실행 시 **exe가 있는 폴더**에 자동 생성됩니다.

### 참고

- 첫 실행 시 onefile exe는 내부 압축 해제로 **시동이 다소 느릴 수** 있습니다.
- 런타임에 모듈이 빠졌다는 오류가 나면 `pyinstaller.spec`의 `hiddenimports`에 항목을 추가한 뒤 다시 빌드하세요.

## 실행 방법

### 권장: 배치/스크립트 실행
```bash
.\start_server.bat
```

### 직접 실행
```bash
python main.py
```

### uvicorn 실행
```bash
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

## API 개요

### REST
- `GET /` 서버 상태
- `GET /health` 헬스체크
- `GET /api/languages` 지원 언어 목록
- `POST /api/translate` 텍스트 번역
- `GET /api/chats?session_id=...` 채팅 목록 조회
- `POST /api/chats` 채팅방 생성
- `GET /api/chats/{chat_id}/messages` 메시지 조회
- `POST /api/chats/{chat_id}/messages` 메시지 저장
- `DELETE /api/chats/{chat_id}` 채팅방 삭제

### WebSocket
- `WS /ws/{session_id}`
- `WS /ws/test` 테스트용 에코 엔드포인트

주요 수신 메시지 타입:
- `ping`
- `text`
- `audio` (단일 오디오 업로드)
- `audio_stream` (청크 스트리밍)
- `language_selected`
- `interim_text`
- `client_tts_set`

주요 송신 메시지 타입:
- `connected`
- `pong`
- `transcription`
- `translation_complete`
- `translation_completed` (스트리밍 번역 완료)
- `tts_audio`
- `chat_list_updated`
- `error`

## 서비스 모듈

### `services/translator.py`
- Gemini 기반 텍스트 번역
- 언어 코드 -> 프롬프트용 언어명 매핑

### `services/stt.py`
- Google Cloud Speech-to-Text
- 단일 인식 + 스트리밍 인식 지원
- 앱 언어 코드와 STT 로케일 코드 간 정규화(예: `zh-HK` -> `yue-Hant-HK`)

### `services/tts.py`
- Google Cloud Text-to-Speech
- 번역 결과를 MP3(base64)로 합성

### `services/database.py`
- SQLite 기반 채팅/메시지 저장

## 디렉터리 구조

```text
backend/
├─ main.py
├─ requirements.txt
├─ .env
├─ qstt.db
├─ start_server.bat
├─ start_server.ps1
├─ start_server.sh
└─ services/
   ├─ __init__.py
   ├─ database.py
   ├─ stt.py
   ├─ translator.py
   └─ tts.py
```

## 문제 해결

### 1) WebSocket 업그레이드 오류
증상:
```text
WARNING: Unsupported upgrade request.
```

조치:
- 가상환경 활성화 상태에서 실행
- `websockets` 설치 확인 (`pip install -r requirements.txt`)

### 2) PowerShell 실행 정책 오류
조치:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\venv\Scripts\Activate.ps1
```

### 3) 포트 충돌 (8001)
조치:
```bash
netstat -ano | findstr :8001
taskkill /PID <PID> /F
```

### 4) 번역/음성 API 초기화 실패
확인 항목:
- `.env`의 `GOOGLE_API_KEY`
- Google Cloud 인증(`GOOGLE_APPLICATION_CREDENTIALS`)
- `google-cloud-speech`, `google-cloud-texttospeech` 설치

## 보안 주의

커밋 금지:
- `.env`
- `credentials.json`
- `venv/`
- API 키가 포함된 파일

`.gitignore`에 민감 파일이 제외되어 있는지 확인하세요.
