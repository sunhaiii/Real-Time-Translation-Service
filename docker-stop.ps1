# Docker 실시간 통역 시스템 중지 스크립트

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  실시간 통역 시스템 Docker 중지" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Docker 컨테이너 중지 중..." -ForegroundColor Yellow
docker-compose down

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✓ Docker 컨테이너 중지 완료!" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "[오류] Docker 중지 실패" -ForegroundColor Red
    Write-Host ""
}
