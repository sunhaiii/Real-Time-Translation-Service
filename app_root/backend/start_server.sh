#!/bin/bash
# 백엔드 서버 시작 스크립트 (Linux/Mac)

# 스크립트 디렉토리로 이동
cd "$(dirname "$0")"

# 가상환경 활성화
if [ ! -d "venv" ]; then
    echo "❌ 가상환경을 찾을 수 없습니다. 먼저 'python -m venv venv'로 생성하세요."
    exit 1
fi

source venv/bin/activate

# .env 파일 확인
if [ ! -f ".env" ]; then
    echo "⚠️  .env 파일이 없습니다. GOOGLE_API_KEY를 설정하세요."
    echo "예: echo 'GOOGLE_API_KEY=your_key_here' > .env"
fi

echo "🚀 Starting FastAPI server with WebSocket support..."
uvicorn main:app --host 0.0.0.0 --port 8001 --reload --log-level info
