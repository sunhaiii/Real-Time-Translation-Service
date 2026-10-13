# Docker Real-time Translation System Start Script

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  Docker Start - Real-time Translation" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# 1. .env check
Write-Host "1. Checking .env..." -ForegroundColor Yellow

if (-Not (Test-Path ".env")) {
    Write-Host "   [WARN] No .env in project root!" -ForegroundColor Red
    Write-Host "   Create .env and set GOOGLE_API_KEY." -ForegroundColor Red
    Write-Host ""
    Write-Host "   Example:" -ForegroundColor Green
    Write-Host "   GOOGLE_API_KEY=your_api_key_here" -ForegroundColor Gray
    Write-Host ""
    
    $create = Read-Host "   Create .env now? (y/n)"
    if ($create -eq "y") {
        $apiKey = Read-Host "   Enter Google API Key"
        "GOOGLE_API_KEY=$apiKey`nGEMINI_MODEL_TEXT=gemini-2.0-flash-exp" | Out-File -FilePath ".env" -Encoding utf8
        Write-Host "   .env created." -ForegroundColor Green
    } else {
        Write-Host "   Exit. Create .env first." -ForegroundColor Red
        exit 1
    }
}

if (-Not (Test-Path "app_root\backend\.env")) {
    Write-Host "   [WARN] No backend .env. Copying..." -ForegroundColor Red
    Copy-Item ".env" -Destination "app_root\backend\.env"
    Write-Host "   backend .env copied." -ForegroundColor Green
}

Write-Host "   .env OK" -ForegroundColor Green
Write-Host ""

# 2. Docker check
Write-Host "2. Checking Docker..." -ForegroundColor Yellow
try {
    $dockerVersion = docker --version 2>&1
    Write-Host "   $dockerVersion" -ForegroundColor Green
} catch {
    Write-Host "   [ERROR] Docker not installed!" -ForegroundColor Red
    Write-Host "   Install Docker Desktop: https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# 3. Docker Compose check
Write-Host "3. Checking Docker Compose..." -ForegroundColor Yellow
try {
    $composeVersion = docker-compose --version 2>&1
    Write-Host "   $composeVersion" -ForegroundColor Green
} catch {
    Write-Host "   [ERROR] Docker Compose not installed!" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 4. Existing containers
Write-Host "4. Checking existing containers..." -ForegroundColor Yellow
$existingContainers = docker-compose ps -q 2>&1

if ($existingContainers) {
    Write-Host "   Containers already running." -ForegroundColor Yellow
    $restart = Read-Host "   Restart? (y/n)"
    if ($restart -eq "y") {
        Write-Host "   Stopping containers..." -ForegroundColor Yellow
        docker-compose down
        Write-Host "   Stopped." -ForegroundColor Green
    }
}

Write-Host ""

# 5. Build and run
Write-Host "5. Building and starting Docker..." -ForegroundColor Yellow
Write-Host "   (First run may take 5-10 min)" -ForegroundColor Gray
Write-Host ""

docker-compose up --build -d

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "===========================================" -ForegroundColor Green
    Write-Host "  Docker started successfully!" -ForegroundColor Green
    Write-Host "===========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "URLs:" -ForegroundColor Cyan
    Write-Host "  Frontend:  http://localhost:3000" -ForegroundColor White
    Write-Host "  Backend:   http://localhost:8001" -ForegroundColor White
    Write-Host "  API Docs:  http://localhost:8001/docs" -ForegroundColor White
    Write-Host ""
    Write-Host "Logs:  docker-compose logs -f" -ForegroundColor Gray
    Write-Host "Stop:  docker-compose down" -ForegroundColor Gray
    Write-Host ""

    # Open counselor (normal) + client (incognito) in Chrome after server is ready
    $openBrowsersScript = Join-Path $PSScriptRoot "app_root\frontend\scripts\open-browsers.js"
    if (Test-Path $openBrowsersScript) {
        Write-Host "Waiting for frontend, then opening counselor + client windows..." -ForegroundColor Yellow
        try {
            $env:SKIP_SERVER_START = "1"
            node $openBrowsersScript
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Browser windows opened." -ForegroundColor Green
            }
        } catch {
            Write-Host "  [WARN] Could not open browsers. Open manually: http://localhost:3000" -ForegroundColor Yellow
        }
        Remove-Item Env:\SKIP_SERVER_START -ErrorAction SilentlyContinue
    }
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "[ERROR] Docker start failed" -ForegroundColor Red
    Write-Host "Check logs: docker-compose logs" -ForegroundColor Yellow
    Write-Host ""
}
