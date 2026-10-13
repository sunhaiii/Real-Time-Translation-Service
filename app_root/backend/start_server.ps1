# Windows PowerShell 용 스크립트

# PowerShell 백엔드 서버 시작 스크립트
$ErrorActionPreference = "Stop"

Write-Host "Starting FastAPI server with WebSocket support..." -ForegroundColor Green

# 가상환경 활성화
& ".\venv\Scripts\Activate.ps1"

# uvicorn 실행
uvicorn main:app --host 0.0.0.0 --port 8001 --reload --log-level info
