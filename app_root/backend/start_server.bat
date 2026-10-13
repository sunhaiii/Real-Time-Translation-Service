REM Windows CMD(명령 프롬프트) 용 배치 파일

@echo off
REM 백엔드 서버 시작 스크립트
cd /d %~dp0
call venv\Scripts\activate.bat
echo Starting FastAPI server with WebSocket support...
uvicorn main:app --host 0.0.0.0 --port 8001 --reload --log-level info
