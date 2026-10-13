/**
 * Windows: start backend (uvicorn :8001), serve Next static export (:3000), open Chrome (counselor/client).
 * Run from repo: node scripts/launch-windows-stack.js (app_root = ../..)
 * Packaged exe: place qstt.exe with out/ and backend/ in the same folder.
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
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
const { validateLicense } = require('./license-client')

const BACKEND_PORT = 8001
const FRONT_PORT = DEFAULT_FRONT_PORT

function getAppRoot() {
  if (process.pkg) {
    return path.dirname(process.execPath)
  }
  return path.resolve(__dirname, '..', '..')
}

function resolveOutDir(appRoot) {
  const flat = path.join(appRoot, 'out')
  if (fs.existsSync(path.join(flat, 'index.html'))) return flat
  const nestedOut = path.join(flat, 'out')
  if (fs.existsSync(path.join(nestedOut, 'index.html'))) return nestedOut
  const nested = path.join(appRoot, 'frontend', 'out')
  if (fs.existsSync(path.join(nested, 'index.html'))) return nested
  return flat
}

function resolveBackendDir(appRoot) {
  return path.join(appRoot, 'backend')
}

function writeLauncherLog(appRoot, message) {
  if (!process.pkg) return
  try {
    fs.appendFileSync(
      path.join(appRoot, 'qstt-launcher.log'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8',
    )
  } catch (_) {}
}

/** GUI exe에서도 보이도록 VBS MsgBox (UTF-16LE). 줄바꿈은 vbCrLf로 이어서 표시 */
function showWindowsMessage(title, message) {
  const tmp = path.join(os.tmpdir(), `qstt-msg-${process.pid}-${Date.now()}.vbs`)
  const esc = (s) => String(s).replace(/"/g, '""')
  const lines = String(message).split(/\r?\n/)
  const msgExpr = lines.map((line) => `"${esc(line)}"`).join(' & vbCrLf & ')
  const body = `MsgBox ${msgExpr}, 48, "${esc(title)}"`
  fs.writeFileSync(tmp, '\uFEFF' + body, 'utf16le')
  try {
    spawnSync('cscript', ['//nologo', tmp], { windowsHide: true, timeout: 120000 })
  } finally {
    try { fs.unlinkSync(tmp) } catch (_) {}
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function createStaticServer(rootDir) {
  const rootResolved = path.resolve(rootDir)

  function safeFileForUrl(pathname) {
    const decoded = decodeURIComponent(pathname.split('?')[0] || '/')
    if (decoded.includes('\0')) return null
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '')
    if (rel.split(/[/\\]/).some((p) => p === '..')) return null
    const full = path.resolve(rootResolved, rel)
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null
    return full
  }

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const filePath = safeFileForUrl(req.url || '/')
    if (!filePath) {
      res.writeHead(403)
      res.end()
      return
    }

    const sendFile = (fp) => {
      fs.stat(fp, (err, st) => {
        if (err || !st.isFile()) {
          trySpaFallback()
          return
        }
        const ext = path.extname(fp).toLowerCase()
        const type = MIME[ext] || 'application/octet-stream'
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size })
          res.end()
          return
        }
        const stream = fs.createReadStream(fp)
        res.writeHead(200, { 'Content-Type': type })
        stream.pipe(res)
        stream.on('error', () => {
          res.destroy()
        })
      })
    }

    const trySpaFallback = () => {
      if (req.method !== 'GET') {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const indexPath = path.join(rootResolved, 'index.html')
      fs.readFile(indexPath, (e, buf) => {
        if (e) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(buf)
      })
    }

    fs.stat(filePath, (err, st) => {
      if (!err && st.isDirectory()) {
        sendFile(path.join(filePath, 'index.html'))
        return
      }
      if (!err && st.isFile()) {
        sendFile(filePath)
        return
      }
      trySpaFallback()
    })
  })
}

function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (_) {}
  }
}

/**
 * pkg(exe) 재실행 시 이전에 포트만 잡고 남은 Node/uvicorn 잔존 프로세스 제거.
 * (시스템 종료 시 지연 taskkill이 실패하면 작업 관리자에 "Node.js JavaScript Runtime"이 남을 수 있음)
 */
