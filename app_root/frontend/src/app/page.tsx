'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import LanguageSelectScreen from '@/components/LanguageSelectScreen'
import CounselorScreen from '@/components/CounselorScreen'
import CounselorChatSettingsModal, { type AudioInputOption } from '@/components/CounselorChatSettingsModal'
import WordDictionaryModal from '@/components/WordDictionaryModal'
import ClientScreen from '@/components/ClientScreen'
import FontSizeSelect, { getStoredFontSize, setStoredFontSize, DEFAULT_FONT_SIZE } from '@/components/FontSizeSelect'
import { WebSocketService } from '@/lib/websocket'
import { ALPHABET_LANGUAGES, isLanguageAllowedForTier } from '@/lib/languageList'

let serverAudioPlaybackUnlocked = false
// TTS 재생 중 마이크 청취 억제를 위한 활성 TTS 카운터
// (모듈 수준: playServerTtsAudio ↔ AudioWorklet 핸들러가 공유)
let activeTtsAudioCount = 0
function isTtsActive() { return activeTtsAudioCount > 0 }
let serverTtsQueue: Array<{ base64Audio: string; mimeType: string }> = []
let serverTtsPlaying = false
const ROOM_LEAK_DEBUG = process.env.NEXT_PUBLIC_ROOM_LEAK_DEBUG === '1'
const COUNSELOR_MIC_STORAGE_KEY = 'qstt:counselorMicDeviceId'
const CLIENT_MIC_STORAGE_KEY = 'qstt:clientMicDeviceId'
const SPEECH_LEVEL_STALE_MS = 3000
const SPEECH_ACTIVE_LEVEL_THRESHOLD = 0.10

// Supported language list
const LANGUAGES = [
  { code: 'ko', name: 'Korean' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'en', name: 'English (US)' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'tl', name: 'Filipino (Tagalog)' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh-HK', name: 'Cantonese (HK)' },
  { code: 'en-SG', name: 'English (Singapore)' },
]

/** 피상담자 언어 선택 화면에서 언어 확정 시 자동 전송 (발신자: 상담자, 원문 한국어) */
const DEFAULT_COUNSELOR_WELCOME_KO =
  '안녕하세요. 무엇을 도와드릴까요?\n필요하신 내용 마이크에 대고 말씀해주세요.'

// Load browser voice list (Chrome/Edge loads asynchronously; newly installed languages on Windows may be delayed)
function getVoicesPromise(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return Promise.resolve([])
  const synth = window.speechSynthesis
  return new Promise((resolve) => {
    let done = false
    const doResolve = (voices: SpeechSynthesisVoice[]) => {
      if (done) return
      done = true
      resolve(voices)
    }
    const tryResolve = () => {
      const voices = synth.getVoices()
      if (voices.length > 0) {
        doResolve(voices)
        return true
      }
      return false
    }
    if (tryResolve()) return
    synth.addEventListener('voiceschanged', () => {
      if (!tryResolve()) doResolve(synth.getVoices())
    }, { once: true })
    // Retry multiple times since voice list loading may be slow after installing new language on Windows
    const delays = [50, 200, 500, 1000]
    delays.forEach((ms) => {
      setTimeout(() => {
        if (done) return
        if (tryResolve()) return
        if (ms === 1000) doResolve(synth.getVoices())
      }, ms)
    })
  })
}

// Find a voice matching the requested language (e.g. th-TH, en-US). On Windows, Thai may appear as "th-TH" or "th"
function findVoiceForLang(voices: SpeechSynthesisVoice[], langCode: string): SpeechSynthesisVoice | null {
  const normalized = (s: string) => s.replace('_', '-').toLowerCase()
  const target = normalized(langCode)
  const exact = voices.find((v) => normalized(v.lang) === target || normalized(v.lang).startsWith(target + '-'))
  if (exact) return exact
  const langPart = langCode.split('-')[0].toLowerCase()
  const byLang = voices.find((v) => normalized(v.lang).startsWith(langPart))
  if (byLang) return byLang
  // Some browsers only expose the language in the voice name (e.g. "Microsoft Thailand - Thai")
  const langNames: Record<string, string[]> = { th: ['thai', 'thailand'], ja: ['japanese', 'japan'], ko: ['korean', 'korea'], zh: ['chinese', 'china'], vi: ['vietnamese'], id: ['indonesian'], tl: ['tagalog', 'filipino'], uz: ['uzbek'] }
  const keywords = langNames[langPart]
  if (keywords) {
    const byName = voices.find((v) => keywords.some((k) => v.name.toLowerCase().includes(k)))
    if (byName) return byName
  }
  return null
}

// Play text via browser TTS (for client)
function speakWithTts(text: string, langCode: string, retryCount = 0) {
  if (typeof window === 'undefined' || !text?.trim()) return
  const synth = window.speechSynthesis
  if (!synth) return

  getVoicesPromise().then((voices) => {
    try {
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text.trim())
      u.lang = langCode
      u.rate = 1.0
      let voice = findVoiceForLang(voices, langCode)
      if (voice) {
        u.voice = voice
      } else {
        if (retryCount === 0) {
          console.warn(`[TTS] ${langCode} voice not found yet. Retrying shortly. (After installing, fully restart Chrome.)`)
          console.warn('[TTS] Available voices:', voices.map((v) => `${v.lang}: ${v.name}`).slice(0, 20))
          setTimeout(() => speakWithTts(text, langCode, 1), 400)
          return
        }
        // No dedicated voice for this language: try fallback voice (pronunciation may be inaccurate)
        const fallback = voices.find((v) => v.name.includes('Google')) || voices[0]
        if (fallback) {
          u.voice = fallback
          console.warn(`[TTS] No dedicated voice for ${langCode}, using fallback. (For accurate voice: add language in Windows Settings > Time & Language > Speech, then restart Chrome.)`)
        } else {
          console.warn(`[TTS] Cannot find voice for ${langCode}. Please fully restart the browser.`)
        }
      }
      synth.speak(u)
    } catch (e) {
      console.warn('TTS playback failed:', e)
    }
  })
}

// Play server TTS audio
function playServerTtsAudio(base64Audio: string, mimeType = 'audio/mpeg') {
  if (typeof window === 'undefined' || !base64Audio) return
  if (!serverAudioPlaybackUnlocked && serverTtsQueue.length === 0) {
    console.warn('Server TTS audio blocked until user interaction unlocks audio playback.')
  }
  serverTtsQueue.push({ base64Audio, mimeType })
  pumpServerTtsQueue()
}

function pumpServerTtsQueue() {
  if (typeof window === 'undefined') return
  if (!serverAudioPlaybackUnlocked || serverTtsPlaying) return
  const next = serverTtsQueue.shift()
  if (!next) return
  const { base64Audio, mimeType } = next
  const audio = new Audio(`data:${mimeType};base64,${base64Audio}`)
  serverTtsPlaying = true
  // TTS 재생 구간 동안 마이크 청취를 억제 (에코 피드백 방지)
  // ended/error 후 300ms 버퍼를 추가해 실내 잔향까지 커버
  activeTtsAudioCount++
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    // 다음 TTS는 즉시 시작하고,
    // 마이크 억제(activeTtsAudioCount)만 짧은 버퍼로 유지한다.
    serverTtsPlaying = false
    pumpServerTtsQueue()
    setTimeout(() => {
      activeTtsAudioCount = Math.max(0, activeTtsAudioCount - 1)
    }, 150)
  }
  audio.addEventListener('ended', cleanup, { once: true })
  audio.addEventListener('error', cleanup, { once: true })
  audio.play().catch((e) => {
    console.warn('Server TTS audio play failed:', e)
    cleanup()
  })
}

