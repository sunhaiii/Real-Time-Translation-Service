/**
 * pkg 빌드 직전에 실행: launcher-expiry.generated.json 생성
 * - 기본: 30일 후 만료 — QSTT_EXE_VALID_DAYS=90
 * - 테스트: QSTT_EXE_VALID_MINUTES=10 (분 단위, 설정 시 일수보다 우선)
 */
'use strict'

const fs = require('fs')
const path = require('path')

const rawMin = process.env.QSTT_EXE_VALID_MINUTES
const minutes =
  rawMin !== undefined && rawMin !== '' ? parseInt(rawMin, 10) : NaN
const useMinutes = Number.isFinite(minutes) && minutes > 0

let payload
let builtAt
let expiresAt
let outPath

builtAt = new Date().toISOString()
outPath = path.join(__dirname, 'launcher-expiry.generated.json')

if (useMinutes) {
  expiresAt = new Date(Date.now() + minutes * 60000).toISOString()
  payload = { expiresAt, builtAt, validMinutes: minutes }
} else {
  const raw = process.env.QSTT_EXE_VALID_DAYS
  const days = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 30
  const validDays = Number.isFinite(days) && days > 0 ? days : 30
  expiresAt = new Date(Date.now() + validDays * 86400000).toISOString()
  payload = { expiresAt, builtAt, validDays }
}

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')

if (useMinutes) {
  console.error(`[write-launcher-expiry] 테스트 ${minutes}분 빌드, 만료 시각(UTC): ${expiresAt}`)
} else {
  console.error(`[write-launcher-expiry] ${payload.validDays}일 빌드, 만료 시각(UTC): ${expiresAt}`)
}
