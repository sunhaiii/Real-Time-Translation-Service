/**
 * Waits for the dev server to be ready, then opens:
 * - Chrome (normal profile): counselor → 1번 메인 모니터
 * - Chrome (normal profile): client    → 2번 서브 모니터
 * Windows only. Requires Chrome installed.
 */

const path = require('path')
const { spawn } = require('child_process')
const {
  DEFAULT_FRONT_PORT,
  waitForHttpPort,
  getChromePath,
  buildSessionUrls,
  getProfileDirs,
  resolveChromeProfileRoot,
  openChrome,
  COUNSELOR_WINDOW_POSITION,
  CLIENT_WINDOW_POSITION,
} = require('./chrome-launch-shared')

const PORT = DEFAULT_FRONT_PORT
const BASE = `http://localhost:${PORT}`

const CHROME_PROFILE_ROOT = resolveChromeProfileRoot(path.join(__dirname, '.chrome-profiles'))

function startDevServer() {
  const cwd = path.join(__dirname, '..')
  const child = spawn('npm run dev', [], {
    cwd,
    stdio: 'inherit',
    detached: true,
    shell: true,
  })
  child.unref()
}

const skipServerStart = process.env.SKIP_SERVER_START === '1' || process.env.SKIP_SERVER_START === 'true'

function main() {
  const chromePath = getChromePath()
  if (!chromePath) {
    console.error('Chrome not found. Install Chrome or set path in this script.')
    process.exit(1)
  }

  if (!skipServerStart) {
    console.log('Starting dev server...')
    startDevServer()
  }

  // const sessionId = `session-${Date.now()}`
  const sessionId = 'translator' // (임시) 고정 세션 ID
  const { counselorUrl, clientUrl } = buildSessionUrls(PORT, sessionId)
  const dirs = getProfileDirs(CHROME_PROFILE_ROOT)

  console.log('Waiting for server at', BASE, '... (up to ~90s)')
  const waitSteps = skipServerStart
    ? Promise.resolve()
    : Promise.resolve().then(() => new Promise((r) => setTimeout(r, 2000)))
  waitSteps
    .then(() => waitForHttpPort(PORT, '/'))
    .then(() => {
      console.log('Server ready. Opening counselor (일반 프로필 → 1번 메인 모니터)...')
      openChrome(chromePath, counselorUrl, false, COUNSELOR_WINDOW_POSITION, dirs.counselor)
      return new Promise((r) => setTimeout(r, 1500))
    })
    .then(() => {
      console.log('Opening client (일반 프로필 → 2번 서브 모니터)...')
      openChrome(chromePath, clientUrl, false, CLIENT_WINDOW_POSITION, dirs.client)
    })
    .catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
}

main()
