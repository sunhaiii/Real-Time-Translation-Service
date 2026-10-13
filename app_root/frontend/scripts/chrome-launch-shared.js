/**
 * Shared: wait for localhost HTTP, find Chrome, open kiosk windows (Windows).
 */

const http = require('http')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const DEFAULT_FRONT_PORT = 3000

// ─── 모니터 배치 설정 ────────────────────────────────────────────────────────
// 현재 물리적 배치:
//   [1번 모니터 - 왼쪽] [2번 모니터 - 오른쪽·주 모니터]
//
// Windows 좌표계: 주 모니터(2번)가 원점(0,0)
//   2번 주 모니터 (오른쪽) : x = 0
//   1번 서브 모니터 (왼쪽) : x = -1920  ← 주 모니터 기준 왼쪽으로 1920px
//
// 역할 배치:
//   카운슬러(일반 프로필) → 2번 주 모니터  (x=0)
//   클라이언트(일반 프로필) → 1번 서브 모니터 (x=-1920)
//
// ※ 모니터 해상도나 배치가 다를 경우:
//   Windows → 설정 → 디스플레이 → 각 모니터 클릭 → 좌표 확인 후 아래 값 변경
// ─────────────────────────────────────────────────────────────────────────────
const COUNSELOR_WINDOW_POSITION = { x: 0,     y: 0 }  // 2번 주 모니터 (오른쪽)
const CLIENT_WINDOW_POSITION    = { x: -1920, y: 0 }  // 1번 서브 모니터 (왼쪽)

function waitForHttpPort(port, pathname = '/', maxAttempts = 180, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const retry = () => {
      attempts++
      if (attempts >= maxAttempts) {
        reject(new Error(`Server on port ${port} did not become ready in time`))
        return
      }
      setTimeout(tryOnce, intervalMs)
    }
    const tryOnce = () => {
      const req = http.get(
        { hostname: 'localhost', port, path: pathname },
        (res) => {
          res.resume()
          resolve()
        }
      )
      req.on('error', retry)
      req.setTimeout(5000, () => {
        req.destroy()
        retry()
      })
    }
    tryOnce()
  })
}

function getChromePath() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch (_) {}
  }
  return null
}

function ensureProfileDir(profileDir) {
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true })
  }
}

function resolveChromeProfileRoot(fallbackRoot = null) {
  const explicitRoot = process.env.QSTT_CHROME_PROFILE_ROOT
  if (explicitRoot) return explicitRoot
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'QSTT', '.chrome-profiles')
  }
  return fallbackRoot || path.join(process.cwd(), '.chrome-profiles')
}

function openChrome(chromePath, url, incognito = false, position = null, profileDir = null) {
  const args = []
  if (profileDir) {
    ensureProfileDir(profileDir)
    args.push(`--user-data-dir=${profileDir}`)
  }
  // 비로그인 로컬 프로필로 조용히 실행되도록 기본 안내/체크를 끈다.
  args.push('--no-first-run')
  args.push('--no-default-browser-check')
  if (position) {
    // window-position과 window-size를 함께 지정해야 kiosk 전 위치가 안정적으로 잡힘
    args.push(`--window-position=${position.x},${position.y}`)
    args.push(`--window-size=1920,1080`)
  }
  // 두 창 모두 미디어 권한을 자동 허용한다.
  args.push('--use-fake-ui-for-media-stream')
  args.push('--new-window')
  args.push('--kiosk', url)
  if (incognito) args.unshift('--incognito')
  spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref()
}

function buildSessionUrls(port, sessionId) {
  const base = `http://localhost:${port}`
  const q = (role) =>
    `${base}/?session=${encodeURIComponent(sessionId)}&role=${role}`
  return {
    base,
    counselorUrl: q('counselor'),
    clientUrl: q('client'),
  }
}

function getProfileDirs(profileRoot) {
  return {
    root: profileRoot,
    counselor: path.join(profileRoot, 'counselor'),
    client: path.join(profileRoot, 'client'),
  }
}

module.exports = {
  DEFAULT_FRONT_PORT,
  COUNSELOR_WINDOW_POSITION,
  CLIENT_WINDOW_POSITION,
  waitForHttpPort,
  getChromePath,
  openChrome,
  buildSessionUrls,
  getProfileDirs,
  resolveChromeProfileRoot,
}