function freeListenPortsWin32(ports) {
  if (process.platform !== 'win32' || !ports.length) return
  const portCsv = ports.join(',')
  const script = `foreach ($port in @(${portCsv})) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $opid = $_.OwningProcess
    if ($opid) { & taskkill.exe /PID $opid /T /F 2>$null }
  }
}
Start-Sleep -Milliseconds 400`
  try {
    spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { stdio: 'ignore', windowsHide: true, timeout: 45000 },
    )
  } catch (_) {}
}

function resolveBackendPythonExe(backendDir) {
  const dotVenv = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
  const venv = path.join(backendDir, 'venv', 'Scripts', 'python.exe')
  if (fs.existsSync(dotVenv)) return dotVenv
  if (fs.existsSync(venv)) return venv
  return null
}

function resolveBackendExe(backendDir) {
  const p = path.join(backendDir, 'backend.exe')
  return fs.existsSync(p) ? p : null
}

/**
 * pkg(exe) 빌드 시 백엔드 자식 프로세스의 stdout/stderr를 줄 단위로
 * qstt-launcher.log에 기록한다. 개발 환경(process.pkg 없음)에서는 no-op.
 */
function pipeBackendToLauncherLog(child, appRoot, log) {
  if (!child) return

  function attachStream(stream, prefix) {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line) log(`${prefix}${line}`)
      }
    })
    stream.on('end', () => {
      if (buf.trim()) log(`${prefix}${buf.trim()}`)
    })
  }

  if (child.stdout) attachStream(child.stdout, '[BACKEND] ')
  if (child.stderr) attachStream(child.stderr, '[BACKEND ERR] ')
}

