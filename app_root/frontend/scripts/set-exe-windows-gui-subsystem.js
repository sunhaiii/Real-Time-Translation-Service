/**
 * pkg로 만든 Windows exe는 기본이 콘솔(CUI) 서브시스템이라 CMD 창이 뜹니다.
 * PE Optional Header의 Subsystem을 WINDOWS_GUI(2)로 바꿉니다.
 *
 * 사용: node scripts/set-exe-windows-gui-subsystem.js ../dist/qstt.exe
 */
'use strict'

const fs = require('fs')
const path = require('path')

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3

function setSubsystemToGui(exePath) {
  const buf = fs.readFileSync(exePath)
  if (buf.length < 0x100 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('MZ 시그니처가 아닙니다.')
  }
  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset < 0 || peOffset > buf.length - 256) {
    throw new Error('잘못된 PE 오프셋입니다.')
  }
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('PE 파일이 아닙니다.')
  }
  const optionalHeaderOffset = peOffset + 24
  const magic = buf.readUInt16LE(optionalHeaderOffset)
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`지원하지 않는 Optional Header magic: 0x${magic.toString(16)}`)
  }
  const subsystemOffset = optionalHeaderOffset + 68
  if (subsystemOffset + 2 > buf.length) {
    throw new Error('파일 레이아웃이 잘못되었습니다.')
  }
  const current = buf.readUInt16LE(subsystemOffset)
  if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    console.error(`${exePath}: 이미 GUI 서브시스템입니다.`)
    return false
  }
  if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    console.warn(
      `${exePath}: 서브시스템 ${current} (일반 CUI=3) — GUI(2)로 덮어씁니다.`,
    )
  }
  buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOffset)
  fs.writeFileSync(exePath, buf)
  console.error(`${exePath}: WINDOWS_GUI 서브시스템으로 설정했습니다 (콘솔 창 없음).`)
  return true
}

const target = process.argv[2]
if (!target) {
  console.error('사용법: node scripts/set-exe-windows-gui-subsystem.js <경로\\파일.exe>')
  process.exit(1)
}

try {
  setSubsystemToGui(path.resolve(process.cwd(), target))
} catch (e) {
  console.error(e.message || e)
  process.exit(1)
}