function getStoredMicDeviceId(key: string): string {
  if (typeof window === 'undefined') return ''
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function setStoredMicDeviceId(key: string, value: string) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    // Ignore storage errors and keep in-memory state.
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

const getFullLangCode = (code: string) => {
  const map: Record<string, string> = {
    'ko': 'ko-KR',
    'zh-CN': 'zh-CN',
    'zh-HK': 'zh-HK',
    'fr': 'fr-FR',
    'vi': 'vi-VN',
    'th': 'th-TH',
    'en': 'en-US',
    'en-SG': 'en-SG',
    'uz': 'uz-UZ',
    'tl': 'tl-PH',
    'id': 'id-ID',
    'ja': 'ja-JP',
  }
  return map[code] || code
}

interface Message {
  sender: string
  text: string
  timestamp: string
}

interface ChatSession {
  id: number
  title: string
  created_at?: string
  updated_at?: string
  room_number?: number
}

interface FinalizingBubble {
  utteranceId: string
  text: string
}

interface NetworkDiagnosticState {
  rttCurrentMs: number | null
  rttAvgMs: number | null
  rttP95Ms: number | null
  reconnectRecent5m: number
  updatedAtMs: number | null
}

// ─── 마이크 선택 + 실시간 주파수 테스트 모달 ──────────────────────────────────
interface AudioInputOption2 { deviceId: string; label: string }
interface ManagedAudioInputOption extends AudioInputOption {
  groupId?: string
  displayLabel?: string
  isDefaultLike?: boolean
}

const DEFAULT_LIKE_DEVICE_IDS = new Set(['default', 'communications'])
const COUNSELOR_BRAND_KEYWORDS = ['proton']
const CLIENT_BRAND_KEYWORDS = ['cycron']

function isDefaultLikeAudioInput(device: { deviceId: string; label: string }): boolean {
  const id = (device.deviceId || '').toLowerCase()
  const label = (device.label || '').toLowerCase()
  return DEFAULT_LIKE_DEVICE_IDS.has(id) || label.includes('default') || label.includes('기본')
}

function includesAnyKeyword(label: string, keywords: string[]): boolean {
  const lower = (label || '').toLowerCase()
  return keywords.some((kw) => lower.includes(kw.toLowerCase()))
}

function pickPreferredClientMic(
  devices: ManagedAudioInputOption[],
  preferredDeviceId: string,
): ManagedAudioInputOption | null {
  if (devices.length === 0) return null
  const clientBrandCandidates = devices.filter((device) =>
    includesAnyKeyword(device.label, CLIENT_BRAND_KEYWORDS) && !isDefaultLikeAudioInput(device),
  )
  const strictCandidates = devices.filter((device) =>
    !includesAnyKeyword(device.label, COUNSELOR_BRAND_KEYWORDS) && !isDefaultLikeAudioInput(device),
  )
  const nonBrandCandidates = devices.filter((device) =>
    !includesAnyKeyword(device.label, COUNSELOR_BRAND_KEYWORDS),
  )
  const preferredPool =
    clientBrandCandidates.length > 0
      ? clientBrandCandidates
      : strictCandidates.length > 0
      ? strictCandidates
      : (nonBrandCandidates.length > 0 ? nonBrandCandidates : devices)
  return preferredPool.find((device) => device.deviceId === preferredDeviceId) ?? preferredPool[0] ?? null
}

function withDisplayLabels(devices: ManagedAudioInputOption[]): ManagedAudioInputOption[] {
  return devices.map((device) => {
    const base = (device.label || '').trim() || '마이크'
    return { ...device, displayLabel: base }
  })
}

function getDeviceLabelBase(label: string): string {
  const base = (label || '').trim()
  return base || '마이크'
}

function MicSetupModal({
  devices,
  roleLabel,
  onSelect,
}: {
  devices: AudioInputOption2[]
  roleLabel: string
  onSelect: (deviceId: string) => void
}) {
  const [testingId, setTestingId] = useState<string | null>(null)
  const canvasRef   = useRef<HTMLCanvasElement | null>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef      = useRef<number | null>(null)

  const clearCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // 무음 상태: 중앙 점선
    ctx.strokeStyle = '#d1d5f4'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, canvas.height / 2)
    ctx.lineTo(canvas.width, canvas.height / 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const stopTest = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    analyserRef.current?.disconnect()
    void audioCtxRef.current?.close()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current = null
    analyserRef.current = null
    setTestingId(null)
    // 다음 프레임에 캔버스 초기화 (canvasRef가 아직 마운트된 경우)
    requestAnimationFrame(() => clearCanvas())
  }

  const startTest = async (deviceId: string) => {
    stopTest()
    try {
      const constraints = deviceId
        ? { audio: { deviceId: { exact: deviceId } } }
        : { audio: true }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      const actx = new AudioContext()
      audioCtxRef.current = actx
      const analyser = actx.createAnalyser()
      analyser.fftSize = 512                  // time-domain 해상도
      analyser.smoothingTimeConstant = 0.5
      analyserRef.current = analyser
      actx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)

      const tick = () => {
        analyser.getByteTimeDomainData(buf)   // 시간축 파형 데이터 (0–255, 128=무음)
        const canvas = canvasRef.current
        if (canvas) {
          const ctx = canvas.getContext('2d')!
          const W = canvas.width, H = canvas.height
          ctx.clearRect(0, 0, W, H)

          // 배경
          ctx.fillStyle = '#f4f6ff'
          ctx.fillRect(0, 0, W, H)

          // 중앙 기준선
          ctx.strokeStyle = '#c7cef8'
          ctx.lineWidth = 1
          ctx.setLineDash([4, 4])
          ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke()
          ctx.setLineDash([])

          // 파형 라인
          const gradient = ctx.createLinearGradient(0, 0, W, 0)
          gradient.addColorStop(0,   '#818cf8')
          gradient.addColorStop(0.5, '#5c79f6')
          gradient.addColorStop(1,   '#7c3aed')
          ctx.strokeStyle = gradient
          ctx.lineWidth = 2
          ctx.lineJoin = 'round'
          ctx.lineCap  = 'round'
          ctx.beginPath()
          const step = W / buf.length
          for (let i = 0; i < buf.length; i++) {
            const y = ((buf[i] / 128) - 1) * (H * 0.45) + H / 2
            i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y)
          }
          ctx.stroke()
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
      setTestingId(deviceId)
    } catch (e) {
      console.warn('Mic test failed:', e)
    }
  }

  // 언마운트 시 리소스 정리
  useEffect(() => () => stopTest(), []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-lg">
        {/* 헤더 */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: '#eff2fe' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5c79f6"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">마이크를 선택해주세요</h2>
          <p className="text-sm text-gray-500">
            {roleLabel} 화면에서 사용할 마이크를 선택하세요.<br />
          </p>
        </div>

        {/* 마이크 목록 */}
        <div className="space-y-3 mb-4">
          {devices.map((device, idx) => {
            const isTesting = testingId === device.deviceId
            return (
              <div key={device.deviceId}
                className="rounded-xl border-2 overflow-hidden transition-all"
                style={{ borderColor: isTesting ? '#5c79f6' : '#b8c4f0' }}>
                {/* 카드 헤더 */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold"
                    style={{ backgroundColor: '#eff2fe', color: '#5c79f6' }}>
                    {idx + 1}
                  </span>
                  <span className="flex-1 min-w-0 text-sm font-medium text-gray-800 truncate">{device.label}</span>
                  <div className="flex gap-2 flex-shrink-0">
                    {/* 테스트 버튼 */}
                    <button type="button"
                      onClick={() => isTesting ? stopTest() : startTest(device.deviceId)}
                      className="w-20 px-3 py-1.5 rounded-lg text-xs text-center font-semibold transition-colors"
                      style={{
                        backgroundColor: isTesting ? '#fee2e2' : '#eff2fe',
                        color: isTesting ? '#ef4444' : '#5c79f6',
                      }}>
                      {isTesting ? '■ 중지' : '▶ 테스트'}
                    </button>
                    {/* 선택 버튼 */}
                    <button type="button"
                      onClick={() => { stopTest(); onSelect(device.deviceId) }}
                      className="w-16 px-3 py-1.5 rounded-lg text-xs text-center font-semibold transition-colors"
                      style={{ backgroundColor: '#5c79f6', color: '#fff' }}>
                      선택
                    </button>
                  </div>
                </div>

                {/* 파형 시각화 캔버스 — 테스트 중일 때 표시 */}
                {isTesting && (
                  <div className="px-4 pb-3">
                    <canvas
                      ref={canvasRef}
                      width={380}
                      height={56}
                      className="w-full rounded-lg"
                      style={{ display: 'block' }}
                    />
                    <p className="text-xs text-center mt-1.5" style={{ color: '#8f8f8f' }}>
                      마이크에 말해보세요. 선이 움직이면 정상입니다
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 기본 마이크 */}
        <button type="button"
          onClick={() => { stopTest(); onSelect('') }}
          className="w-full py-2.5 rounded-xl text-sm text-gray-500 border border-gray-200 hover:bg-gray-50 transition-colors">
          기본 마이크 사용
        </button>
      </div>
    </div>
  )
}
// ──────────────────────────────────────────────────────────────────────────────
/** 상담원 화면 전용: 상담원 → 피상담자 마이크를 단계별로 설정 (토스 스타일 슬라이드) */
function DualMicSetupModal({
  devices,
  onComplete,
  onClose,
}: {
  devices: AudioInputOption2[]
  onComplete: (counselorDeviceId: string, counselorLabel: string, clientDeviceId: string, clientLabel: string) => void
  onClose?: () => void
}) {
  const MODAL_W = 500
  const [step, setStep] = useState(0)                      // 0 = 상담원, 1 = 피상담자
  const [counselorSel, setCounselorSel] = useState<string | null>(null)
  const [clientSel, setClientSel]       = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)  // step0 체크 애니메이션용
  const [testingId, setTestingId] = useState<string | null>(null)
  const canvasRef0  = useRef<HTMLCanvasElement | null>(null)  // step0 waveform
  const canvasRef1  = useRef<HTMLCanvasElement | null>(null)  // step1 waveform
  const streamRef   = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef      = useRef<number | null>(null)

  const activeCanvas = () => step === 0 ? canvasRef0.current : canvasRef1.current

  const stopTest = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    analyserRef.current?.disconnect()
    void audioCtxRef.current?.close()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null; audioCtxRef.current = null; analyserRef.current = null
    setTestingId(null)
  }

  const startTest = async (deviceId: string) => {
    stopTest()
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true }
      )
      streamRef.current = stream
      const actx = new AudioContext(); audioCtxRef.current = actx
      const analyser = actx.createAnalyser()
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.6; analyserRef.current = analyser
      actx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(buf)
        const canvas = activeCanvas()
        if (canvas) {
          const ctx = canvas.getContext('2d')!
          const W = canvas.width, H = canvas.height
          ctx.clearRect(0, 0, W, H)
          ctx.fillStyle = '#f0f4ff'; ctx.fillRect(0, 0, W, H)
          const g = ctx.createLinearGradient(0, 0, W, 0)
          g.addColorStop(0, '#818cf8'); g.addColorStop(0.5, '#3b82f6'); g.addColorStop(1, '#6366f1')
          ctx.strokeStyle = g; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
          ctx.beginPath()
          for (let i = 0; i < buf.length; i++) {
            const y = ((buf[i] / 128) - 1) * (H * 0.42) + H / 2
            i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * (W / buf.length), y)
          }
          ctx.stroke()
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      tick(); setTestingId(deviceId)
    } catch (e) { console.warn('Mic test failed:', e) }
  }

  useEffect(() => () => stopTest(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const allDevices: AudioInputOption2[] = devices

  const handleSelect = (deviceId: string) => {
    if (step === 0) {
      stopTest()
      setCounselorSel(deviceId)
      setPendingId(deviceId)
      setTimeout(() => {
        setPendingId(null)
        setStep(1)
      }, 420)
    } else {
      // step 1: 선택만 하고 저장 버튼으로 완료
      stopTest()
      setClientSel(deviceId)
    }
  }

  const handleSave = () => {
    if (clientSel === null) return
    const cLabel = (counselorSel === '' ? '기본 마이크' : devices.find((d) => d.deviceId === counselorSel)?.label) ?? '기본 마이크'
    const kLabel = (clientSel   === '' ? '기본 마이크' : devices.find((d) => d.deviceId === clientSel)?.label)   ?? '기본 마이크'
    onComplete(counselorSel ?? '', cLabel, clientSel, kLabel)
  }

  // 파란 계열로 통일
  const ACCENT      = '#3b82f6'
  const ACCENT_LITE = '#EFF6FF'   // 기본 카드 배경 (연한 하늘색)
  const ACCENT_SEL  = '#DBEAFE'   // 선택된 카드 배경 (진한 하늘색)
  const ACCENT_BORD = '#bfdbfe'   // 기본 카드 테두리

  const renderPanel = (panelStep: number) => {
    const isCounselor = panelStep === 0
    const canvasRef = isCounselor ? canvasRef0 : canvasRef1
    const canSave = !isCounselor && clientSel !== null

    return (
      <div style={{ width: MODAL_W, flexShrink: 0, padding: '40px 32px 36px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* 뒤로가기 — step1 전용, 좌측 정렬 */}
        <div style={{ width: '100%', minHeight: 28, display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          {!isCounselor && (
            <button
              type="button"
              onClick={() => { stopTest(); setPendingId(null); setClientSel(null); setStep(0) }}
              style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500, padding: 0 }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              이전
            </button>
          )}
        </div>

        {/* 도트 인디케이터 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
          {[0, 1].map((i) => (
            <div key={i} style={{
              width: i === panelStep ? 20 : 8,
              height: 8,
              borderRadius: 99,
              backgroundColor: i === panelStep ? ACCENT : '#d1d5db',
              transition: 'all 0.3s',
            }} />
          ))}
        </div>

        {/* 아이콘 */}
        <div style={{
          width: 60, height: 60, borderRadius: '50%',
          backgroundColor: ACCENT_LITE,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </div>

        {/* 제목 · 부제 */}
        <p style={{ fontSize: 22, fontWeight: 700, color: '#111827', marginBottom: 6, lineHeight: 1.3, textAlign: 'center' }}>
          {isCounselor ? '상담원 마이크' : '피상담자 마이크'}<br />
        </p>
        <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 28, textAlign: 'center' }}>
          {isCounselor ? '상담원이 사용할 마이크를 선택하세요' : '피상담자가 사용할 마이크를 선택하세요'}
        </p>

        {/* 마이크 카드 목록 */}
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {allDevices.map((device) => {
            const isTesting  = testingId === device.deviceId && panelStep === step
            const isPending  = pendingId === device.deviceId && isCounselor
            const isSelected = !isCounselor && clientSel === device.deviceId
            const highlighted = isPending || isSelected

            return (
              <div
                key={device.deviceId || 'default'}
                onClick={() => !isPending && handleSelect(device.deviceId)}
                style={{
                  border: `1.5px solid ${highlighted ? ACCENT : isTesting ? ACCENT : ACCENT_BORD}`,
                  borderRadius: 16,
                  backgroundColor: highlighted ? ACCENT_SEL : ACCENT_LITE,
                  cursor: isPending ? 'default' : 'pointer',
                  overflow: 'hidden',
                  transition: 'border-color 0.15s, background-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px' }}>
                  {/* 마이크 아이콘 원 */}
                  <div style={{
                    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                    backgroundColor: highlighted ? ACCENT : '#dbeafe',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background-color 0.2s',
                  }}>
                    {highlighted ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    )}
                  </div>

                  <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: '#1f2937', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {device.label}
                  </span>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {device.deviceId !== '' && !highlighted && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); isTesting ? stopTest() : startTest(device.deviceId) }}
                        style={{
                          width: 82,
                          padding: '5px 13px', borderRadius: 99,
                          border: `1px solid ${isTesting ? '#fca5a5' : ACCENT_BORD}`,
                          backgroundColor: isTesting ? '#fef2f2' : 'white',
                          color: isTesting ? '#ef4444' : '#6b7280',
                          fontSize: 12, fontWeight: 500, cursor: 'pointer',
                          transition: 'all 0.15s',
                        }}
                      >
                        {isTesting ? '■ 중지' : '▶ 테스트'}
                      </button>
                    )}
                  </div>
                </div>

                {/* 파형 */}
                {isTesting && (
                  <div style={{ padding: '0 18px 14px' }}>
                    <canvas
                      ref={canvasRef}
                      width={MODAL_W - 72}
                      height={44}
                      style={{ width: '100%', borderRadius: 10, display: 'block' }}
                    />
                    <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 5 }}>
                      말해보세요. 선이 움직이면 정상입니다
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 저장 버튼 — step1 전용 */}
        {!isCounselor && (
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            style={{
              marginTop: 20,
              width: '100%',
              padding: '14px 0',
              borderRadius: 14,
              border: 'none',
              backgroundColor: canSave ? ACCENT : '#e5e7eb',
              color: canSave ? '#fff' : '#9ca3af',
              fontSize: 16,
              fontWeight: 700,
              cursor: canSave ? 'pointer' : 'not-allowed',
              transition: 'background-color 0.2s',
              letterSpacing: 0.3,
            }}
          >
            저장
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'relative', width: MODAL_W, overflow: 'hidden', borderRadius: 24, backgroundColor: 'white', boxShadow: '0 24px 64px rgba(0,0,0,0.25)' }}>
        {/* X 닫기 버튼 */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              position: 'absolute', top: 16, right: 16, zIndex: 10,
              width: 32, height: 32, borderRadius: '50%',
              backgroundColor: '#f3f4f6', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#e5e7eb' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#f3f4f6' }}
            aria-label="닫기"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <div style={{
          display: 'flex',
          width: MODAL_W * 2,
          transform: `translateX(${step === 0 ? 0 : -MODAL_W}px)`,
          transition: 'transform 0.38s cubic-bezier(0.4, 0, 0.2, 1)',
        }}>
          {renderPanel(0)}
          {renderPanel(1)}
        </div>
      </div>
    </div>
  )
}
// ──────────────────────────────────────────────────────────────────────────────

export default function Home() {
  // Screen flow: 'role' => 'counselor' => 'client'
  const [screen, setScreen] = useState('role') // 'role', 'counselor', 'client'
  const screenRef = useRef('role')
  const [role, setRole] = useState<string | null>(null) // 'counselor' or 'client'
  const roleRef = useRef<string | null>(null) // keeps previous role value when role changes
  
  // Counselor language
  const [counselorLang, setCounselorLang] = useState('ko')
  const counselorLangRef = useRef('ko')
  const [clientLang, setClientLang] = useState<string | null>(null)
  const clientLangRef = useRef<string | null>(null)
  const [clientLangBeforeHome, setClientLangBeforeHome] = useState<string | null>(null)

  /** 백엔드 QSTT_LICENSE_TIER — A일 때 언어 선택 목록 제한 */
  const [licenseTier, setLicenseTier] = useState<'A' | 'B'>('B')

  useEffect(() => {
    let cancelled = false
    const base =
      typeof window !== 'undefined'
        ? `${window.location.protocol}//${window.location.hostname}:8001`
        : 'http://localhost:8001'
    void fetch(`${base}/api/license-tier`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.tier === 'A') setLicenseTier('A')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const counselorLanguagesForUi = useMemo(() => {
    if (licenseTier !== 'A') return LANGUAGES
    return LANGUAGES.filter((l) => isLanguageAllowedForTier(l.code, 'A'))
  }, [licenseTier])
  const targetFavoriteLanguagesForUi = useMemo(() => {
    if (licenseTier !== 'A') return LANGUAGES
    return LANGUAGES.filter((l) => isLanguageAllowedForTier(l.code, 'A'))
  }, [licenseTier])
  const targetLanguagesForUi = useMemo(() => {
    if (licenseTier !== 'A') return ALPHABET_LANGUAGES
    return ALPHABET_LANGUAGES.filter((l) => isLanguageAllowedForTier(l.code, 'A'))
  }, [licenseTier])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const unlock = () => {
      serverAudioPlaybackUnlocked = true
      pumpServerTtsQueue()
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])
  
  // Message list
  const [messages, setMessages] = useState<Message[]>([])
  
  // Live interim text
  const [liveInterimText, setLiveInterimText] = useState('') // counselor live interim text
  const [remoteInterimText, setRemoteInterimText] = useState('') // client live interim text
  const [liveSpeechLevel, setLiveSpeechLevel] = useState(0)
  const [remoteSpeechLevel, setRemoteSpeechLevel] = useState(0)
  const [liveFinalizingBubbles, setLiveFinalizingBubbles] = useState<FinalizingBubble[]>([])
  const [remoteFinalizingBubbles, setRemoteFinalizingBubbles] = useState<FinalizingBubble[]>([])
  const [liveListeningPendingFinalizing, setLiveListeningPendingFinalizing] = useState(false)
  const [remoteListeningPendingFinalizing, setRemoteListeningPendingFinalizing] = useState(false)

  // Recording state
  const [isRecording, setIsRecording] = useState(false)
  const [recordingStatus, setRecordingStatus] = useState('')

  // WebSocket connection state
  const [isConnected, setIsConnected] = useState(false)
  const [showNetworkStatus, setShowNetworkStatus] = useState(false)
  const [networkDiagnostic, setNetworkDiagnostic] = useState<NetworkDiagnosticState>({
    rttCurrentMs: null,
    rttAvgMs: null,
    rttP95Ms: null,
    reconnectRecent5m: 0,
    updatedAtMs: null,
  })
  const wsRef = useRef<WebSocketService | null>(null)
  const recordStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null)
  const audioStreamRequestIdRef = useRef<number | null>(null)
  const audioKeepAliveTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastAudioChunkSentAtRef = useRef(0)
  const lastVoiceDetectedAtRef = useRef(0)
  const noiseFloorRmsRef = useRef(0.004)
  const noiseCalibrationUntilRef = useRef(0)
  const speechFrameCountRef = useRef(0)
  const localSpeakingStateRef = useRef(false)
  const localSpeakingStateSentAtRef = useRef(0)
  const localSpeechLevelRef = useRef(0)
  const remoteSpeechLevelRef = useRef(0)
  const liveSpeechLevelMovedAtRef = useRef(0)
  const remoteSpeechLevelMovedAtRef = useRef(0)
  const localLastSpeechAtRef = useRef(0)
  const speakingStateByRoleRef = useRef<{ counselor: boolean; client: boolean }>({
    counselor: false,
    client: false,
  })
  const speakingLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectEventsRef = useRef<number[]>([])

  // 상대방 녹음 상태 (녹음 버튼 ON/OFF 기반 상호 차단)
  const remoteRecordingRef = useRef(false)        // 오디오 차단 판정용 (클로저 없이 최신값 참조)
  const [remoteRecording, setRemoteRecording] = useState(false)  // UI 반영용
  
  // URL session ID (prevents hydration errors)
  const [urlSessionId, setUrlSessionId] = useState('')
  const [isMounted, setIsMounted] = useState(false)
  const sessionIdRef = useRef('')

  // Font size
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [audioInputDevices, setAudioInputDevices] = useState<ManagedAudioInputOption[]>([])
  const [audioInputDevicesLoaded, setAudioInputDevicesLoaded] = useState(false)
  const [counselorMicDeviceId, setCounselorMicDeviceId] = useState(() => getStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY))
  const [clientMicDeviceId, setClientMicDeviceId] = useState(() => getStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY))
  const [clientReportedAudioInputDevices, setClientReportedAudioInputDevices] = useState<ManagedAudioInputOption[]>([])
  const [clientMicAssignmentNotice, setClientMicAssignmentNotice] = useState('')
  const [clientMicTestNotice, setClientMicTestNotice] = useState('')
  const [clientMicTestLevel, setClientMicTestLevel] = useState(0)
  const [clientMicTestingDeviceId, setClientMicTestingDeviceId] = useState<string | null>(null)
  const audioInputDevicesRef = useRef<ManagedAudioInputOption[]>([])
  const counselorMicDeviceIdRef = useRef(counselorMicDeviceId)
  const clientMicDeviceIdRef = useRef(clientMicDeviceId)
  const counselorMicManualOverrideRef = useRef(false)
  const clientLocalMicManualOverrideRef = useRef(false)
  const clientMicManualOverrideRef = useRef(false)
  const clientMicTestRunIdRef = useRef(0)
  const clientMicTestStaleTimerRef = useRef<NodeJS.Timeout | null>(null)
  // 첫 실행 시 마이크 선택 모달 표시 여부 (이름 자동 매칭 실패 + 2개 이상일 때)
  const [showMicSetup, setShowMicSetup] = useState(false)

  useEffect(() => {
    audioInputDevicesRef.current = audioInputDevices
  }, [audioInputDevices])

  useEffect(() => {
    counselorMicDeviceIdRef.current = counselorMicDeviceId
  }, [counselorMicDeviceId])

  useEffect(() => {
    clientMicDeviceIdRef.current = clientMicDeviceId
  }, [clientMicDeviceId])

  useEffect(() => {
    return () => {
      if (clientMicTestStaleTimerRef.current) {
        clearTimeout(clientMicTestStaleTimerRef.current)
        clientMicTestStaleTimerRef.current = null
      }
    }
  }, [])

  const updateLiveSpeechLevel = useCallback((next: number, nowMs = Date.now()) => {
    const clamped = Math.max(0, Math.min(1, Number(next) || 0))
    localSpeechLevelRef.current = clamped
    if (clamped <= 0.0001) {
      liveSpeechLevelMovedAtRef.current = 0
      setLiveSpeechLevel(0)
      return
    }
    setLiveSpeechLevel((prev) => {
      if (prev <= 0.02 || Math.abs(clamped - prev) >= 0.02) {
        liveSpeechLevelMovedAtRef.current = nowMs
      }
      return clamped
    })
  }, [])

  const updateRemoteSpeechLevel = useCallback((next: number, nowMs = Date.now()) => {
    const clamped = Math.max(0, Math.min(1, Number(next) || 0))
    remoteSpeechLevelRef.current = clamped
    if (clamped <= 0.0001) {
      remoteSpeechLevelMovedAtRef.current = 0
      setRemoteSpeechLevel(0)
      return
    }
    setRemoteSpeechLevel((prev) => {
      if (prev <= 0.02 || Math.abs(clamped - prev) >= 0.02) {
        remoteSpeechLevelMovedAtRef.current = nowMs
      }
      return clamped
    })
  }, [])

  const classifyNetworkQuality = useCallback((rttAvgMs: number | null, rttP95Ms: number | null) => {
    const probe = rttP95Ms ?? rttAvgMs
    if (probe == null) return '확인 필요'
    if (probe <= 10) return '매우 좋음'
    if (probe <= 30) return '좋음'
    if (probe <= 50) return '보통'
    if (probe < 100) return '나쁨'
    return '매우 나쁨'
  }, [])

  const sendClientDeviceInventory = useCallback((devices: ManagedAudioInputOption[]) => {
    if (roleRef.current !== 'client') return
    if (!wsRef.current?.isConnected()) return
    const inventory = withDisplayLabels(devices).map((device) => ({
      device_id: device.deviceId,
      device_label: device.label,
      display_label: device.displayLabel || device.label,
      group_id: device.groupId || '',
      is_default_like: Boolean(device.isDefaultLike),
    }))
    wsRef.current.sendMessage({
      type: 'device_inventory',
      devices: inventory,
      captured_at_ms: Date.now(),
    })
  }, [])

  const runClientMicSelfTest = useCallback(async (
    deviceId: string,
    onLevel?: (level: number) => void,
  ) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    })
    let audioContext: AudioContext | null = null
    try {
      audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)
      let peakRms = 0
      const startedAt = Date.now()
      while ((Date.now() - startedAt) < 2200) {
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i += 1) {
          const sample = buffer[i]
          sum += sample * sample
        }
        const rms = Math.sqrt(sum / buffer.length)
        peakRms = Math.max(peakRms, rms)
        const normalized = Math.max(0, Math.min(1, rms * 16))
        onLevel?.(normalized)
        await new Promise((resolve) => setTimeout(resolve, 90))
      }
      source.disconnect()
      analyser.disconnect()
      return { peakRms }
    } finally {
      stream.getTracks().forEach((track) => track.stop())
      if (audioContext) {
        await audioContext.close().catch(() => {})
      }
    }
  }, [])

  const displayAudioInputDevices = useMemo(
    () => audioInputDevices.map((device) => ({
      deviceId: device.deviceId,
      label: device.displayLabel || device.label,
    })),
    [audioInputDevices],
  )

  const clientDisplayDevicesForCounselor = useMemo(() => {
    return clientReportedAudioInputDevices.map((device) => {
      const base = getDeviceLabelBase(device.label)
      return {
        ...device,
        displayLabel: device.displayLabel || base,
      }
    })
  }, [clientReportedAudioInputDevices])

  // Client TTS enabled state
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const ttsEnabledRef = useRef(false)
  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled
  }, [ttsEnabled])
  const [clientTtsEnabled, setClientTtsEnabled] = useState(false)
  const [chatInputEnabled, setChatInputEnabled] = useState(true)

  // 상담자 화면: 최초 채팅 설정 모달 / 사이드바 설정으로 동일 모달 재오픈
  const [hasSeenInitialCounselorModal, setHasSeenInitialCounselorModal] = useState(false)
  const [counselorSettingsFromSidebar, setCounselorSettingsFromSidebar] = useState(false)

  // 채팅 DB 저장 여부 (채팅방별, 상담자 설정 모달에서 토글). 채팅방 id -> true면 저장, false면 해당 방만 저장 안 함
  const [chatSaveEnabledByRoom, setChatSaveEnabledByRoom] = useState<Record<number, boolean>>({})

  // 도메인 설정 (bank/hospital)
  const [currentDomain, setCurrentDomain] = useState('bank')
  const [wordDictOpen, setWordDictOpen] = useState(false)
  const currentRoomSaveEnabledRef = useRef(true)

  // Chat session list
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([])
  const [activeChatId, setActiveChatId] = useState<number | null>(null)
  const activeChatIdRef = useRef<number | null>(null)
  const savedMessageCountRef = useRef(0) // number of saved messages
  const loadChatSessionsRef = useRef<(sessionId: string) => Promise<{ id: number }[]>>(async () => [])
  const stopRecordingAudioRef = useRef<(manual?: boolean) => void>(() => {})
  useEffect(() => {
    activeChatIdRef.current = activeChatId
  }, [activeChatId])

  // 현재 채팅방의 저장 여부 ref (saveChatMessage 등에서 사용)
  useEffect(() => {
    const enabled = activeChatId != null ? (chatSaveEnabledByRoom[activeChatId] !== false) : true
    currentRoomSaveEnabledRef.current = enabled
  }, [activeChatId, chatSaveEnabledByRoom])

  // STT result
  const finalTranscriptRef = useRef('')
  const liveInterimTextRef = useRef('') // interim text ref
  const remoteInterimTextRef = useRef('') // 상대방 interim 텍스트 ref (클로저 없이 최신값 참조)
  const localBrowserInterimUpdatedAtRef = useRef(0)
  const remoteBrowserInterimUpdatedAtRef = useRef(0)
  const commitTimerRef = useRef<NodeJS.Timeout | null>(null)
  const latestRequestIdRef = useRef(0)
  const isRecordingRef = useRef(false)
  // 사용자가 수동으로 마이크를 중지했을 때 auto-restart를 억제하는 플래그
  // 초기값 true: 앱 시작 시 마이크는 꺼진 상태, 버튼을 누를 때만 켜짐
  const manuallyStoppedRef = useRef(true)
  const processedMessageIds = useRef(new Set<string>()) // processed message ID set
  const recentTranslationKeysRef = useRef(new Map<string, number>()) // 최근 번역 메시지 dedupe
  // 번역 결과가 늦게 도착할 때를 대비한 폴백 커밋 타이머
  const pendingFallbackCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 상담원용 fallback: 상대방(피상담자) interim 텍스트가 3초간 갱신되지 않으면 강제 번역
  const remoteInterimFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const roomLeakStatsRef = useRef<{
    total: number
    accepted: number
    dropped: number
    missing: number
    byType: Record<string, { accepted: number; dropped: number; missing: number }>
    lastSummaryAt: number
  }>({
    total: 0,
    accepted: 0,
    dropped: 0,
    missing: 0,
    byType: {},
    lastSummaryAt: 0,
  })

  // Sync isRecording state
  useEffect(() => {
    isRecordingRef.current = isRecording
  }, [isRecording])

  useEffect(() => {
    const timer = setInterval(() => {
      const nowMs = Date.now()
      if (
        localSpeechLevelRef.current > 0.02 &&
        liveSpeechLevelMovedAtRef.current > 0 &&
        (nowMs - liveSpeechLevelMovedAtRef.current) >= SPEECH_LEVEL_STALE_MS
      ) {
        updateLiveSpeechLevel(0, nowMs)
      }
      if (
        remoteSpeechLevelRef.current > 0.02 &&
        remoteSpeechLevelMovedAtRef.current > 0 &&
        (nowMs - remoteSpeechLevelMovedAtRef.current) >= SPEECH_LEVEL_STALE_MS
      ) {
        updateRemoteSpeechLevel(0, nowMs)
      }
    }, 200)
    return () => clearInterval(timer)
  }, [updateLiveSpeechLevel, updateRemoteSpeechLevel])

  useEffect(() => {
    return () => {
      if (speakingLockTimerRef.current) {
        clearTimeout(speakingLockTimerRef.current)
        speakingLockTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    screenRef.current = screen
  }, [screen])

  // 항상 켜짐 마이크: 준비 조건이 충족되면 자동 시작, 끊기면 자동 재시작
  // 단, 사용자가 수동으로 중지한 경우는 재시작하지 않음
  useEffect(() => {
    const counselorReady = screen === 'counselor' && activeChatId != null && isConnected
    const clientReady   = screen === 'client'    && clientLang != null   && isConnected
    if (!counselorReady && !clientReady) return
    if (isRecording) return
    if (manuallyStoppedRef.current) return  // 수동 중지 시 auto-restart 억제

    const timer = setTimeout(() => {
      if (!isRecordingRef.current && !manuallyStoppedRef.current) {
        startRecordingAudio()
      }
    }, 500)

    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, activeChatId, clientLang, isConnected, isRecording])

  // Sync role state (fix closure issue)
  useEffect(() => {
    roleRef.current = role
    console.log('role state changed:', role)
  }, [role])

  // Font size: restore from localStorage on mount
  useEffect(() => {
    setFontSize(getStoredFontSize())
  }, [])

  useEffect(() => {
    if (screen !== 'counselor' && screen !== 'client') return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return

    let cancelled = false
    setAudioInputDevicesLoaded(false)

    const mapAudioInputDevices = (devices: MediaDeviceInfo[]): ManagedAudioInputOption[] => {
      const audioInputs = devices.filter((device) => device.kind === 'audioinput')
      const concreteInputs = audioInputs.filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
      const visibleInputs = concreteInputs.length > 0 ? concreteInputs : audioInputs
      const mapped = visibleInputs.map((device, index) => {
        const mapped: ManagedAudioInputOption = {
          deviceId: device.deviceId,
          label: device.label || `마이크 ${index + 1}`,
          groupId: device.groupId || '',
        }
        mapped.isDefaultLike = isDefaultLikeAudioInput(mapped)
        return mapped
      })
      return withDisplayLabels(mapped)
    }

    const loadAudioInputDevices = async () => {
      try {
        let devices = await navigator.mediaDevices.enumerateDevices()
        const hasHiddenLabels = devices.some((device) => device.kind === 'audioinput' && !device.label)

        if (hasHiddenLabels && navigator.mediaDevices.getUserMedia) {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          try {
            devices = await navigator.mediaDevices.enumerateDevices()
          } finally {
            tempStream.getTracks().forEach((track) => track.stop())
          }
        }

        if (!cancelled) {
          const mappedDevices = mapAudioInputDevices(devices)
          setAudioInputDevices(mappedDevices)
          setAudioInputDevicesLoaded(true)

          if (screen === 'counselor') {
            // 상담원/피상담자 마이크 자동 배정 규칙
            // - 상담원: proton 포함 라벨 우선
            // - 피상담자: 고객이 보고한 장치 목록 기준으로 별도 자동 배정(useEffect) 수행
            if (mappedDevices.length > 0) {
              const currentCounselor = mappedDevices.find((d) => d.deviceId === counselorMicDeviceIdRef.current)
              if (counselorMicManualOverrideRef.current && currentCounselor) return

              const matchedCounselor = mappedDevices.find((d) =>
                includesAnyKeyword(d.label, COUNSELOR_BRAND_KEYWORDS),
              )
              if (matchedCounselor) {
                console.log(`[MicAutoSelect] 상담원(proton 우선): "${matchedCounselor.label}"`)
                if (counselorMicDeviceIdRef.current !== matchedCounselor.deviceId) {
                  setCounselorMicDeviceId(matchedCounselor.deviceId)
                }
                setStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY, matchedCounselor.deviceId)
                return
              }

              const storedCounselorId = getStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY)
              const preferredCounselorId = counselorMicDeviceIdRef.current || storedCounselorId
              const preferredCounselor = mappedDevices.find((d) => d.deviceId === preferredCounselorId)
              const fallbackCounselor = preferredCounselor ?? mappedDevices[0]
              if (fallbackCounselor) {
                console.log(`[MicAutoSelect] 상담원(fallback): "${fallbackCounselor.label}"`)
                if (counselorMicDeviceIdRef.current !== fallbackCounselor.deviceId) {
                  setCounselorMicDeviceId(fallbackCounselor.deviceId)
                }
                setStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY, fallbackCounselor.deviceId)
              }
            }
          }
          if (screen === 'client' && mappedDevices.length > 0) {
            const currentClientLocal = mappedDevices.find((d) => d.deviceId === clientMicDeviceIdRef.current)
            if (clientLocalMicManualOverrideRef.current && currentClientLocal) return

            const storedClientId = getStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY)
            const selectedClientLocal = pickPreferredClientMic(mappedDevices, storedClientId)
            if (selectedClientLocal) {
              console.log(`[MicAutoSelect][ClientLocal] 피상담자: "${selectedClientLocal.label}"`)
              if (clientMicDeviceIdRef.current !== selectedClientLocal.deviceId) {
                setClientMicDeviceId(selectedClientLocal.deviceId)
              }
              setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, selectedClientLocal.deviceId)
            }
          }
        }
      } catch (error) {
        console.warn('Failed to load audio input devices:', error)
        if (!cancelled) {
          setAudioInputDevices([])
          setAudioInputDevicesLoaded(true)
        }
      }
    }

    void loadAudioInputDevices()

    const handleDeviceChange = () => {
      void loadAudioInputDevices()
    }

    navigator.mediaDevices.addEventListener?.('devicechange', handleDeviceChange)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', handleDeviceChange)
    }
  }, [screen])

  useEffect(() => {
    if (screen !== 'counselor') return
    if (clientReportedAudioInputDevices.length === 0) return

    const storedClientId = getStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY)
    const currentSelected = clientReportedAudioInputDevices.find((device) => device.deviceId === clientMicDeviceId)
    // 상담원이 수동으로 선택한 고객 마이크는 자동 배정 로직이 다시 덮어쓰지 않는다.
    if (clientMicManualOverrideRef.current && currentSelected) return

    const shouldKeepCurrentSelection =
      Boolean(currentSelected) &&
      !includesAnyKeyword(currentSelected!.label, COUNSELOR_BRAND_KEYWORDS) &&
      !isDefaultLikeAudioInput(currentSelected!)
    if (shouldKeepCurrentSelection) return

    const preferredClient = pickPreferredClientMic(clientReportedAudioInputDevices, storedClientId)
    if (!preferredClient) return
    if (clientMicDeviceId === preferredClient.deviceId && storedClientId === preferredClient.deviceId) return

    console.log(`[MicAutoSelect][CounselorRemote] 피상담자: "${preferredClient.label}"`)
    setClientMicDeviceId(preferredClient.deviceId)
    setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, preferredClient.deviceId)

    if (wsRef.current?.isConnected()) {
      wsRef.current.sendMessage({
        type: 'mic_assignment_request',
        device_id: preferredClient.deviceId,
        device_label: preferredClient.label,
        display_label: preferredClient.displayLabel || preferredClient.label,
      })
    }
  }, [screen, clientReportedAudioInputDevices, clientMicDeviceId])

  useEffect(() => {
    if (!audioInputDevicesLoaded) return
    const availableDeviceIds = new Set(audioInputDevices.map((device) => device.deviceId))

    if (counselorMicDeviceId && !availableDeviceIds.has(counselorMicDeviceId)) {
      setCounselorMicDeviceId('')
      setStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY, '')
    }

    if (screen === 'client' && clientMicDeviceId && !availableDeviceIds.has(clientMicDeviceId)) {
      setClientMicDeviceId('')
      setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, '')
    }

    if (screen === 'counselor' && clientMicDeviceId && clientReportedAudioInputDevices.length > 0) {
      const reportedDeviceIds = new Set(clientReportedAudioInputDevices.map((device) => device.deviceId))
      if (!reportedDeviceIds.has(clientMicDeviceId)) {
        setClientMicDeviceId('')
        setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, '')
      }
    }
  }, [audioInputDevicesLoaded, audioInputDevices, counselorMicDeviceId, clientMicDeviceId, screen, clientReportedAudioInputDevices])

  useEffect(() => {
    if (!audioInputDevicesLoaded) return
    if (screen !== 'client') return
    if (!isConnected) return
    sendClientDeviceInventory(audioInputDevices)
  }, [audioInputDevicesLoaded, audioInputDevices, screen, isConnected, sendClientDeviceInventory])

  useEffect(() => {
    if (screen !== 'counselor') return
    if (!isConnected) return
    if (!wsRef.current?.isConnected()) return
    wsRef.current.sendMessage({ type: 'device_inventory_request' })
  }, [screen, isConnected])

  // Font size: persist only. Actual UI application is limited to chat-area components.
  useEffect(() => {
    setStoredFontSize(fontSize)
  }, [fontSize])

  // Sync language state (fix closure issue)
  useEffect(() => {
    counselorLangRef.current = counselorLang
    clientLangRef.current = clientLang
  }, [counselorLang, clientLang])

  const normalizeChatSessions = (items: any[]): ChatSession[] => {
    return (items || [])
      .map((c: any) => {
        const id = Number(c?.id)
        if (!Number.isFinite(id)) return null
        const roomNumber = c?.room_number != null ? Number(c.room_number) : undefined
        const rawTitle = c?.title != null ? String(c.title).trim() : ''
        const fallbackTitle = `세션 ${roomNumber ?? id}`
        return {
          id,
          room_number: Number.isFinite(roomNumber as number) ? roomNumber : undefined,
          title: rawTitle || fallbackTitle,
          created_at: c?.created_at ?? '',
          updated_at: c?.updated_at ?? '',
        } as ChatSession
      })
      .filter(Boolean) as ChatSession[]
  }

  // Load chat list when session ID is ready. Auto-create one chat if list is empty or fetch fails.
  useEffect(() => {
    if (!urlSessionId) return
    const init = async () => {
      let chats: any[] = []
      const res = await fetch(
        `${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(urlSessionId)}`
      ).catch(() => null)
      if (res?.ok) {
        const data = await res.json()
        chats = normalizeChatSessions(data.chats || [])
        setChatSessions(chats)
      }
      // Auto-create a chat if the list is empty or fetch failed
      if (chats.length === 0) {
        const createRes = await fetch(`${getApiBaseUrl()}/api/chats`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: urlSessionId }),
        }).catch(() => null)
        if (createRes?.ok) {
          const createData = await createRes.json()
          const firstId = createData.chat_id
          activeChatIdRef.current = firstId
          setActiveChatId(firstId)
          setChatSessions(normalizeChatSessions(createData.chats || []))
          savedMessageCountRef.current = 0
        }
      } else {
        const firstId = chats[0].id
        activeChatIdRef.current = firstId
        setActiveChatId(firstId)
        savedMessageCountRef.current = 0
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSessionId])

  // Sync interim text (fix closure issue)
  useEffect(() => {
    liveInterimTextRef.current = liveInterimText
  }, [liveInterimText])

  useEffect(() => {
    remoteInterimTextRef.current = remoteInterimText
  }, [remoteInterimText])

  const upsertFinalizingBubble = (
    bubbles: FinalizingBubble[],
    nextBubble: FinalizingBubble,
  ) => {
    const nextText = nextBubble.text.trim()
    if (!nextBubble.utteranceId || !nextText) return bubbles
    const existingIndex = bubbles.findIndex((bubble) => bubble.utteranceId === nextBubble.utteranceId)
    if (existingIndex >= 0) {
      const cloned = [...bubbles]
      cloned[existingIndex] = { ...cloned[existingIndex], text: nextText }
      return cloned
    }
    return [...bubbles, { utteranceId: nextBubble.utteranceId, text: nextText }]
  }

  const normalizeBubbleText = (value: string) => (
    (value || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '')
  )

  const isSameBubbleText = (left: string, right: string) => {
    const normalizedLeft = normalizeBubbleText(left)
    const normalizedRight = normalizeBubbleText(right)
    if (!normalizedLeft || !normalizedRight) return false
    return (
      normalizedLeft === normalizedRight ||
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)
    )
  }

  const isEquivalentBubbleText = (left: string, right: string) => {
    const normalizedLeft = normalizeBubbleText(left)
    const normalizedRight = normalizeBubbleText(right)
    if (!normalizedLeft || !normalizedRight) return false
    return normalizedLeft === normalizedRight
  }

  const addFinalizingBubble = (
    scope: 'local' | 'remote',
    utteranceId: string | null,
    text: string,
  ) => {
    const trimmed = text.trim()
    if (!utteranceId || !trimmed) return
    if (scope === 'local') {
      setLiveListeningPendingFinalizing(false)
      setLiveFinalizingBubbles((prev) => upsertFinalizingBubble(prev, { utteranceId, text: trimmed }))
      setLiveInterimText('')
      localBrowserInterimUpdatedAtRef.current = 0
      return
    }
    setRemoteListeningPendingFinalizing(false)
    setRemoteFinalizingBubbles((prev) => upsertFinalizingBubble(prev, { utteranceId, text: trimmed }))
    setRemoteInterimText('')
    remoteBrowserInterimUpdatedAtRef.current = 0
  }

  const clearCompletedBubble = (scope: 'local' | 'remote', utteranceId?: string | null) => {
    const clearMatching = (bubbles: FinalizingBubble[]) => {
      if (!utteranceId) return []
      return bubbles.filter((bubble) => bubble.utteranceId !== utteranceId)
    }
    if (scope === 'local') {
      setLiveFinalizingBubbles((prev) => clearMatching(prev))
      setLiveInterimText((prev) => (utteranceId ? prev : ''))
      return
    }
    setRemoteFinalizingBubbles((prev) => clearMatching(prev))
    setRemoteInterimText((prev) => (utteranceId ? prev : ''))
  }

  const clearDedupedBubble = (scope: 'local' | 'remote', text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const clearMatching = (bubbles: FinalizingBubble[]) => (
      bubbles.filter((bubble) => !isSameBubbleText(bubble.text, trimmed))
    )
    if (scope === 'local') {
      setLiveListeningPendingFinalizing(false)
      setLiveFinalizingBubbles((prev) => clearMatching(prev))
      if (isSameBubbleText(liveInterimTextRef.current, trimmed)) {
        setLiveInterimText('')
        localBrowserInterimUpdatedAtRef.current = 0
      }
      return
    }
    setRemoteListeningPendingFinalizing(false)
    setRemoteFinalizingBubbles((prev) => clearMatching(prev))
    if (isSameBubbleText(remoteInterimTextRef.current, trimmed)) {
      setRemoteInterimText('')
      remoteBrowserInterimUpdatedAtRef.current = 0
    }
  }

  const clearRoomScopedRuntimeState = () => {
    if (pendingFallbackCommitTimerRef.current) {
      clearTimeout(pendingFallbackCommitTimerRef.current)
      pendingFallbackCommitTimerRef.current = null
    }
    if (remoteInterimFallbackTimerRef.current) {
      clearTimeout(remoteInterimFallbackTimerRef.current)
      remoteInterimFallbackTimerRef.current = null
    }
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    localBrowserInterimUpdatedAtRef.current = 0
    remoteBrowserInterimUpdatedAtRef.current = 0
    updateLiveSpeechLevel(0)
    updateRemoteSpeechLevel(0)
    setLiveInterimText('')
    setRemoteInterimText('')
    setLiveFinalizingBubbles([])
    setRemoteFinalizingBubbles([])
    setLiveListeningPendingFinalizing(false)
    setRemoteListeningPendingFinalizing(false)
    if (speakingLockTimerRef.current) {
      clearTimeout(speakingLockTimerRef.current)
      speakingLockTimerRef.current = null
    }
    remoteRecordingRef.current = false
    setRemoteRecording(false)
    setRecordingStatus('')
    processedMessageIds.current.clear()
    recentTranslationKeysRef.current.clear()
  }

  const applySpeakerLock = (
    lockOwnerRaw: unknown,
    lockExpiresAtMsRaw: unknown,
  ) => {
    const lockOwner = typeof lockOwnerRaw === 'string' && lockOwnerRaw.trim()
      ? lockOwnerRaw.trim()
      : null
    const lockExpiresAtMs = typeof lockExpiresAtMsRaw === 'number'
      ? lockExpiresAtMsRaw
      : Number(lockExpiresAtMsRaw)
    const now = Date.now()
    const lockStillValid =
      lockOwner != null &&
      Number.isFinite(lockExpiresAtMs) &&
      lockExpiresAtMs > now
    const currentRole = roleRef.current
    // role 값이 아직 준비되지 않은 타이밍에서는 업링크를 차단하지 않는다.
    // (자기 발화 시작 직후 null 레이스로 self-block 되는 케이스 방지)
    const shouldBlock = Boolean(lockStillValid && currentRole && lockOwner !== currentRole)
    remoteRecordingRef.current = shouldBlock
    setRemoteRecording(shouldBlock)

    if (speakingLockTimerRef.current) {
      clearTimeout(speakingLockTimerRef.current)
      speakingLockTimerRef.current = null
    }
    if (lockStillValid) {
      const delayMs = Math.max(40, Math.min(3000, lockExpiresAtMs - now + 40))
      speakingLockTimerRef.current = setTimeout(() => {
        remoteRecordingRef.current = false
        setRemoteRecording(false)
        speakingLockTimerRef.current = null
      }, delayMs)
    }
  }

  const trackRoomScopedEvent = (
    eventType: string,
    chatIdRaw: unknown,
    accepted: boolean,
    reason: 'matched' | 'chat_mismatch' | 'missing_chat_id',
  ) => {
    const stats = roomLeakStatsRef.current
    const typeStats = stats.byType[eventType] ?? { accepted: 0, dropped: 0, missing: 0 }
    if (accepted) {
      typeStats.accepted += 1
      stats.accepted += 1
    } else {
      typeStats.dropped += 1
      stats.dropped += 1
    }
    if (reason === 'missing_chat_id') {
      typeStats.missing += 1
      stats.missing += 1
    }
    stats.byType[eventType] = typeStats
    stats.total += 1

    if (ROOM_LEAK_DEBUG && typeof window !== 'undefined') {
      ;(window as any).__qsttRoomLeakStats = stats
      const now = Date.now()
      const shouldLogSummary =
        !accepted ||
        reason === 'missing_chat_id' ||
        (now - stats.lastSummaryAt) >= 10000
      if (shouldLogSummary) {
        stats.lastSummaryAt = now
        console.info('[room-scope-check]', {
          eventType,
          accepted,
          reason,
          chat_id: chatIdRaw ?? null,
          active_chat_id: activeChatIdRef.current,
          total: stats.total,
          dropped: stats.dropped,
          missing: stats.missing,
        })
      }
    }
  }

  // URL params update helper
  const updateUrlParams = (role: string) => {
    if (typeof window === 'undefined') return
    
    const urlParams = new URLSearchParams(window.location.search)
    urlParams.set('session', sessionIdRef.current)
    urlParams.set('role', role)
    const newUrl = `${window.location.pathname}?${urlParams.toString()}`
    window.history.replaceState({}, '', newUrl)
    console.log('URL updated:', newUrl)
  }

  // Initialize session ID on client mount (prevents hydration errors)
  useEffect(() => {
    setIsMounted(true)
    
    if (typeof window === 'undefined') return
    
    // Initialize session ID
    const urlParams = new URLSearchParams(window.location.search)
    let sessionId = urlParams.get('session')
    
    if (!sessionId) {
      // Create a new session ID and update URL
      // sessionId = `session-${Date.now()}`
      sessionId = 'translator' // (임시) 고정 세션 ID
      const newUrl = `${window.location.pathname}?session=${sessionId}`
      window.history.replaceState({}, '', newUrl)
    }
    
    console.log('Session ID:', sessionId)
    setUrlSessionId(sessionId)
    sessionIdRef.current = sessionId
    
    // Restore role from URL (on page refresh)
    const urlRole = urlParams.get('role')
    if (urlRole && (urlRole === 'counselor' || urlRole === 'client')) {
      console.log('Restoring role from URL:', urlRole)
      setRole(urlRole)
      setScreen(urlRole)
    }
  }, []) // run once on mount

  // WebSocket initialization
  useEffect(() => {
    if (typeof window === 'undefined' || !isMounted || !urlSessionId) return
    
    // Build WebSocket URL dynamically based on current host
    const getWebSocketUrl = () => {
      // Use env variable if available
      if (process.env.NEXT_PUBLIC_WS_URL) {
        return `${process.env.NEXT_PUBLIC_WS_URL}/ws/${sessionIdRef.current}`
      }
      
      // Fall back to current page host
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.hostname
      const port = '8001'
      return `${protocol}//${host}:${port}/ws/${sessionIdRef.current}`
    }
    
    const wsUrl = getWebSocketUrl()
    console.log('WebSocket URL:', wsUrl)
    const ws = new WebSocketService(wsUrl)

    ws.onOpen(() => {
      console.log('WebSocket connected | role:', roleRef.current, '| session:', sessionIdRef.current)
      setIsConnected(true)
    })

    ws.onClose(() => {
      console.error('WebSocket disconnected | role:', roleRef.current, '| session:', sessionIdRef.current)
      setIsConnected(false)
    })

    ws.onError((error) => {
      console.error('WebSocket error | role:', roleRef.current, '| error:', error)
    })

    ws.onLatency((snapshot) => {
      setNetworkDiagnostic((prev) => ({
        ...prev,
        rttCurrentMs: snapshot.currentMs,
        rttAvgMs: snapshot.avgMs,
        rttP95Ms: snapshot.p95Ms,
        updatedAtMs: Date.now(),
      }))
    })

    ws.onReconnect((snapshot) => {
      const now = snapshot.atMs
      const recent = [...reconnectEventsRef.current, now].filter((ts) => (now - ts) <= 5 * 60 * 1000)
      reconnectEventsRef.current = recent
      setNetworkDiagnostic((prev) => ({
        ...prev,
        reconnectRecent5m: recent.length,
        updatedAtMs: now,
      }))
    })
    
    // Start WebSocket connection
    ws.connect()

    ws.onMessage((data) => {
      console.log('Message received:', data.type, '| current role:', roleRef.current)

      // resetCounselorInterimFallback 제거:
      // 항상 켜짐 마이크 + GCP single_utterance=false 구조에서는
      // GCP가 발화 종료를 감지해 final 결과를 자연스럽게 반환한다.
      // 폴백이 GCP 최종 결과보다 먼저 텍스트를 전송하면 동일 발화가 두 번 번역되어
      // 중복 버블이 생기므로 제거한다.
      const resetCounselorInterimFallback = () => { /* no-op */ }

      // 서버 에러 수신 시 사용자에게 표시
      if (data.type === 'error') {
        const msg = typeof data.message === 'string' ? data.message : '메시지 전송 중 오류가 발생했습니다.'
        console.error('WebSocket error from server:', msg)
        alert(msg)
        return
      }
      
      // Translation complete
      if (data.type === 'translation_complete') {
        const {
          original,
          translated,
          source_lang,
          target_lang,
          request_id,
          sender,
          message_id,
          utterance_id: utteranceId,
        } = data
        
        console.log('Message detail:', { request_id, sender, message_id, original: original?.substring(0, 30) })
        
        // 중복 메시지 판정: 서버가 발급한 message_id(UUID) 기준으로만 판단
        // → 같은 문장을 다시 말해도 새 UUID가 발급되므로 정상 처리됨
        // → WebSocket 재연결/재전송으로 동일 메시지가 두 번 오는 경우만 차단
        const dedupeKey = message_id ?? `${request_id}-${sender}-${original}`
        if (processedMessageIds.current.has(dedupeKey)) {
          console.log('Duplicate message ignored:', dedupeKey)
          return
        }
        processedMessageIds.current.add(dedupeKey)
        console.log('Message ID added:', dedupeKey)
        
        // Keep only last 200 processed message IDs (memory management)
        if (processedMessageIds.current.size > 200) {
          const firstId = Array.from(processedMessageIds.current)[0]
          processedMessageIds.current.delete(firstId)
        }
        
        // 중복 방지는 message_id(UUID) 기반 dedup으로 충분.
        // request_id 기반 stale 체크 제거: finish_stream 지연 시 유효한 번역이 필터링되는 버그 방지.
        
        console.log(`Translation complete:`)
        console.log(`   - Original (${source_lang}): "${original}"`)
        console.log(`   - Translated (${target_lang}): "${translated}"`)
        console.log(`   - Sender: ${sender}`)
        
        // Ignore if role is not set yet (role selection not done)
        if (!roleRef.current) {
          console.error('role not set, ignoring message. role:', roleRef.current, 'screen:', screen)
          return
        }
        
        // If this message belongs to a different chat room, save to DB only (don't display)
        const messageChatId = data.chat_id != null ? Number(data.chat_id) : null
        const currentChatId = activeChatIdRef.current
        const messageSender = sender || 'counselor'
        if (messageChatId == null) {
          trackRoomScopedEvent('translation_complete', data.chat_id, true, 'missing_chat_id')
        } else if (currentChatId == null || messageChatId !== currentChatId) {
          trackRoomScopedEvent('translation_complete', data.chat_id, false, 'chat_mismatch')
          // Different room: only sender saves to DB (to avoid duplicate saves)
          if (messageSender === roleRef.current) {
            saveChatMessage(messageSender, request_id, original ?? '', translated ?? null, source_lang, target_lang, messageChatId)
          }
          return
        } else {
          trackRoomScopedEvent('translation_complete', data.chat_id, true, 'matched')
        }
        // message_id가 매번 달라도, 동일 발화가 아주 짧은 간격으로 중복 수신되면 UI 버블 중복을 막는다.
        // (stream end/fallback 경계에서 동일 translation_complete가 2회 오는 케이스 방어)
        const nowMs = Date.now()
        const dedupeWindowMs = 15000
        const utterancePart = typeof utteranceId === 'string' && utteranceId.trim()
          ? utteranceId.trim()
          : '-'
        const normalizedOriginal = normalizeBubbleText(String(original ?? ''))
        const normalizedTranslated = normalizeBubbleText(String(translated ?? ''))
        const semanticKey = [
          String(messageChatId ?? '-'),
          messageSender,
          String(request_id ?? '-'),
          utterancePart,
          normalizedOriginal,
          normalizedTranslated,
        ].join('|')
        const recentMap = recentTranslationKeysRef.current
        for (const [key, ts] of recentMap) {
          if (nowMs - ts > dedupeWindowMs) recentMap.delete(key)
        }
        if (recentMap.has(semanticKey)) {
          console.log('Duplicate translation bubble ignored:', semanticKey)
          return
        }
        recentMap.set(semanticKey, nowMs)
        
        // Display in own language only
        // - My message: original text
        // - Other's message: translated text (fall back to original if missing)
        let textToShow = messageSender === roleRef.current
          ? (original ?? '')
          : (translated ?? original ?? '')

        // 피상담자 언어 선택 직후 자동 안내 문구는 번역문 + 원문 확인용을 한 버블에 함께 표시
        const isClientWelcomePreview =
          roleRef.current === 'client' &&
          messageSender === 'counselor' &&
          typeof translated === 'string' &&
          translated.trim().length > 0 &&
          typeof original === 'string' &&
          original.trim() === DEFAULT_COUNSELOR_WELCOME_KO.trim()
        if (isClientWelcomePreview) {
          textToShow = `${translated}\n${original}`
        }
        
        console.log(`Message display logic:`)
        console.log(`   - Current role (Ref): ${roleRef.current}`)
        console.log(`   - Message sender: ${messageSender}`)
        console.log(`   - Is my message? ${messageSender === roleRef.current}`)
        console.log(`   - Text to show: "${textToShow}"`)
        console.log(`   - WebSocket connected: ${wsRef.current?.isConnected() ?? false}`)
        console.log(`   - original: "${original}"`)
        console.log(`   - translated: "${translated}"`)
        
        // Check current message count before adding
        console.log('Total messages before add:', messages.length)
        
        // Add message (in own language)
        const newMessage = {
          sender: messageSender,
          text: textToShow,
          timestamp: new Date().toISOString(),
        }
        
        console.log('Adding message:', newMessage)
        addMessage(newMessage)
        
        // Remove "other party is speaking..." bubble when their message is finalized (prevent duplicate bubbles)
        if (messageSender !== roleRef.current) {
          clearCompletedBubble('remote', typeof utteranceId === 'string' ? utteranceId : null)
          setRemoteInterimText('')
          setRemoteListeningPendingFinalizing(false)
          // 정상적으로 번역 결과가 도착했으므로 폴백 타이머 취소
          if (pendingFallbackCommitTimerRef.current) {
            clearTimeout(pendingFallbackCommitTimerRef.current)
            pendingFallbackCommitTimerRef.current = null
          }
          if (remoteInterimFallbackTimerRef.current) {
            clearTimeout(remoteInterimFallbackTimerRef.current)
            remoteInterimFallbackTimerRef.current = null
          }
        } else {
          clearCompletedBubble('local', typeof utteranceId === 'string' ? utteranceId : null)
          setLiveInterimText('')
          setLiveListeningPendingFinalizing(false)
        }
        
        // On client screen with TTS on: read out counselor's message (translated)
        if (roleRef.current === 'client' && messageSender === 'counselor' && translated && ttsEnabledRef.current) {
          const lang = clientLangRef.current || 'ko'
          if (data.tts_audio_base64) {
            playServerTtsAudio(data.tts_audio_base64, data.tts_mime_type || 'audio/mpeg')
          } else if (data.tts_pending) {
            // Server TTS will arrive as a separate `tts_audio` message.
          } else {
            speakWithTts(translated, getFullLangCode(lang))
          }
        }

        // Save message to DB: only sender saves once (both saving would cause duplicates when re-entering the room)
        if (messageSender === roleRef.current) {
          saveChatMessage(messageSender, request_id, original ?? '', translated ?? null, source_lang, target_lang)
        }
        
        console.log('Message added. Expected total:', messages.length + 1)
      }
      
      // Language selection notification (reflect the language selected by the other party in the same session)
      if (data.type === 'language_selected') {
        const { role: senderRole, language } = data
        console.log(`Language selection received: ${senderRole} -> ${language}`)
        
        // Client language -> reflect in counselor screen as "target language"
        if (senderRole === 'client' && roleRef.current === 'counselor') {
          console.log(`Client language applied: ${language}`)
          setClientLang(language)
          // target_lang이 바뀌었으므로 카운슬러 STT 세션 재시작
          if (isRecordingRef.current) {
            stopRecordingAudioRef.current()  // manual=false → auto-restart
          }
        }
        // Client language -> reflect in client screen (self-selected or proxy-selected by counselor)
        if (senderRole === 'client' && roleRef.current === 'client') {
          console.log(`Client (self) language applied: ${language}`)
          setClientLang(language)
          // 상담자가 고객 언어를 바꿀 때마다 고객 마이크 auto-start를 다시 허용한다.
          manuallyStoppedRef.current = false
        }
        // Counselor language -> reflect in client screen
        if (senderRole === 'counselor' && roleRef.current === 'client') {
          console.log(`Counselor language applied: ${language}`)
          setCounselorLang(language)
          // target_lang이 바뀌었으므로 클라이언트 STT 세션 재시작
          if (isRecordingRef.current) {
            stopRecordingAudioRef.current()  // manual=false → auto-restart
          }
        }
      }
      
      // Transcription event (real-time STT result)
      if (data.type === 'transcription') {
        const {
          text,
          sender,
          is_final,
          request_id: transcriptionRequestId,
          phase,
          utterance_id: utteranceId,
          chat_id: transcriptionChatIdRaw,
        } = data
        const transcriptionChatId = transcriptionChatIdRaw != null ? Number(transcriptionChatIdRaw) : null
        const currentChatId = activeChatIdRef.current
        if (transcriptionChatId != null) {
          if (currentChatId == null || transcriptionChatId !== currentChatId) {
            trackRoomScopedEvent('transcription', transcriptionChatIdRaw, false, 'chat_mismatch')
            return
          }
          trackRoomScopedEvent('transcription', transcriptionChatIdRaw, true, 'matched')
        } else {
          trackRoomScopedEvent('transcription', transcriptionChatIdRaw, true, 'missing_chat_id')
        }
        const transcript = typeof text === 'string' ? text : ''
        const trimmedTranscript = transcript.trim()
        const now = Date.now()
        const transcriptPhase = typeof phase === 'string'
          ? phase
          : (is_final ? 'finalizing' : 'interim')
        const localRole =
          roleRef.current ||
          (screenRef.current === 'counselor' ? 'counselor' : screenRef.current === 'client' ? 'client' : null)

        if (!localRole) {
          console.warn('transcription received before local role is ready:', { sender, screen: screenRef.current })
        } else if (sender === localRole) {
          if (transcriptPhase === 'deduped') {
            clearDedupedBubble('local', trimmedTranscript || transcript)
          } else if (transcriptPhase === 'finalizing') {
            addFinalizingBubble(
              'local',
              typeof utteranceId === 'string' ? utteranceId : null,
              trimmedTranscript || liveInterimTextRef.current || transcript,
            )
          } else if (isRecordingRef.current) {
            const activeRequestId = audioStreamRequestIdRef.current
            const requestMatches =
              activeRequestId == null ||
              transcriptionRequestId == null ||
              Number(transcriptionRequestId) === Number(activeRequestId)
            const shouldHoldSpeakingState =
              requestMatches &&
              trimmedTranscript.length > 0 &&
              !liveInterimTextRef.current.trim()
            if (shouldHoldSpeakingState) {
              localBrowserInterimUpdatedAtRef.current = now
              setLiveInterimText('')
            }
          }
        } else {
          if (transcriptPhase === 'deduped') {
            clearDedupedBubble('remote', trimmedTranscript || transcript)
          } else if (transcriptPhase === 'finalizing') {
            addFinalizingBubble(
              'remote',
              typeof utteranceId === 'string' ? utteranceId : null,
              trimmedTranscript || remoteInterimTextRef.current || transcript,
            )
          } else {
            const shouldHoldRemoteSpeakingState =
              trimmedTranscript.length > 0 &&
              !remoteInterimTextRef.current.trim()
            if (shouldHoldRemoteSpeakingState) {
              remoteBrowserInterimUpdatedAtRef.current = now
              setRemoteInterimText('')
            }
          }
          if (trimmedTranscript.length > 0) resetCounselorInterimFallback()
        }
      }

      if (data.type === 'tts_audio') {
        const { sender } = data
        const ttsChatId = data.chat_id != null ? Number(data.chat_id) : null
        const currentChatId = activeChatIdRef.current
        if (ttsChatId != null && (currentChatId == null || ttsChatId !== currentChatId)) {
          trackRoomScopedEvent('tts_audio', data.chat_id, false, 'chat_mismatch')
          return
        }
        if (ttsChatId == null) {
          trackRoomScopedEvent('tts_audio', data.chat_id, true, 'missing_chat_id')
        } else {
          trackRoomScopedEvent('tts_audio', data.chat_id, true, 'matched')
        }
        if (roleRef.current === 'client' && sender === 'counselor' && ttsEnabledRef.current) {
          if (data.tts_audio_base64) {
            playServerTtsAudio(data.tts_audio_base64, data.tts_mime_type || 'audio/mpeg')
          }
        }
      }

      if (data.type === 'interim_text') {
        const { text, sender } = data
        const source = typeof data.source === 'string' ? data.source : ''
        const interimChatId = data.chat_id != null ? Number(data.chat_id) : null
        const currentChatId = activeChatIdRef.current
        if (interimChatId != null && (currentChatId == null || interimChatId !== currentChatId)) {
          trackRoomScopedEvent('interim_text', data.chat_id, false, 'chat_mismatch')
          return
        }
        if (interimChatId == null) {
          trackRoomScopedEvent('interim_text', data.chat_id, true, 'missing_chat_id')
        } else {
          trackRoomScopedEvent('interim_text', data.chat_id, true, 'matched')
        }
        if (sender !== roleRef.current) {
          const trimmed = text != null ? String(text).trim() : ''
          if (trimmed.length > 0) {
            if (source === 'gcp_transcription') {
              remoteBrowserInterimUpdatedAtRef.current = Date.now()
              setRemoteInterimText('')
              resetCounselorInterimFallback()
            }
          }
        }
      }
      
      // 상대방 녹음 상태 수신 → 내 마이크 차단/해제
      if (data.type === 'speaking_state') {
        const { sender, is_speaking, lock_owner, lock_expires_at_ms } = data
        if (sender === 'counselor' || sender === 'client') {
          speakingStateByRoleRef.current[sender] = Boolean(is_speaking)
        }
        const speechLevel = Math.max(0, Math.min(1, Number(data.speech_level) || 0))
        const localRole = roleRef.current
        const isLocalSender = sender === localRole
        const speakingChatId = data.chat_id != null ? Number(data.chat_id) : null
        const currentChatId = activeChatIdRef.current
        if (speakingChatId != null && (currentChatId == null || speakingChatId !== currentChatId)) {
          trackRoomScopedEvent('speaking_state', data.chat_id, false, 'chat_mismatch')
          return
        }
        if (speakingChatId == null) {
          trackRoomScopedEvent('speaking_state', data.chat_id, true, 'missing_chat_id')
        } else {
          trackRoomScopedEvent('speaking_state', data.chat_id, true, 'matched')
        }
        // 내 speaking_state도 에코 수신되므로, STT 이벤트 전에 당사자 말하는 중 버블을 먼저 보여준다.
        if (isLocalSender) {
          if (is_speaking) {
            setLiveListeningPendingFinalizing(true)
            if (!liveInterimTextRef.current.trim()) {
              localBrowserInterimUpdatedAtRef.current = Date.now()
              setLiveInterimText('')
            }
            updateLiveSpeechLevel(speechLevel)
          } else {
            setLiveListeningPendingFinalizing(false)
            updateLiveSpeechLevel(0)
          }
        }
        if (!isLocalSender) {
          if (is_speaking) {
            setRemoteListeningPendingFinalizing(true)
            if (!remoteInterimTextRef.current.trim()) {
              remoteBrowserInterimUpdatedAtRef.current = Date.now()
              setRemoteInterimText('')
            }
            updateRemoteSpeechLevel(speechLevel)
          } else {
            setRemoteListeningPendingFinalizing(false)
            updateRemoteSpeechLevel(0)
          }
        }
        // speaking_state 수신 직후 즉시 차단 상태를 보정한다.
        // - 상대가 말하는 신호면 우선 차단
        // - 내가 말하는 신호면 self-block 금지
        if (is_speaking && !isLocalSender) {
          remoteRecordingRef.current = true
          setRemoteRecording(true)
        } else if (isLocalSender) {
          remoteRecordingRef.current = false
          setRemoteRecording(false)
        }
        // 서버 선점 락을 차단 기준으로 사용 (최근 선점자 우선).
        if (lock_owner != null || lock_expires_at_ms != null) {
          applySpeakerLock(lock_owner, lock_expires_at_ms)
          // lock_owner가 순간적으로 엇갈려도, 내 발화 신호에서는 self-block을 허용하지 않는다.
          if (is_speaking && isLocalSender) {
            remoteRecordingRef.current = false
            setRemoteRecording(false)
          }
        } else if (!isLocalSender) {
          // 구버전 서버와의 호환: lock 필드가 없으면 기존 동작으로 폴백
          remoteRecordingRef.current = Boolean(is_speaking)
          setRemoteRecording(Boolean(is_speaking))
        }

        if (localRole === 'client' && !isLocalSender && is_speaking) {
          if (pendingFallbackCommitTimerRef.current) {
            clearTimeout(pendingFallbackCommitTimerRef.current)
            pendingFallbackCommitTimerRef.current = null
          }
        }
      }

      if (data.type === 'device_inventory' && roleRef.current === 'counselor') {
        const rawDevices = Array.isArray(data.devices) ? data.devices : []
        const incoming = rawDevices
          .map((item): ManagedAudioInputOption | null => {
            const deviceId = typeof item?.device_id === 'string' ? item.device_id : ''
            if (!deviceId) return null
            const label = typeof item?.device_label === 'string' && item.device_label.trim()
              ? item.device_label
              : '마이크'
            const displayLabel = typeof item?.display_label === 'string' && item.display_label.trim()
              ? item.display_label
              : label
            const groupId = typeof item?.group_id === 'string' ? item.group_id : ''
            const isDefaultLike = Boolean(item?.is_default_like)
            return { deviceId, label, displayLabel, groupId, isDefaultLike }
          })
          .filter(Boolean) as ManagedAudioInputOption[]
        setClientReportedAudioInputDevices(incoming)
        const capturedAtMs = Number(data.captured_at_ms)
        const capturedAtLabel = Number.isFinite(capturedAtMs)
          ? new Date(capturedAtMs).toLocaleTimeString()
          : null
        setClientMicAssignmentNotice(
          incoming.length > 0
            ? `고객 장치 ${incoming.length}개 수신${capturedAtLabel ? ` (${capturedAtLabel})` : ''}`
            : '고객 장치 목록이 비어 있습니다.',
        )

        // 고객 화면이 재접속/새로고침된 경우, 상담원 화면의 현재 고객 마이크 선택을 다시 밀어 넣어 동기화한다.
        const selectedClientId = clientMicDeviceIdRef.current
        if (selectedClientId && wsRef.current?.isConnected()) {
          const selectedDevice = incoming.find((device) => device.deviceId === selectedClientId)
          if (selectedDevice) {
            wsRef.current.sendMessage({
              type: 'mic_assignment_request',
              device_id: selectedDevice.deviceId,
              device_label: selectedDevice.label,
              display_label: selectedDevice.displayLabel || selectedDevice.label,
            })
          }
        }
      }

      if (data.type === 'device_inventory_request' && roleRef.current === 'client') {
        sendClientDeviceInventory(audioInputDevicesRef.current)
      }

      // 상담원이 요청한 고객 마이크 적용 (고객 로컬 장치 기준)
      if (data.type === 'mic_assignment_request' && roleRef.current === 'client') {
        const requestedId = typeof data.device_id === 'string' ? data.device_id : ''
        const requestedLabel = typeof data.device_label === 'string' ? data.device_label : ''
        const requestedDisplayLabel = typeof data.display_label === 'string' ? data.display_label : requestedLabel
        const localDevices = audioInputDevicesRef.current
        const matched =
          localDevices.find((d) => d.deviceId === requestedId) ??
          localDevices.find((d) => d.label === requestedLabel) ??
          localDevices.find((d) => d.displayLabel === requestedDisplayLabel)
        if (!matched) {
          wsRef.current?.sendMessage({
            type: 'mic_assignment_ack',
            success: false,
            requested_device_id: requestedId,
            requested_device_label: requestedLabel,
            reason: 'device_not_found',
          })
          return
        }
        const verifyAndApply = async () => {
          try {
            const previousDeviceId = clientMicDeviceIdRef.current
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { deviceId: { exact: matched.deviceId } },
            })
            stream.getTracks().forEach((track) => track.stop())
            clientLocalMicManualOverrideRef.current = true
            setClientMicDeviceId(matched.deviceId)
            setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, matched.deviceId)
            if (
              previousDeviceId !== matched.deviceId &&
              isRecordingRef.current &&
              roleRef.current === 'client'
            ) {
              stopRecordingAudio(false)
            }
            wsRef.current?.sendMessage({
              type: 'mic_assignment_ack',
              success: true,
              requested_device_id: requestedId,
              requested_device_label: requestedLabel,
              final_device_id: matched.deviceId,
              final_device_label: matched.label,
              final_display_label: matched.displayLabel || matched.label,
            })
          } catch (error) {
            console.warn('[mic_assignment_request] apply failed:', error)
            wsRef.current?.sendMessage({
              type: 'mic_assignment_ack',
              success: false,
              requested_device_id: requestedId,
              requested_device_label: requestedLabel,
              reason: 'get_user_media_failed',
            })
          }
        }
        void verifyAndApply()
      }

      if (data.type === 'mic_assignment_ack' && roleRef.current === 'counselor') {
        const success = data.success === true
        const finalId = typeof data.final_device_id === 'string' ? data.final_device_id : ''
        const finalLabel = typeof data.final_display_label === 'string'
          ? data.final_display_label
          : (typeof data.final_device_label === 'string' ? data.final_device_label : '')
        if (success && finalId) {
          setClientMicDeviceId(finalId)
          setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, finalId)
          setClientMicAssignmentNotice(`적용 완료: ${finalLabel || finalId}`)
        } else {
          const reason = typeof data.reason === 'string' ? data.reason : 'unknown'
          setClientMicAssignmentNotice(`적용 실패: ${reason}`)
        }
      }

      if (data.type === 'mic_test_request' && roleRef.current === 'client') {
        const requestedId = typeof data.device_id === 'string' ? data.device_id : ''
        const requestedLabel = typeof data.device_label === 'string' ? data.device_label : ''
        const requestedDisplayLabel = typeof data.display_label === 'string' ? data.display_label : requestedLabel
        const localDevices = audioInputDevicesRef.current
        const matched =
          localDevices.find((d) => d.deviceId === requestedId) ??
          localDevices.find((d) => d.label === requestedLabel) ??
          localDevices.find((d) => d.displayLabel === requestedDisplayLabel)
        if (!matched) {
          wsRef.current?.sendMessage({
            type: 'mic_test_ack',
            success: false,
            requested_device_id: requestedId,
            requested_device_label: requestedLabel,
            reason: 'device_not_found',
          })
          return
        }
        const runId = ++clientMicTestRunIdRef.current
        const verify = async () => {
          try {
            const result = await runClientMicSelfTest(matched.deviceId, (level) => {
              if (runId !== clientMicTestRunIdRef.current) return
              wsRef.current?.sendMessage({
                type: 'mic_test_stream',
                requested_device_id: requestedId,
                requested_device_label: requestedLabel,
                final_device_id: matched.deviceId,
                final_device_label: matched.label,
                final_display_label: matched.displayLabel || matched.label,
                level: Number(level.toFixed(4)),
              })
            })
            if (runId !== clientMicTestRunIdRef.current) return
            wsRef.current?.sendMessage({
              type: 'mic_test_ack',
              success: true,
              requested_device_id: requestedId,
              requested_device_label: requestedLabel,
              final_device_id: matched.deviceId,
              final_device_label: matched.label,
              final_display_label: matched.displayLabel || matched.label,
              peak_rms: Number(result.peakRms.toFixed(5)),
            })
          } catch (error) {
            if (runId !== clientMicTestRunIdRef.current) return
            console.warn('[mic_test_request] failed:', error)
            wsRef.current?.sendMessage({
              type: 'mic_test_ack',
              success: false,
              requested_device_id: requestedId,
              requested_device_label: requestedLabel,
              reason: 'test_failed',
            })
          }
        }
        void verify()
      }

      if (data.type === 'mic_test_stream' && roleRef.current === 'counselor') {
        const finalId = typeof data.final_device_id === 'string' ? data.final_device_id : ''
        const level = Math.max(0, Math.min(1, Number(data.level) || 0))
        if (finalId) {
          setClientMicTestingDeviceId(finalId)
        }
        setClientMicTestLevel(level)
        if (clientMicTestStaleTimerRef.current) {
          clearTimeout(clientMicTestStaleTimerRef.current)
        }
        clientMicTestStaleTimerRef.current = setTimeout(() => {
          setClientMicTestingDeviceId(null)
          setClientMicTestLevel(0)
          clientMicTestStaleTimerRef.current = null
        }, 1200)
      }

      if (data.type === 'mic_test_ack' && roleRef.current === 'counselor') {
        const success = data.success === true
        if (!success) {
          const reason = typeof data.reason === 'string' ? data.reason : 'unknown'
          setClientMicTestNotice(`원격 테스트 실패: ${reason}`)
          setClientMicTestingDeviceId(null)
          setClientMicTestLevel(0)
          return
        }
        const label = typeof data.final_display_label === 'string'
          ? data.final_display_label
          : (typeof data.final_device_label === 'string' ? data.final_device_label : '')
        const peakRms = Number(data.peak_rms)
        const levelPct = Number.isFinite(peakRms)
          ? Math.max(0, Math.min(100, Math.round(peakRms * 1000)))
          : null
        const ackLevel = Number.isFinite(peakRms)
          ? Math.max(0, Math.min(1, peakRms * 16))
          : 0
        setClientMicTestNotice(
          levelPct != null
            ? `원격 테스트 성공: ${label || '마이크'} (입력레벨 ${levelPct}%)`
            : `원격 테스트 성공: ${label || '마이크'}`,
        )
        if (typeof data.final_device_id === 'string' && data.final_device_id) {
          setClientMicTestingDeviceId(data.final_device_id)
        }
        setClientMicTestLevel(ackLevel)
        if (clientMicTestStaleTimerRef.current) {
          clearTimeout(clientMicTestStaleTimerRef.current)
        }
        clientMicTestStaleTimerRef.current = setTimeout(() => {
          setClientMicTestingDeviceId(null)
          setClientMicTestLevel(0)
          clientMicTestStaleTimerRef.current = null
        }, 1800)
      }

      // 구버전 호환: mic_assignment 직접 적용
      if (data.type === 'mic_assignment' && roleRef.current === 'client') {
        const assignedId    = (data.device_id    as string | undefined) ?? ''
        const assignedLabel = (data.device_label as string | undefined) ?? ''
        // device_id 가 일치하는 장치가 있으면 그대로 사용,
        // 없으면 레이블로 재탐색 후 non-default 장치로 폴백한다.
        setAudioInputDevices((prev) => {
          const isDefaultLike = (device: ManagedAudioInputOption) => Boolean(device.isDefaultLike ?? isDefaultLikeAudioInput(device))
          const nonDefaultMatched = prev.find((d) => !isDefaultLike(d))
          const matched = prev.find((d) => d.deviceId === assignedId)
            ?? prev.find((d) => d.label === assignedLabel)
            ?? nonDefaultMatched
          const finalId = matched?.deviceId ?? assignedId
          const previousDeviceId = clientMicDeviceIdRef.current
          console.log(`[mic_assignment] 피상담자 마이크 수신: "${assignedLabel}" → ${finalId}`)
          clientLocalMicManualOverrideRef.current = true
          setClientMicDeviceId(finalId)
          setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, finalId)
          if (
            previousDeviceId !== finalId &&
            isRecordingRef.current &&
            roleRef.current === 'client'
          ) {
            stopRecordingAudio(false)
          }
          return prev  // 장치 목록 자체는 변경 없음
        })
      }
      if (data.type === 'mic_assignment' && roleRef.current === 'counselor') {
        const assignedId = (data.device_id as string | undefined) ?? ''
        const assignedLabel = (data.device_label as string | undefined) ?? ''
        const finalId = assignedId
        console.log(`[mic_assignment] 상담자 화면 고객 마이크 동기화: "${assignedLabel}" → ${finalId}`)
        clientMicManualOverrideRef.current = true
        setClientMicDeviceId(finalId)
        setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, finalId)
        setClientMicAssignmentNotice(`동기화됨: ${assignedLabel || finalId}`)
      }

      // Sync client TTS on/off (counselor toggles remotely, or client/counselor toggles locally)
      if (data.type === 'client_tts_set') {
        const enabled = data.enabled !== false
        if (roleRef.current === 'client') {
          setTtsEnabled(enabled)
        }
        if (roleRef.current === 'counselor') {
          setClientTtsEnabled(enabled)
        }
      }

      // Sync font size (counselor changes → both sides)
      if (data.type === 'font_size_set') {
        const size = typeof data.font_size === 'number' ? data.font_size : DEFAULT_FONT_SIZE
        setFontSize(size)
      }

      // Refresh chat list on both sides when a chat is added/removed
      if (data.type === 'chat_list_updated') {
        const sid = data.session_id ?? sessionIdRef.current
        const newChatId = data.chat_id != null ? Number(data.chat_id) : null
        if (sid) {
          loadChatSessionsRef.current(sid).then((chats) => {
            if (newChatId != null) {
              if (isRecordingRef.current) {
                stopRecordingAudioRef.current(true)  // manual=true → auto-restart 억제
              }
              clearRoomScopedRuntimeState()
              activeChatIdRef.current = newChatId
              setActiveChatId(newChatId)
              setMessages([])
              savedMessageCountRef.current = 0
              // 새 채팅방 생성 시 고객 언어 선택 상태 초기화(상담원/피상담자 동기화)
              clientLangRef.current = null
              setClientLangBeforeHome(null)
              setClientLang(null)
            } else if (chats?.length && activeChatIdRef.current != null && !chats.some((c: { id: number }) => c.id === activeChatIdRef.current)) {
              handleSelectChat(chats[0].id)
            }
          })
        }
      }
    })
    
    wsRef.current = ws

    return () => {
      ws.disconnect()
    }
  }, [isMounted, urlSessionId])


  const addMessage = (message: Message) => {
    setMessages(prev => [...prev, message])
  }

  // Detect sentence end
  const isSentenceEnd = (text: string) => {
    if (!text) return false
    const trimmed = text.trim()
    
    // Korean sentence-ending endings
    if (/[요다까](\.|\?|!|\s|$)/.test(trimmed.slice(-3))) return true
    
    // Punctuation
    if (/[.?!。？！]\s*$/.test(trimmed)) return true
    
    return false
  }

  // Get STT language code
  const getSTTLangCode = () => {
    const lang = role === 'counselor' ? counselorLang : clientLang
    return getFullLangCode(lang || 'ko')
  }

  // Notify language selection (notify other party) - sends as 'my' language based on role
  const notifyLanguageSelected = (language: string) => {
    if (!wsRef.current?.isConnected() || !roleRef.current) {
      console.log('Language notification failed: WebSocket not connected or role not set')
      return
    }
    console.log(`Language selection notification: ${roleRef.current} -> ${language}`)
    wsRef.current.sendMessage({
      type: 'language_selected',
      role: roleRef.current,
      language: language
    })
  }

  // Notify client language set (when counselor selects client language -> reflected in client tab)
  const notifyClientLanguageSet = (language: string) => {
    if (!wsRef.current?.isConnected()) {
      console.log('Client language notification failed: WebSocket not connected')
      return
    }
    console.log(`Client language set notification -> ${language}`)
    wsRef.current.sendMessage({
      type: 'language_selected',
      role: 'client',
      language: language
    })
  }

  /** 언어 선택 화면에서만: 상담자 메시지처럼 서버에 보내 피상담자에게는 번역문 표시 */
  const sendCounselorWelcomeAfterLanguageSelect = (clientLanguageCode: string) => {
    if (!wsRef.current?.isConnected()) {
      console.log('Counselor welcome skipped: WebSocket not connected')
      return
    }
    const requestId = ++latestRequestIdRef.current
    wsRef.current.sendMessage({
      type: 'text',
      text: DEFAULT_COUNSELOR_WELCOME_KO,
      source_lang: getFullLangCode('ko'),
      target_lang: getFullLangCode(clientLanguageCode || 'ko'),
      request_id: requestId,
      sender: 'counselor',
      chat_id: activeChatIdRef.current ?? undefined,
    })
  }

  // Language change handler (for client) - called when client selects language or counselor proxy-selects
  const handleClientLanguageChange = (language: string) => {
    console.log(`Client language changed: ${language}`)
    const previousClientLanguage = clientLangRef.current
    const isInitialClientLanguageSelect =
      roleRef.current === 'client' &&
      screenRef.current === 'client' &&
      clientLangRef.current == null
    const isCounselorProxySelect =
      roleRef.current === 'counselor' &&
      screenRef.current === 'counselor'
    setClientLang(language)
    setClientLangBeforeHome(null)
    if (isInitialClientLanguageSelect) {
      // 피상담자가 첫 언어를 선택하면 즉시 마이크 auto-start를 허용한다.
      manuallyStoppedRef.current = false
    }
    if (isCounselorProxySelect) {
      // 상담자가 고객 언어를 바꿀 때마다 고객 화면에서 마이크 auto-start를 허용한다.
      manuallyStoppedRef.current = false
    }
    // Always notify as role 'client' -> counselor reflects as targetLanguage, client reflects own language on receive
    notifyClientLanguageSet(language)
    // 녹음 중이라면 GCP STT 세션을 새 언어로 재시작 (기존 세션은 언어 변경 불가)
    if (isRecordingRef.current) {
      stopRecordingAudio()  // manual=false → 500ms 후 auto-restart, 이때 새 언어 적용
    }
    if (isCounselorProxySelect && previousClientLanguage !== language) {
      // 상담자가 고객 언어를 변경할 때마다 안내 버블을 즉시 전송한다.
      sendCounselorWelcomeAfterLanguageSelect(language)
    }
  }

  // 피상담자 홈 버튼: 언어 선택 화면으로 돌아가기
  const handleClientGoHome = () => {
    setClientLangBeforeHome(clientLangRef.current)
    clientLangRef.current = null
    setClientLang(null)
  }

  const handleClientLanguageSelectClose = () => {
    if (clientLangBeforeHome == null) return
    clientLangRef.current = clientLangBeforeHome
    setClientLang(clientLangBeforeHome)
    setClientLangBeforeHome(null)
  }

  // Language change handler (for counselor - own language)
  const handleCounselorLanguageChange = (language: string) => {
    console.log(`Counselor language changed: ${language}`)
    setCounselorLang(language)
    notifyLanguageSelected(language)
    // 녹음 중이라면 GCP STT 세션을 새 언어로 재시작
    if (isRecordingRef.current) {
      stopRecordingAudio()
    }
  }

  // REST API base URL
  const getApiBaseUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:8001'
    const protocol = window.location.protocol
    const host = window.location.hostname
    return `${protocol}//${host}:8001`
  }

  // Load chat sessions (shared list by session). Returns updated chat list
  const loadChatSessions = async (sessionId: string): Promise<{ id: number }[]> => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(sessionId)}`)
      if (!res.ok) return []
      const data = await res.json()
      const chats = normalizeChatSessions(data.chats || [])
      setChatSessions(chats)
      return chats
    } catch (e) {
      console.error('Failed to load chat sessions:', e)
      return []
    }
  }
  loadChatSessionsRef.current = loadChatSessions

  // 새 채팅 설정 모달에서 확인 시: 현재 방 정리 후 새 채팅 생성하고 설정 적용
  const handleStartNewChat = async (settings: { chatSave: boolean; tts: boolean; fontSize: number; domain: string }) => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    // 새 채팅 시작 시 현재 마이크 스트림 종료 (manual=true → auto-restart 억제)
    if (isRecordingRef.current) {
      stopRecordingAudio(true)
    }
    clearRoomScopedRuntimeState()
    const currentId = activeChatIdRef.current
    const currentRoomSaveOff = currentId != null && chatSaveEnabledByRoom[currentId] === false

    if (currentRoomSaveOff && currentId != null) {
      try {
        await fetch(`${getApiBaseUrl()}/api/chats/${currentId}`, { method: 'DELETE' })
        setChatSaveEnabledByRoom((prev) => {
          const next = { ...prev }
          delete next[currentId]
          return next
        })
        const listRes = await fetch(`${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(sessionId)}`)
        if (listRes.ok) {
          const listData = await listRes.json()
          setChatSessions(normalizeChatSessions(listData.chats || []))
        }
        setActiveChatId(null)
        activeChatIdRef.current = null
        setMessages([])
        savedMessageCountRef.current = 0
      } catch (e) {
        console.error('Failed to delete current chat before new chat:', e)
      }
    }

    try {
      const domain = settings.domain || 'bank'
      const res = await fetch(`${getApiBaseUrl()}/api/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, domain }),
      })
      if (!res.ok) return
      const data = await res.json()
      const newId = data.chat_id
      activeChatIdRef.current = newId
      setActiveChatId(newId)
      setChatSessions(normalizeChatSessions(data.chats || []))
      setMessages([])
      savedMessageCountRef.current = 0
      // 새 채팅 시작 시 고객 언어 선택 상태를 초기화해 상담원 타깃 언어 버튼도 초기 상태로 만든다.
      clientLangRef.current = null
      setClientLangBeforeHome(null)
      setClientLang(null)
      setChatSaveEnabledByRoom((prev) => ({ ...prev, [newId]: settings.chatSave }))
      setClientTtsEnabled(settings.tts)
      setTtsEnabled(settings.tts)
      setFontSize(settings.fontSize)
      setCurrentDomain(domain)
      // WebSocket으로 도메인 변경 알림 (STT 용어 + 번역 프롬프트 갱신)
      if (wsRef.current?.isConnected()) {
        wsRef.current.sendMessage({ type: 'set_domain', domain })
      }
      console.log('New chat created:', newId, 'settings:', settings)
    } catch (e) {
      console.error('Failed to create new chat:', e)
    }
  }

  // Select chat (load previous messages)
  const handleSelectChat = async (chatId: number) => {
    if (activeChatIdRef.current !== chatId) {
      if (isRecordingRef.current) {
        stopRecordingAudio(true)
      }
      clearRoomScopedRuntimeState()
    }
    // Update ref immediately on switch so incoming messages go to the correct room
    activeChatIdRef.current = chatId
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/chats/${chatId}/messages`)
      if (!res.ok) return
      const data = await res.json()
      const currentRole = roleRef.current
      const loadedMessages: Message[] = (data.messages || []).map((m: any) => ({
        sender: m.sender,
        // Counselor screen: counselor_lang_text, Client screen: client_lang_text
        text: currentRole === 'counselor' ? (m.counselor_lang_text ?? '') : (m.client_lang_text ?? ''),
        timestamp: m.created_at,
      }))
      setActiveChatId(chatId)
      setMessages(loadedMessages)
      savedMessageCountRef.current = loadedMessages.length
      console.log('Chat selected:', chatId, 'messages:', loadedMessages.length)
    } catch (e) {
      console.error('Failed to select chat:', e)
    }
  }

  // Delete chat
  const handleDeleteChat = async (chatId: number) => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/chats/${chatId}`, { method: 'DELETE' })
      if (!res.ok) return
      const listRes = await fetch(`${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(sessionId)}`)
      if (!listRes.ok) return
      const data = await listRes.json()
      const chats = normalizeChatSessions(data.chats || [])
      setChatSessions(chats)
      if (activeChatIdRef.current === chatId) {
        if (chats[0]?.id) {
          handleSelectChat(chats[0].id)
        } else {
          setActiveChatId(null)
          setMessages([])
          savedMessageCountRef.current = 0
        }
      }
    } catch (e) {
      console.error('Failed to delete chat:', e)
    }
  }

  // Rename chat (session title) — optimistic update so UI shows new name immediately
  const handleRenameChat = async (chatId: number, newTitle: string) => {
    const trimmed = newTitle?.trim()
    if (!trimmed) return
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    setChatSessions((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, title: trimmed } : c))
    )
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/chats/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
      if (!res.ok) {
        const listRes = await fetch(`${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(sessionId)}`)
        if (listRes.ok) {
          const data = await listRes.json()
          setChatSessions(normalizeChatSessions(data.chats || []))
        }
        return
      }
      const listRes = await fetch(`${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(sessionId)}`)
      if (!listRes.ok) return
      const data = await listRes.json()
      setChatSessions(normalizeChatSessions(data.chats || []))
    } catch (e) {
      console.error('Failed to rename chat:', e)
      const listRes = await fetch(`${getApiBaseUrl()}/api/chats?session_id=${encodeURIComponent(sessionId)}`)
      if (listRes.ok) {
        const data = await listRes.json()
        setChatSessions(normalizeChatSessions(data.chats || []))
      }
    }
  }

  // Save message to DB (called on translation_complete). chatIdOverride saves to a specific room (for messages from other rooms)
  const saveChatMessage = async (
    sender: string,
    requestId: string | number | null | undefined,
    originalText: string,
    translatedText: string | null,
    sourceLang: string,
    targetLang: string,
    chatIdOverride?: number | null,
  ) => {
    if (!currentRoomSaveEnabledRef.current) return
    const chatId = chatIdOverride ?? activeChatIdRef.current
    if (!chatId) return
    const isCurrentChat = chatId === activeChatIdRef.current
    const isFirst = isCurrentChat && savedMessageCountRef.current === 0
    if (isCurrentChat) savedMessageCountRef.current += 1
    try {
      await fetch(`${getApiBaseUrl()}/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender,
          request_id: requestId ?? undefined,
          original_text: originalText,
          translated_text: translatedText,
          source_lang: sourceLang,
          target_lang: targetLang,
          is_first: isFirst,
        }),
      })
      if (isFirst) {
        const sessionId = sessionIdRef.current
        if (sessionId) loadChatSessions(sessionId)
      }
    } catch (e) {
      console.error('Failed to save message:', e)
    }
  }

  // Client TTS toggle (syncs to counselor screen when toggled on client screen)
  const handleClientTtsChange = (enabled: boolean) => {
    setTtsEnabled(enabled)
    if (wsRef.current?.isConnected()) {
      wsRef.current.sendMessage({ type: 'client_tts_set', enabled })
    }
  }

  // Commit sentence (request translation)
  const commitSentence = async (text: string) => {
    if (!text.trim() || !wsRef.current?.isConnected()) {
      console.log('Commit aborted: empty text or WebSocket not connected')
      return
    }
    
    // Use refs (fix closure issue)
    const currentRole = roleRef.current
    const currentCounselorLang = counselorLangRef.current
    const currentClientLang = clientLangRef.current
    
    console.log('Committing sentence:', text)
    console.log('   - Current role (Ref):', currentRole)
    console.log('   - counselorLang:', currentCounselorLang)
    console.log('   - clientLang:', currentClientLang)
    
    if (!currentRole) {
      console.error('Role not set!')
      alert('Please select a role first (Counselor or Client)')
      return
    }
    
    const requestId = ++latestRequestIdRef.current
    const sourceLang = currentRole === 'counselor' ? currentCounselorLang : currentClientLang
    const targetLang = currentRole === 'counselor' ? currentClientLang : currentCounselorLang
    
    console.log('   - sourceLang:', sourceLang, '-> Full:', getFullLangCode(sourceLang || 'ko'))
    console.log('   - targetLang:', targetLang, '-> Full:', getFullLangCode(targetLang || 'ko'))
    
    if (!targetLang) {
      console.log('Target language not set')
      return
    }
    
    try {
      const activeChatId = activeChatIdRef.current
      wsRef.current.sendMessage({
        type: 'text',
        text: text,
        source_lang: getFullLangCode(sourceLang || 'ko'),
        target_lang: getFullLangCode(targetLang),
        request_id: requestId,
        sender: currentRole,
        chat_id: activeChatId ?? undefined,
      })
      
      console.log(`Translation request #${requestId} sent`)
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  }

  // Send text message (counselor)
  const sendTextMessage = (text: string) => {
    if (!text.trim()) return
    
    console.log('Sending text message:', text)
    commitSentence(text)
  }

  const startRecordingAudio = async () => {
    // 동시 호출 방지: 이미 시작 중이거나 녹음 중이면 즉시 반환
    if (isRecordingRef.current) return
    isRecordingRef.current = true  // 낙관적 잠금 — 이후 setup 실패 시 catch에서 해제
    manuallyStoppedRef.current = false  // 수동 중지 플래그 초기화
    let selectedMicDeviceIdForRun = ''
    try {
      const currentRole = roleRef.current
      if (!currentRole || !wsRef.current?.isConnected()) {
        isRecordingRef.current = false
        return
      }
      const selectedMicDeviceId = currentRole === 'counselor' ? counselorMicDeviceId : clientMicDeviceId
      selectedMicDeviceIdForRun = selectedMicDeviceId
      const baseAudioConstraints: MediaTrackConstraints = {
        noiseSuppression: true,   // 키보드·종이 소리 등 배경 소음 억제
        echoCancellation: true,   // 에코 제거
        autoGainControl: true,    // 작은 목소리 자동 증폭
        sampleRate: 16000,        // GCP STT 최적 샘플레이트
        channelCount: 1,          // 모노
      }
      const requestedAudioConstraints: MediaTrackConstraints = selectedMicDeviceId
        ? { ...baseAudioConstraints, deviceId: { exact: selectedMicDeviceId } }
        : baseAudioConstraints

      let stream: MediaStream
      stream = await navigator.mediaDevices.getUserMedia({
        audio: requestedAudioConstraints,
      })

      recordStreamRef.current = stream

      const sourceLang = currentRole === 'counselor' ? counselorLangRef.current : clientLangRef.current
      const targetLang = currentRole === 'counselor' ? clientLangRef.current : counselorLangRef.current
      if (!targetLang) return

      const requestId = ++latestRequestIdRef.current
      audioStreamRequestIdRef.current = requestId
      const fullSourceLang = getFullLangCode(sourceLang || 'ko')

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      await audioContext.audioWorklet.addModule('/worklets/pcm-capture-processor.js')

      const sourceNode = audioContext.createMediaStreamSource(stream)
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
        processorOptions: { targetSampleRate: 16000, frameSamples: 1600 },
      })
      const silentGain = audioContext.createGain()
      silentGain.gain.value = 0

      audioSourceNodeRef.current = sourceNode
      audioWorkletNodeRef.current = workletNode

      sourceNode.connect(workletNode)
      workletNode.connect(silentGain)
      silentGain.connect(audioContext.destination)

      workletNode.port.onmessage = (event: MessageEvent<{ pcmBuffer?: ArrayBuffer; rms?: number }>) => {
        if (!wsRef.current?.isConnected()) return
        // TTS 재생 중에는 마이크 청취 억제 (에코 피드백 → 중복 버블 방지)
        if (isTtsActive()) return
        const payload = event.data || {}
        const now = Date.now()
        // 상대 발화로 차단된 동안에는 로컬 발화 상태/오디오 업링크를 모두 중지한다.
        // (차단 상태에서 speaking_state가 다시 올라와 양쪽 동시 발화처럼 보이는 문제 방지)
        if (remoteRecordingRef.current) {
          if (localSpeechLevelRef.current > 0.02) updateLiveSpeechLevel(0, now)
          if (localSpeakingStateRef.current && wsRef.current && currentRole) {
            localSpeakingStateRef.current = false
            localSpeakingStateSentAtRef.current = now
            localSpeechLevelRef.current = 0
            wsRef.current.sendMessage({
              type: 'speaking_state',
              sender: currentRole,
              is_speaking: false,
              speech_level: 0,
              chat_id: activeChatIdRef.current ?? undefined,
            })
          }
          return
        }
        const rms = Math.max(0, Number(payload.rms) || 0)
        const hadRecentInterim =
          localBrowserInterimUpdatedAtRef.current > 0 &&
          (now - localBrowserInterimUpdatedAtRef.current) < 700
        const calibrating = now < noiseCalibrationUntilRef.current
        const previousFloor = Math.max(0.0015, noiseFloorRmsRef.current || 0.004)
        if (calibrating) {
          noiseFloorRmsRef.current = previousFloor * 0.88 + rms * 0.12
        } else {
          const safeSample = hadRecentInterim
            ? Math.min(rms, previousFloor)
            : Math.min(rms, previousFloor * 1.25)
          noiseFloorRmsRef.current = previousFloor * 0.97 + safeSample * 0.03
        }

        const speechThreshold = Math.max(0.006, Math.min(0.03, noiseFloorRmsRef.current * 2.8))
        const normalizedLevel = Math.max(
          0,
          Math.min(1, (rms - noiseFloorRmsRef.current) / Math.max(0.004, speechThreshold * 2.2)),
        )
        const smoothedLevel = localSpeechLevelRef.current * 0.75 + normalizedLevel * 0.25
        localSpeechLevelRef.current = smoothedLevel
        if (Math.abs(smoothedLevel - liveSpeechLevel) >= 0.04) {
          updateLiveSpeechLevel(smoothedLevel, now)
        }
        const isSpeechLike =
          rms >= speechThreshold &&
          smoothedLevel >= SPEECH_ACTIVE_LEVEL_THRESHOLD
        if (isSpeechLike) {
          speechFrameCountRef.current = Math.min(speechFrameCountRef.current + 1, 1000)
          lastVoiceDetectedAtRef.current = Date.now()
          localLastSpeechAtRef.current = now
        }
        const shouldUploadChunk =
          isSpeechLike ||
          (lastVoiceDetectedAtRef.current > 0 && (now - lastVoiceDetectedAtRef.current) < 1200)
        // 짧은 무음 구간에서 상태가 튀지 않도록 여유를 둔다.
        const speakingNow = (now - localLastSpeechAtRef.current) < 900
        const speakingStateChanged = localSpeakingStateRef.current !== speakingNow
        const needsSpeakingHeartbeat =
          speakingNow &&
          (now - localSpeakingStateSentAtRef.current) >= 320
        if (speakingStateChanged || needsSpeakingHeartbeat) {
          localSpeakingStateRef.current = speakingNow
          localSpeakingStateSentAtRef.current = now
          wsRef.current.sendMessage({
            type: 'speaking_state',
            sender: currentRole,
            is_speaking: speakingNow,
            speech_level: Number(smoothedLevel.toFixed(3)),
            chat_id: activeChatIdRef.current ?? undefined,
          })
        }
        if (!shouldUploadChunk) {
          return
        }
        lastAudioChunkSentAtRef.current = Date.now()
        const pcmBuffer = payload.pcmBuffer
        if (!pcmBuffer) return
        const chunkBase64 = arrayBufferToBase64(pcmBuffer)
        wsRef.current.sendMessage({
          type: 'audio_stream',
          chunk: chunkBase64,
          mime_type: 'audio/pcm',
          sample_rate_hz: 16000,
          is_final: false,
          source_lang: fullSourceLang,
          target_lang: getFullLangCode(targetLang),
          request_id: requestId,
          sender: currentRole,
          chat_id: activeChatIdRef.current ?? undefined,
        })
      }

      const silentPcmFrameBase64 = arrayBufferToBase64(new ArrayBuffer(1600 * 2))
      lastAudioChunkSentAtRef.current = Date.now()
      if (audioKeepAliveTimerRef.current) {
        clearInterval(audioKeepAliveTimerRef.current)
      }
      audioKeepAliveTimerRef.current = setInterval(() => {
        if (!isRecordingRef.current) return
        if (!wsRef.current?.isConnected()) return
        if (!audioStreamRequestIdRef.current || !currentRole || !targetLang) return
        if (remoteRecordingRef.current) return

        const now = Date.now()
        // If worklet frames stop arriving (browser audio gating / silence), send a silent PCM frame.
        if (now - lastAudioChunkSentAtRef.current < 700) return
        lastAudioChunkSentAtRef.current = now

        wsRef.current.sendMessage({
          type: 'audio_stream',
          chunk: silentPcmFrameBase64,
          mime_type: 'audio/pcm',
          sample_rate_hz: 16000,
          is_final: false,
          source_lang: fullSourceLang,
          target_lang: getFullLangCode(targetLang),
          request_id: requestId,
          sender: currentRole,
          chat_id: activeChatIdRef.current ?? undefined,
        })
      }, 300)

      finalTranscriptRef.current = ''
      localBrowserInterimUpdatedAtRef.current = 0
      lastVoiceDetectedAtRef.current = 0
      localLastSpeechAtRef.current = 0
      noiseFloorRmsRef.current = 0.004
      noiseCalibrationUntilRef.current = Date.now() + 1200
      speechFrameCountRef.current = 0
      localSpeakingStateRef.current = false
      localSpeakingStateSentAtRef.current = 0
      localSpeechLevelRef.current = 0
      speakingStateByRoleRef.current = { counselor: false, client: false }
      updateLiveSpeechLevel(0)
      updateRemoteSpeechLevel(0)
      setLiveInterimText('')
      isRecordingRef.current = true
      setIsRecording(true)
      setRecordingStatus('streaming...')
    } catch (error) {
      console.error('audio stream start failed:', error)
      if (selectedMicDeviceIdForRun) {
        setRecordingStatus('selected microphone unavailable')
      } else {
        setRecordingStatus('audio stream error')
      }
      isRecordingRef.current = false  // 잠금 해제
      setIsRecording(false)
      localBrowserInterimUpdatedAtRef.current = 0
      lastVoiceDetectedAtRef.current = 0
      localLastSpeechAtRef.current = 0
      noiseFloorRmsRef.current = 0.004
      noiseCalibrationUntilRef.current = 0
      speechFrameCountRef.current = 0
      localSpeakingStateRef.current = false
      localSpeakingStateSentAtRef.current = 0
      localSpeechLevelRef.current = 0
      speakingStateByRoleRef.current = { counselor: false, client: false }
      updateLiveSpeechLevel(0)
      updateRemoteSpeechLevel(0)
      try {
        if (audioKeepAliveTimerRef.current) {
          clearInterval(audioKeepAliveTimerRef.current)
          audioKeepAliveTimerRef.current = null
        }
        audioWorkletNodeRef.current?.disconnect()
        audioSourceNodeRef.current?.disconnect()
        void audioContextRef.current?.close()
      } catch {}
      audioWorkletNodeRef.current = null
      audioSourceNodeRef.current = null
      audioContextRef.current = null
      recordStreamRef.current?.getTracks().forEach(track => track.stop())
      recordStreamRef.current = null
    }
  }

  const stopRecordingAudio = (manual = false) => {
    if (manual) manuallyStoppedRef.current = true
    isRecordingRef.current = false
    setIsRecording(false)
    setRecordingStatus('finalizing...')
    localBrowserInterimUpdatedAtRef.current = 0
    lastVoiceDetectedAtRef.current = 0
    localLastSpeechAtRef.current = 0
    noiseCalibrationUntilRef.current = 0
    speechFrameCountRef.current = 0
    localSpeakingStateSentAtRef.current = 0
    localSpeechLevelRef.current = 0
    speakingStateByRoleRef.current = { counselor: false, client: false }
    updateLiveSpeechLevel(0)
    updateRemoteSpeechLevel(0)
    if (audioKeepAliveTimerRef.current) {
      clearInterval(audioKeepAliveTimerRef.current)
      audioKeepAliveTimerRef.current = null
    }

    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    // 마이크 OFF 직후 입력중 버블 텍스트는 비운다. (레벨 바는 별도 상태로 0 처리됨)
    setLiveInterimText('')
    setRemoteInterimText('')
    setLiveListeningPendingFinalizing(false)
    setRemoteListeningPendingFinalizing(false)
    const currentRole = roleRef.current
    const sourceLang = currentRole === 'counselor' ? counselorLangRef.current : clientLangRef.current
    const targetLang = currentRole === 'counselor' ? clientLangRef.current : counselorLangRef.current
    if (currentRole && targetLang && wsRef.current?.isConnected()) {
      wsRef.current.sendMessage({
        type: 'audio_stream',
        chunk: '',
        mime_type: 'audio/pcm',
        sample_rate_hz: 16000,
        is_final: true,
        source_lang: getFullLangCode(sourceLang || 'ko'),
        target_lang: getFullLangCode(targetLang),
        request_id: audioStreamRequestIdRef.current ?? undefined,
        sender: currentRole,
        chat_id: activeChatIdRef.current ?? undefined,
      })
      localSpeakingStateRef.current = false
      wsRef.current.sendMessage({
        type: 'speaking_state',
        sender: currentRole,
        is_speaking: false,
        speech_level: 0,
        chat_id: activeChatIdRef.current ?? undefined,
      })
    }

    try {
      audioWorkletNodeRef.current?.disconnect()
      audioSourceNodeRef.current?.disconnect()
      void audioContextRef.current?.close()
    } catch (e) {
      console.warn('audio stream cleanup failed:', e)
    }
    audioWorkletNodeRef.current = null
    audioSourceNodeRef.current = null
    audioContextRef.current = null
    lastAudioChunkSentAtRef.current = 0
    recordStreamRef.current?.getTracks().forEach(track => track.stop())
    recordStreamRef.current = null
    setTimeout(() => setRecordingStatus(''), 1000)
  }
  stopRecordingAudioRef.current = stopRecordingAudio

  const networkQualityLabel = classifyNetworkQuality(networkDiagnostic.rttAvgMs, networkDiagnostic.rttP95Ms)

  if (!isMounted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center p-6">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  // 이름 자동 매칭 실패 시 첫 실행 마이크 선택 화면 (주파수 시각화 포함)
  // 상담원 화면에서 마이크 자동 매칭 실패 시 → 상담원·피상담자 마이크를 한 번에 설정
  if (showMicSetup && screen === 'counselor') {
    return (
      <>
        <DualMicSetupModal
          devices={displayAudioInputDevices}
          onClose={() => {
            setShowMicSetup(false)
            setCounselorSettingsFromSidebar(true)
          }}
          onComplete={(counselorId, counselorLabel, clientId, clientLabel) => {
            console.log(`[DualMicSetup] 상담원: "${counselorLabel}" / 피상담자: "${clientLabel}"`)
            // 상담원 마이크 저장
            const previousCounselorMicId = counselorMicDeviceIdRef.current
            counselorMicManualOverrideRef.current = true
            setCounselorMicDeviceId(counselorId)
            setStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY, counselorId)
            if (
              previousCounselorMicId !== counselorId &&
              isRecordingRef.current &&
              roleRef.current === 'counselor'
            ) {
              stopRecordingAudio(false)
            }
            // 피상담자 마이크 저장 (상담원 프로필 localStorage)
            clientMicManualOverrideRef.current = true
            setClientMicDeviceId(clientId)
            setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, clientId)
            // 피상담자 창에 WebSocket으로 마이크 배정 전달
            if (wsRef.current?.isConnected()) {
              setClientMicAssignmentNotice(`적용 요청 전송: ${clientLabel || clientId}`)
              wsRef.current.sendMessage({
                type: 'mic_assignment_request',
                device_id: clientId,
                device_label: clientLabel,
                display_label: clientLabel,
              })
            }
            setShowMicSetup(false)
          }}
        />
      </>
    )
  }

  // Role selection screen
  if (screen === 'role') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center p-6">
        <div className="absolute top-4 right-4">
          <span className="text-sm text-gray-600 mr-2">Font Size</span>
          <FontSizeSelect value={fontSize} onChange={setFontSize} compact />
        </div>
        <div className="max-w-2xl w-full bg-white rounded-2xl shadow-2xl border-2 border-gray-300 p-8">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold text-gray-800 mb-2">
              Select Your Role
            </h1>
            <p className="text-gray-600 text-lg">Choose Your Role</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Counselor button */}
            <button
              onClick={() => {
                roleRef.current = 'counselor'
                screenRef.current = 'counselor'
                setRole('counselor')
                setScreen('counselor')
                updateUrlParams('counselor')
              }}
              className="group relative overflow-hidden bg-white border-2 border-gray-300 rounded-xl p-8 hover:border-indigo-500 hover:shadow-xl transition-all duration-300 transform hover:scale-105"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 to-blue-600 opacity-0 group-hover:opacity-10 transition-opacity duration-300"></div>
              <div className="relative z-10 text-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-16 w-16 mx-auto mb-4 text-indigo-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
                <p className="text-2xl font-bold text-gray-800 mb-2">Counselor</p>
                <p className="text-sm text-gray-600">Counselor</p>
              </div>
            </button>

            {/* Client button */}
            <button
              onClick={() => {
                roleRef.current = 'client'
                screenRef.current = 'client'
                setRole('client')
                setScreen('client')
                updateUrlParams('client')
              }}
              className="group relative overflow-hidden bg-white border-2 border-gray-300 rounded-xl p-8 hover:border-purple-500 hover:shadow-xl transition-all duration-300 transform hover:scale-105"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-purple-500 to-pink-600 opacity-0 group-hover:opacity-10 transition-opacity duration-300"></div>
              <div className="relative z-10 text-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-16 w-16 mx-auto mb-4 text-purple-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
                  />
                </svg>
                <p className="text-2xl font-bold text-gray-800 mb-2">Client</p>
                <p className="text-sm text-gray-600">Client</p>
              </div>
            </button>
          </div>

          {/* Session guide panel */}
          <div className="mt-8 p-4 bg-blue-50 border-2 border-blue-200 rounded-xl">
            <div className="flex items-start gap-3">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6 text-blue-600 mt-1 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div className="flex-1">
                <h3 className="font-bold text-blue-900 mb-2">How to use</h3>
                <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
                  <li><strong>Copy URL</strong>: Copy the current URL to share with your partner</li>
                  <li><strong>Open new tab</strong>: Paste the copied URL in a new tab</li>
                  <li><strong>Select role</strong>: Counselor selects &quot;Counselor&quot;, client selects &quot;Client&quot;</li>
                  <li><strong>Start</strong>: Messages are automatically translated for both parties</li>
                </ol>
                {urlSessionId && (
                  <div className="mt-3 p-2 bg-white rounded border border-blue-300">
                    <p className="text-xs text-gray-600 mb-1">Current Session ID:</p>
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-gray-100 px-2 py-1 rounded flex-1 font-mono">
                        {urlSessionId}
                      </code>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(window.location.href)
                          alert('URL copied!\nPaste it in a new tab.')
                        }}
                        className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 transition-colors"
                      >
                        Copy URL
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Counselor screen: 최초 채팅 설정 모달 ↔ 사이드바 설정 동일 UI
  if (screen === 'counselor') {
    const counselorChatSettingsOpen =
      !hasSeenInitialCounselorModal || counselorSettingsFromSidebar
    const initialCounselorChatSave =
      activeChatId != null ? chatSaveEnabledByRoom[activeChatId] !== false : true

    const applyCounselorChatSettings = (s: {
      chatSave: boolean
      tts: boolean
      chatInputEnabled: boolean
      fontSize: number
      domain: string
    }) => {
      setClientTtsEnabled(s.tts)
      setTtsEnabled(s.tts)
      setChatInputEnabled(s.chatInputEnabled)
      if (wsRef.current?.isConnected()) {
        wsRef.current.sendMessage({ type: 'client_tts_set', enabled: s.tts })
      }
      const newFontSize = s.fontSize
      setFontSize(newFontSize)
      // 글자 크기는 채팅 영역 컴포넌트에만 반영한다.
      setStoredFontSize(newFontSize)
      if (wsRef.current?.isConnected()) {
        wsRef.current.sendMessage({ type: 'font_size_set', font_size: newFontSize })
      }
      if (activeChatIdRef.current != null) {
        setChatSaveEnabledByRoom((prev) => ({
          ...prev,
          [activeChatIdRef.current!]: s.chatSave,
        }))
      }
      // 도메인 변경 시 WebSocket으로 알림
      if (s.domain && s.domain !== currentDomain) {
        setCurrentDomain(s.domain)
        if (wsRef.current?.isConnected()) {
          wsRef.current.sendMessage({ type: 'set_domain', domain: s.domain })
        }
      }
      setHasSeenInitialCounselorModal(true)
      setCounselorSettingsFromSidebar(false)
    }

    const handleKioskSystemShutdown = () => {
      void fetch(`${getApiBaseUrl()}/api/kiosk/close-chrome`, { method: 'POST' }).catch((e) =>
        console.error('시스템 종료(Chrome) 요청 실패:', e),
      )
    }
    const clientAssignedMicLabel = clientMicDeviceId
      ? (
        clientDisplayDevicesForCounselor.find((device) => device.deviceId === clientMicDeviceId)?.displayLabel
        ?? clientDisplayDevicesForCounselor.find((device) => device.deviceId === clientMicDeviceId)?.label
        ?? audioInputDevices.find((device) => device.deviceId === clientMicDeviceId)?.label
        ?? '배정됨 (현재 장치 목록 미일치)'
      )
      : (clientDisplayDevicesForCounselor.length === 0 ? '고객 장치 미수신' : '마이크 선택')

    return (
      <>
        <CounselorChatSettingsModal
          open={counselorChatSettingsOpen}
          initialChatSave={initialCounselorChatSave}
          initialTts={clientTtsEnabled}
          initialChatInputEnabled={chatInputEnabled}
          initialFontSize={fontSize}
          initialDomain={currentDomain}
          dismissible={hasSeenInitialCounselorModal}
          onDismiss={() => {
            setCounselorSettingsFromSidebar(false)
            // 최초 접속 모달에서도 X로 닫을 수 있도록 (설정 적용 없이 닫기)
            setHasSeenInitialCounselorModal(true)
          }}
          onApply={applyCounselorChatSettings}
          onOpenWordDictionary={() => setWordDictOpen(true)}
          onOpenMicSetup={() => {
            setCounselorSettingsFromSidebar(false)
            setHasSeenInitialCounselorModal(true)
            setShowMicSetup(true)
          }}
          onOpenRemote={async () => {
            setCounselorSettingsFromSidebar(false)
            setHasSeenInitialCounselorModal(true)
            try {
              const res = await fetch(`${getApiBaseUrl()}/api/kiosk/minimize-chrome`, { method: 'POST' })
              if (!res.ok) {
                console.warn('minimize-chrome failed with status:', res.status)
              }
            } catch (e) {
              console.warn('minimize-chrome failed:', e)
            }
          }}
        />
        <WordDictionaryModal
          open={wordDictOpen}
          initialDomain={currentDomain}
          onClose={() => setWordDictOpen(false)}
        />
        {showNetworkStatus && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-[26rem] rounded-2xl bg-white shadow-2xl border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-gray-800">통신상태</h3>
                <button
                  type="button"
                  onClick={() => setShowNetworkStatus(false)}
                  className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500"
                  aria-label="닫기"
                >
                  ✕
                </button>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-center gap-5">
                  <div className="w-14 h-14 rounded-full bg-blue-500 flex items-center justify-center text-white">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <line x1="12" y1="20" x2="12.01" y2="20" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-gray-700 text-sm font-semibold">현재 PING</p>
                    <p className="text-4xl leading-none font-bold text-blue-600 mt-0.5">
                      {networkDiagnostic.rttCurrentMs != null ? `${networkDiagnostic.rttCurrentMs}ms` : '-'}
                    </p>
                    <p className="text-sm mt-1 text-gray-700">평균 상태 : <span className="font-semibold text-blue-600">{networkQualityLabel}</span></p>
                    <p className="text-sm text-gray-500">기준 목표 : <span className="font-semibold text-blue-600">30ms 이하</span></p>
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-gray-200 space-y-2 text-sm">
                  <div className="grid grid-cols-3 items-center">
                    <span className="text-gray-600 text-left flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
                      0 ~ 10ms
                    </span>
                    <span className="text-green-600 font-semibold text-center">매우 좋음</span>
                    <span className="text-gray-700 text-right">최고</span>
                  </div>
                  <div className="grid grid-cols-3 items-center">
                    <span className="text-gray-600 text-left flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500" />
                      10 ~ 30ms
                    </span>
                    <span className="text-blue-600 font-semibold text-center">좋음</span>
                    <span className="text-gray-700 text-right">안정</span>
                  </div>
                  <div className="grid grid-cols-3 items-center">
                    <span className="text-gray-600 text-left flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-500" />
                      30 ~ 50ms
                    </span>
                    <span className="text-yellow-500 font-semibold text-center">보통</span>
                    <span className="text-gray-700 text-right">사용 가능</span>
                  </div>
                  <div className="grid grid-cols-3 items-center">
                    <span className="text-gray-600 text-left flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-orange-500" />
                      50ms 이상
                    </span>
                    <span className="text-orange-500 font-semibold text-center">나쁨</span>
                    <span className="text-gray-700 text-right">지연 발생</span>
                  </div>
                  <div className="grid grid-cols-3 items-center">
                    <span className="text-gray-600 text-left flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
                      100ms 이상
                    </span>
                    <span className="text-red-500 font-semibold text-center">매우 나쁨</span>
                    <span className="text-gray-700 text-right">실시간 불가</span>
                  </div>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-gray-200 bg-white px-4 py-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">통신 상태</span>
                  <span className="font-semibold text-blue-600">{networkQualityLabel}</span>
                </div>
              </div>
            </div>
          </div>
        )}
        <CounselorScreen
          language={counselorLang}
          targetLanguage={clientLang}
          languages={counselorLanguagesForUi}
          favoriteTargetLanguages={targetFavoriteLanguagesForUi}
          targetLanguages={targetLanguagesForUi}
          messages={messages}
          liveInterimText={liveInterimText}
          remoteInterimText={remoteInterimText}
          liveSpeechLevel={liveSpeechLevel}
          remoteSpeechLevel={remoteSpeechLevel}
          liveFinalizingTexts={liveFinalizingBubbles.map((bubble) => bubble.text)}
          remoteFinalizingTexts={remoteFinalizingBubbles.map((bubble) => bubble.text)}
          liveListeningPendingFinalizing={liveListeningPendingFinalizing}
          remoteListeningPendingFinalizing={remoteListeningPendingFinalizing}
          onSendMessage={sendTextMessage}
          onChangeLanguage={handleCounselorLanguageChange}
          onChangeTargetLanguage={handleClientLanguageChange}
          onStartRecording={startRecordingAudio}
          onStopRecording={() => stopRecordingAudio(true)}
          isRecording={isRecording}
          isRemoteBlocking={remoteRecording}
          clientTtsEnabled={clientTtsEnabled}
          chatSaveEnabled={
            activeChatId != null ? chatSaveEnabledByRoom[activeChatId] !== false : true
          }
          chatInputEnabled={chatInputEnabled}
          chatSessions={chatSessions}
          activeChatId={activeChatId}
          onStartNewChat={handleStartNewChat}
          onSelectChat={handleSelectChat}
          onDeleteChat={handleDeleteChat}
          onRenameChat={handleRenameChat}
          fontSize={fontSize}
          onOpenChatSettings={() => {
            setHasSeenInitialCounselorModal(true)
            setCounselorSettingsFromSidebar(true)
          }}
          onOpenNetworkStatus={() => setShowNetworkStatus(true)}
          networkStatusLabel={networkQualityLabel}
          networkPingMs={networkDiagnostic.rttCurrentMs}
          audioInputDevices={displayAudioInputDevices}
          clientAudioInputDevices={clientDisplayDevicesForCounselor.map((device) => ({
            deviceId: device.deviceId,
            label: device.displayLabel || device.label,
          }))}
          selectedMicDeviceId={counselorMicDeviceId}
          selectedClientMicDeviceId={clientMicDeviceId}
          clientAssignedMicLabel={clientAssignedMicLabel}
          clientMicAssignmentNotice={clientMicAssignmentNotice}
          clientMicTestNotice={clientMicTestNotice}
          clientMicTestLevel={clientMicTestLevel}
          clientMicTestingDeviceId={clientMicTestingDeviceId}
          onMicChange={(id) => {
            const previousDeviceId = counselorMicDeviceIdRef.current
            counselorMicManualOverrideRef.current = true
            setCounselorMicDeviceId(id)
            setStoredMicDeviceId(COUNSELOR_MIC_STORAGE_KEY, id)
            if (
              previousDeviceId !== id &&
              isRecordingRef.current &&
              roleRef.current === 'counselor'
            ) {
              stopRecordingAudio(false)
            }
          }}
          onClientMicChange={(id) => {
            clientMicManualOverrideRef.current = true
            setClientMicDeviceId(id)
            setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, id)
            const selectedLabel = id
              ? (
                clientDisplayDevicesForCounselor.find((device) => device.deviceId === id)?.label
                ?? audioInputDevices.find((device) => device.deviceId === id)?.label
                ?? ''
              )
              : ''
            const displayLabel = id
              ? (
                clientDisplayDevicesForCounselor.find((device) => device.deviceId === id)?.displayLabel
                ?? selectedLabel
              )
              : ''
            if (wsRef.current?.isConnected()) {
              setClientMicAssignmentNotice(`적용 요청 전송: ${displayLabel || id}`)
              wsRef.current.sendMessage({
                type: 'mic_assignment_request',
                device_id: id,
                device_label: selectedLabel,
                display_label: displayLabel,
              })
            }
          }}
          onClientMicTest={(id) => {
            const selectedLabel = id
              ? (
                clientDisplayDevicesForCounselor.find((device) => device.deviceId === id)?.label
                ?? audioInputDevices.find((device) => device.deviceId === id)?.label
                ?? ''
              )
              : ''
            const displayLabel = id
              ? (
                clientDisplayDevicesForCounselor.find((device) => device.deviceId === id)?.displayLabel
                ?? selectedLabel
              )
              : ''
            if (wsRef.current?.isConnected()) {
              setClientMicTestNotice(`원격 테스트 요청 전송: ${displayLabel || id}`)
              setClientMicTestingDeviceId(id || null)
              setClientMicTestLevel(0)
              wsRef.current.sendMessage({
                type: 'mic_test_request',
                device_id: id,
                device_label: selectedLabel,
                display_label: displayLabel,
              })
            } else {
              setClientMicTestNotice('원격 테스트 실패: WebSocket 연결 안됨')
              setClientMicTestingDeviceId(null)
              setClientMicTestLevel(0)
            }
          }}
          onSystemShutdown={handleKioskSystemShutdown}
        />
      </>
    )
  }

  // Client screen: 언어 선택 후 채팅 화면 (모달 없음)
  if (screen === 'client') {
    if (clientLang == null) {
      return (
        <>
          <LanguageSelectScreen
            licenseTier={licenseTier}
            onClose={clientLangBeforeHome != null ? handleClientLanguageSelectClose : undefined}
            onSelectLanguage={(code) => {
              handleClientLanguageChange(code)
              sendCounselorWelcomeAfterLanguageSelect(code)
            }}
          />
        </>
      )
    }
    return (
      <>
        <ClientScreen
          language={clientLang}
          languages={targetLanguagesForUi}
          messages={messages}
          liveInterimText={liveInterimText}
          remoteInterimText={remoteInterimText}
          liveSpeechLevel={liveSpeechLevel}
          remoteSpeechLevel={remoteSpeechLevel}
          liveFinalizingTexts={liveFinalizingBubbles.map((bubble) => bubble.text)}
          remoteFinalizingTexts={remoteFinalizingBubbles.map((bubble) => bubble.text)}
          liveListeningPendingFinalizing={liveListeningPendingFinalizing}
          remoteListeningPendingFinalizing={remoteListeningPendingFinalizing}
          onChangeLanguage={handleClientLanguageChange}
          onStartRecording={startRecordingAudio}
          onStopRecording={() => stopRecordingAudio(true)}
          isRecording={isRecording}
          isRemoteBlocking={remoteRecording}
          recordingStatus={recordingStatus}
          ttsEnabled={ttsEnabled}
          chatSessions={chatSessions}
          activeChatId={activeChatId}
          onNewChat={() => handleStartNewChat({ chatSave: true, tts: clientTtsEnabled, fontSize, domain: currentDomain })}
          onSelectChat={handleSelectChat}
          onDeleteChat={handleDeleteChat}
          fontSize={fontSize}
          onGoHome={handleClientGoHome}
          audioInputDevices={audioInputDevices}
          selectedMicDeviceId={clientMicDeviceId}
          onMicChange={(id) => {
            const previousDeviceId = clientMicDeviceIdRef.current
            clientLocalMicManualOverrideRef.current = true
            setClientMicDeviceId(id)
            setStoredMicDeviceId(CLIENT_MIC_STORAGE_KEY, id)
            if (
              previousDeviceId !== id &&
              isRecordingRef.current &&
              roleRef.current === 'client'
            ) {
              stopRecordingAudio(false)
            }
            const selectedLabel = id
              ? (audioInputDevices.find((device) => device.deviceId === id)?.label ?? '')
              : ''
            if (wsRef.current?.isConnected()) {
              wsRef.current.sendMessage({
                type: 'mic_assignment',
                device_id: id,
                device_label: selectedLabel,
              })
            }
          }}
        />
      </>
    )
  }

  return null
}