function startBackend(backendDir, appRoot, licenseConfig, profileRoot) {
  const isPkg = Boolean(process.pkg)
  const appRootAbs = path.resolve(appRoot)
  const licenseEnv = licenseConfig || {}

  // GOOGLE_CREDENTIALS_JSON(문자열)을 임시 파일로 써서 GOOGLE_APPLICATION_CREDENTIALS에 연결
  // → backend/credentials.json 파일 없이도 GCP 인증 가능
  let googleAppCredentialsPath = undefined
  if (licenseEnv.GOOGLE_CREDENTIALS_JSON) {
    try {
      const tmpCredPath = path.join(os.tmpdir(), `qstt-gcp-creds-${process.pid}.json`)
      fs.writeFileSync(tmpCredPath, licenseEnv.GOOGLE_CREDENTIALS_JSON, 'utf8')
      googleAppCredentialsPath = tmpCredPath
    } catch (_) {}
  }

  const commonEnv = {
    ...process.env,
    /** close-chrome가 런처가 연 Chrome 프로필 경로와 동일한 루트를 쓰도록 */
    QSTT_APP_ROOT: appRootAbs,
    QSTT_CHROME_PROFILE_ROOT: path.resolve(profileRoot),
    QSTT_LAUNCHER_PID: String(process.pid),
    // Python stdout 버퍼링 해제 → pkg 빌드에서 로그가 즉시 파이프로 전달됨
    PYTHONUNBUFFERED: '1',
    // 라이센스 서버에서 수신한 복호화된 설정값 주입 (.env, credentials.json 파일 불필요)
    ...(licenseEnv.GEMINI_API_KEY && { GEMINI_API_KEY: licenseEnv.GEMINI_API_KEY }),
    ...(licenseEnv.GOOGLE_API_KEY && { GOOGLE_API_KEY: licenseEnv.GOOGLE_API_KEY }),
    ...(licenseEnv.STT_ENGINE && { STT_ENGINE: licenseEnv.STT_ENGINE }),
    ...(licenseEnv.GCP_STT_PHRASE_SET_REFERENCES && { GCP_STT_PHRASE_SET_REFERENCES: licenseEnv.GCP_STT_PHRASE_SET_REFERENCES }),
    ...(licenseEnv.GCP_STT_LOCATION && { GCP_STT_LOCATION: licenseEnv.GCP_STT_LOCATION }),
    ...(licenseEnv.GCP_STT_V2_LOCATION && { GCP_STT_V2_LOCATION: licenseEnv.GCP_STT_V2_LOCATION }),
    ...(licenseEnv.GCP_STT_V2_PHRASE_SET_REFERENCES && { GCP_STT_V2_PHRASE_SET_REFERENCES: licenseEnv.GCP_STT_V2_PHRASE_SET_REFERENCES }),
    ...(licenseEnv.GCP_STT_V1_MODEL && { GCP_STT_V1_MODEL: licenseEnv.GCP_STT_V1_MODEL }),
    ...(licenseEnv.DEFAULT_SOURCE_LANG && { DEFAULT_SOURCE_LANG: licenseEnv.DEFAULT_SOURCE_LANG }),
    ...(licenseEnv.DEFAULT_TARGET_LANG && { DEFAULT_TARGET_LANG: licenseEnv.DEFAULT_TARGET_LANG }),
    ...(licenseEnv.GCS_AUDIO_BUCKET && { GCS_AUDIO_BUCKET: licenseEnv.GCS_AUDIO_BUCKET }),
    ...(licenseEnv.GCS_AUDIO_PREFIX && { GCS_AUDIO_PREFIX: licenseEnv.GCS_AUDIO_PREFIX }),
    ...(licenseEnv.QSTT_MACHINE_ID && { QSTT_MACHINE_ID: licenseEnv.QSTT_MACHINE_ID }),
    ...(licenseEnv.QSTT_CUSTOMER_NAME && { QSTT_CUSTOMER_NAME: licenseEnv.QSTT_CUSTOMER_NAME }),
    ...(googleAppCredentialsPath && { GOOGLE_APPLICATION_CREDENTIALS: googleAppCredentialsPath }),
    ...(licenseEnv.QSTT_LICENSE_TIER && { QSTT_LICENSE_TIER: licenseEnv.QSTT_LICENSE_TIER }),
  }
  /**
   * pkg(qstt.exe): CMD 창 없음 — 백엔드도 숨김.
   * isPkg 시 stdio를 'pipe'로 설정해 stdout/stderr를 qstt-launcher.log로 캡처.
   * 개발 환경(npm run dev 등)은 콘솔에 바로 출력(inherit).
   */
  const backendStdio = isPkg ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  const backendLog = (msg) => writeLauncherLog(appRoot, msg)

  const backendExe = resolveBackendExe(backendDir)
  if (backendExe) {
    const child = spawn(backendExe, [], {
      cwd: backendDir,
      stdio: backendStdio,
      windowsHide: isPkg,
      env: {
        ...commonEnv,
        HOST: licenseEnv.HOST || '0.0.0.0',
        PORT: String(BACKEND_PORT),
        FRONTEND_URL: licenseEnv.FRONTEND_URL || `http://localhost:${DEFAULT_FRONT_PORT}`,
      },
    })
    if (isPkg) pipeBackendToLauncherLog(child, appRoot, backendLog)
    return child
  }

  const venvPython = resolveBackendPythonExe(backendDir)
  const useVenv = Boolean(venvPython)
  const cmd = useVenv ? venvPython : 'python'
  const args = ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', String(BACKEND_PORT)]

  const child = spawn(cmd, args, {
    cwd: backendDir,
    stdio: backendStdio,
    shell: !useVenv && !isPkg,
    windowsHide: isPkg,
    env: {
      ...commonEnv,
    },
  })
  if (isPkg) pipeBackendToLauncherLog(child, appRoot, backendLog)
  return child
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('This launcher is intended for Windows.')
    process.exit(1)
  }

  const appRoot = getAppRoot()
  const outDir = resolveOutDir(appRoot)
  const backendDir = resolveBackendDir(appRoot)
  const profileRoot = resolveChromeProfileRoot(path.join(appRoot, '.chrome-profiles'))
  const log = (msg) => writeLauncherLog(appRoot, msg)

  log(`Starting. appRoot=${appRoot} outDir=${outDir} backendDir=${backendDir} profileRoot=${profileRoot}`)

  // 라이센스 검증 (pkg 빌드에서만, 로컬 개발 실행은 스킵)
  let licenseConfig = null
  if (process.pkg) {
    licenseConfig = await validateLicense(
      (title, msg) => showWindowsMessage(title, msg),
      log
    )
    log('license validation passed')
  }

  if (!fs.existsSync(path.join(outDir, 'index.html'))) {
    const msg = `Static export not found. Need index.html at:\n  ${path.join(outDir, 'index.html')}\n` +
      `Tip: copy the *contents* of frontend/out (including index.html) into Qstt/out — not an extra nested "out" folder unless index.html is inside it.`
    console.error(msg)
    log(msg)
    process.exit(1)
  }
  const hasBackendExe = Boolean(resolveBackendExe(backendDir))
  const hasMainPy = fs.existsSync(path.join(backendDir, 'main.py'))
  if (!hasBackendExe && !hasMainPy) {
    const msg = `Backend not found. Expected either backend.exe or main.py under:\n  ${backendDir}`
    console.error(msg)
    log(msg)
    process.exit(1)
  }

  const chromePath = getChromePath()
  if (!chromePath) {
    const msg = 'Chrome not found. Install Google Chrome.'
    console.error(msg)
    log(msg)
    process.exit(1)
  }

  let backendChild = null
  let staticServer = null
  let shuttingDown = false

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\nShutting down...')
    if (staticServer) {
      try {
        staticServer.close()
      } catch (_) {}
      staticServer = null
    }
    if (backendChild && backendChild.pid) {
      killProcessTree(backendChild.pid)
      backendChild = null
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (process.pkg) {
    freeListenPortsWin32([FRONT_PORT, BACKEND_PORT])
  }

  console.log('App root:', appRoot)
  console.log('Starting backend (port %s)...', BACKEND_PORT)
  backendChild = startBackend(backendDir, appRoot, licenseConfig, profileRoot)
  backendChild.on('error', (err) => {
    const msg = `Failed to start backend: ${err.message}`
    console.error(msg)
    log(msg)
    process.exit(1)
  })
  backendChild.on('exit', (code, signal) => {
    if (shuttingDown) return
    shuttingDown = true
    if (staticServer) {
      try {
        staticServer.close()
      } catch (_) {}
      staticServer = null
    }
    if (signal || code !== 0) {
      const msg = `Backend exited unexpectedly code=${code} signal=${signal || ''}`
      console.error(msg)
      log(msg)
      process.exit(1)
    }
    process.exit(0)
  })

  try {
    await waitForHttpPort(BACKEND_PORT, '/docs', 180, 500)
  } catch (e) {
    const msg = `${e.message} (backend did not respond on port ${BACKEND_PORT}/docs — check license config, firewall, or port already in use)`
    console.error(msg)
    log(msg)
    killProcessTree(backendChild.pid)
    process.exit(1)
  }

  console.log('Serving static files from', outDir, 'on port', FRONT_PORT)
  staticServer = createStaticServer(outDir)
  await new Promise((resolve, reject) => {
    staticServer.listen(FRONT_PORT, '0.0.0.0', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })

  try {
    await waitForHttpPort(FRONT_PORT, '/', 60, 200)
  } catch (e) {
    console.error(e.message)
    log(String(e.message))
    shutdown()
    process.exit(1)
  }

  log('OK: backend + static server ready; opening Chrome.')

  const sessionId = 'translator' // 고정 세션 ID (카운슬러·클라이언트가 항상 같은 세션으로 연결)
  const { counselorUrl, clientUrl } = buildSessionUrls(FRONT_PORT, sessionId)
  const dirs = getProfileDirs(profileRoot)

  console.log('Opening counselor (일반 프로필, 1번 모니터)...')
  openChrome(chromePath, counselorUrl, false, COUNSELOR_WINDOW_POSITION, dirs.counselor)
  await new Promise((r) => setTimeout(r, 1500))
  console.log('Opening client (일반 프로필, 2번 모니터)...')
  openChrome(chromePath, clientUrl, false, CLIENT_WINDOW_POSITION, dirs.client)

  if (!process.pkg) {
    console.log('Running. Press Ctrl+C to stop backend and static server.')
  }
}

main().catch((err) => {
  console.error(err)
  try {
    writeLauncherLog(getAppRoot(), String(err && err.stack ? err.stack : err))
  } catch (_) {}
  process.exit(1)
})
