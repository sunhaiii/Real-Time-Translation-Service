'use strict'

/**
 * 라이센스 서버 연동 모듈
 * - 머신 지문 생성, 레지스트리 키 저장/로드, 서버 호출, 복호화
 */

const crypto = require('crypto')
const https = require('https')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// ─────────────────────────────────────────────────────────────
// 빌드 전용 config (git 제외 파일) — scripts/license-config.local.js 에 키 입력
const { CONFIG_ENCRYPT_KEY_HEX } = require('./license-config.local')
// ─────────────────────────────────────────────────────────────

const LICENSE_SERVER_URL = 'https://qstt-license.duckdns.org'
const PRODUCT_ID = 'qstt'
const REG_PATH = 'HKCU\\Software\\LabQ\\QSTT'
const ALGORITHM = 'aes-256-gcm'

// ── 머신 지문 ────────────────────────────────────────────────

function getMachineFingerprint() {
  const parts = []
  try {
    const r = spawnSync('wmic', ['cpu', 'get', 'ProcessorId', '/format:value'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const m = (r.stdout || '').match(/ProcessorId=(\S+)/)
    if (m) parts.push(m[1])
  } catch (_) {}
  try {
    const r = spawnSync('wmic', ['diskdrive', 'get', 'serialnumber', '/format:value'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const m = (r.stdout || '').match(/SerialNumber=(\S+)/)
    if (m) parts.push(m[1])
  } catch (_) {}
  const nets = os.networkInterfaces()
  for (const iface of Object.values(nets)) {
    const ext = (iface || []).find(a => !a.internal && a.mac !== '00:00:00:00:00:00')
    if (ext) { parts.push(ext.mac); break }
  }
  if (parts.length === 0) parts.push(os.hostname())
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

// ── Windows 레지스트리 ───────────────────────────────────────

function getLicenseKeyFromRegistry() {
  try {
    const r = spawnSync('reg', ['query', REG_PATH, '/v', 'LicenseKey'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    const m = (r.stdout || '').match(/LicenseKey\s+REG_SZ\s+(\S+)/)
    return m ? m[1].trim() : null
  } catch (_) { return null }
}

function saveLicenseKeyToRegistry(key) {
  try {
    spawnSync('reg', ['add', REG_PATH, '/v', 'LicenseKey', '/t', 'REG_SZ', '/d', key, '/f'],
      { windowsHide: true, timeout: 3000 })
  } catch (_) {}
}

function deleteLicenseKeyFromRegistry() {
  try {
    spawnSync('reg', ['delete', REG_PATH, '/v', 'LicenseKey', '/f'],
      { windowsHide: true, timeout: 3000 })
  } catch (_) {}
}

// ── VBS 다이얼로그 (GUI exe 환경에서도 표시) ─────────────────

function vbsInputBox(title, message) {
  const resultFile = path.join(os.tmpdir(), `qstt-lr-${process.pid}-${Date.now()}.txt`)
  const tmp = path.join(os.tmpdir(), `qstt-li-${process.pid}-${Date.now()}.vbs`)
  const esc = s => String(s).replace(/"/g, '""')
  // VBScript 문자열은 줄바꿈을 포함할 수 없으므로 vbCrLf로 이어 붙임
  const msgExpr = String(message).split(/\r?\n/).map(l => `"${esc(l)}"`).join(' & vbCrLf & ')
  const resultPath = resultFile.replace(/\\/g, '\\\\')
  const vbs = [
    `Dim k`,
    `k = InputBox(${msgExpr}, "${esc(title)}", "")`,
    `If k = "" Then WScript.Quit 1`,
    `Dim fso: Set fso = CreateObject("Scripting.FileSystemObject")`,
    `Dim f: Set f = fso.OpenTextFile("${esc(resultPath)}", 2, True)`,
    `f.Write k`,
    `f.Close`,
    `WScript.Quit 0`,
  ].join('\n')
  fs.writeFileSync(tmp, '\uFEFF' + vbs, 'utf16le')
  try {
    const r = spawnSync('cscript', ['//nologo', tmp], { windowsHide: true, timeout: 120000 })
    if (r.status !== 0 || !fs.existsSync(resultFile)) return null
    return fs.readFileSync(resultFile, 'utf8').trim() || null
  } finally {
    try { fs.unlinkSync(tmp) } catch (_) {}
    try { fs.unlinkSync(resultFile) } catch (_) {}
  }
}

// ── HTTPS 서버 호출 ──────────────────────────────────────────

function callActivateEndpoint(licenseKey, machineId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ license_key: licenseKey, machine_id: machineId, product_id: PRODUCT_ID })
    const url = new URL('/v1/activate', LICENSE_SERVER_URL)
    const req = https.request({
      hostname: url.hostname,
      port: Number(url.port) || 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('서버 응답을 파싱할 수 없습니다')) }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('라이센스 서버 연결 시간 초과 (15s)')) })
    req.on('error', e => reject(new Error(`라이센스 서버 연결 실패: ${e.message}`)))
    req.write(body)
    req.end()
  })
}

// ── AES-256-GCM 복호화 ───────────────────────────────────────

function decryptConfig(encryptedConfig) {
  const key = Buffer.from(CONFIG_ENCRYPT_KEY_HEX, 'hex')
  const iv = Buffer.from(encryptedConfig.iv, 'base64')
  const payload = Buffer.from(encryptedConfig.data, 'base64')
  const authTag = payload.slice(-16)
  const ciphertext = payload.slice(0, -16)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8'))
}

// ── 메인 함수 ────────────────────────────────────────────────

/**
 * 라이센스 검증 후 복호화된 config 반환
 * @param {Function} showError  (title, message) → Windows VBS 오류 팝업
 * @param {Function} log        (message) → 런처 로그 기록
 * @returns {Promise<Object>}   복호화된 config 객체
 */
async function validateLicense(showError, log) {
  const machineId = getMachineFingerprint()
  log(`license: machineId=${machineId.slice(0, 8)}...`)

  let licenseKey = getLicenseKeyFromRegistry()

  if (!licenseKey) {
    log('license: no key in registry, prompting user')
    licenseKey = vbsInputBox(
      'QSTT 라이센스 활성화',
      '라이센스 키를 입력해주세요.\n예) QSTT-XXXX-XXXX-XXXX\n\n구매·문의: example@example.com'
    )
    if (!licenseKey) {
      showError('라이센스 오류', '라이센스 키를 입력하지 않았습니다.\n프로그램을 종료합니다.')
      process.exit(1)
    }
  }

  log(`license: calling server for key=${licenseKey.slice(0, 9)}...`)

  let response
  try {
    response = await callActivateEndpoint(licenseKey, machineId)
  } catch (err) {
    log(`license: server error: ${err.message}`)
    showError(
      '라이센스 서버 오류',
      `라이센스 서버에 연결할 수 없습니다.\n인터넷 연결을 확인해주세요.\n\n${err.message}\n\n문의: example@example.com`
    )
    process.exit(1)
  }

  if (!response.success) {
    log(`license: rejected: ${response.error}`)
    deleteLicenseKeyFromRegistry()
    showError('라이센스 오류', `${response.error}\n\n문의: example@example.com`)
    process.exit(1)
  }

  saveLicenseKeyToRegistry(licenseKey)
  const tier = String(response.tier || 'B').toUpperCase()
  log(`license: ok, customer=${response.customer_name}, expires=${response.expires_at}, tier=${tier}`)

  try {
    return {
      ...decryptConfig(response.config),
      QSTT_LICENSE_TIER: tier,
      QSTT_MACHINE_ID: machineId,
      QSTT_CUSTOMER_NAME: response.customer_name || 'unknown-customer',
    }
  } catch (err) {
    log(`license: decrypt failed: ${err.message}`)
    showError('복호화 오류', '라이센스 설정 복호화에 실패했습니다.\n관리자에게 문의해주세요.\n\nexample@example.com')
    process.exit(1)
  }
}

module.exports = { validateLicense }
