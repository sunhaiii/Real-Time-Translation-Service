'use client'

import { useState, useRef, useEffect } from 'react'
import ReactCountryFlag from 'react-country-flag'
import ChatMessage from './ChatMessage'
import FontSizeSelect from './FontSizeSelect'
import { getCountryCodeForLang } from '../lib/langCountry'

// 상담자 화면과 동일: 언어 드롭다운 표시명
const LANGUAGE_LABELS: Record<string, string> = {
  'ko': '한국어',
  'zh-CN': '中国人',
  'vi': 'Tiếng Việt',
  'th': '태국어',
  'en': 'English',
  'uz': 'Oʻzbekcha',
  'tl': 'Filipino',
  'id': 'Bahasa Indonesia',
  'ja': '日本語',
  'zh-HK': '廣東話',
  'en-SG': 'English (SG)',
  'fr': 'Français',
}

const FLAG_SIZE = 24

function LangIcon({ code }: { code: string }) {
  const countryCode = getCountryCodeForLang(code)
  if (countryCode) {
    return (
      <span className="w-6 h-6 flex items-center justify-center shrink-0 overflow-hidden rounded" title={code}>
        <ReactCountryFlag
          countryCode={countryCode}
          svg
          style={{ width: FLAG_SIZE, height: FLAG_SIZE }}
        />
      </span>
    )
  }
  const fallback = code.slice(0, 2).toUpperCase()
  return (
    <span
      className="w-6 h-6 flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px] font-semibold uppercase shrink-0"
      title={code}
    >
      {fallback}
    </span>
  )
}

interface Language {
  code: string
  name: string
}

interface Message {
  sender: string
  text: string
  timestamp?: string
}

interface ChatSession {
  id: number
  title: string
  created_at?: string
  updated_at?: string
}

interface ClientScreenProps {
  language: string | null
  languages: Language[]
  messages: Message[]
  liveInterimText: string
  remoteInterimText: string
  liveSpeechLevel?: number
  remoteSpeechLevel?: number
  liveFinalizingTexts?: string[]
  remoteFinalizingTexts?: string[]
  liveListeningPendingFinalizing?: boolean
  remoteListeningPendingFinalizing?: boolean
  onChangeLanguage: (code: string) => void
  onStartRecording: () => void
  onStopRecording: () => void
  isRecording: boolean
  /** 상담자가 녹음 중일 때 true → 피상담자 마이크 차단 상태 표시 */
  isRemoteBlocking?: boolean
  recordingStatus: string
  /** TTS on/off (상담자 말을 음성으로 읽어줌) */
  ttsEnabled?: boolean
  onTtsChange?: (enabled: boolean) => void
  /** 채팅 이력 */
  chatSessions?: ChatSession[]
  activeChatId?: number | null
  onNewChat?: () => void
  onSelectChat?: (chatId: number) => void
  onDeleteChat?: (chatId: number) => void
  /** 글자 크기 (수동 지정 시 전체 반영) */
  fontSize?: number
  onFontSizeChange?: (px: number) => void
  /** 홈 버튼 클릭 시 언어 선택 화면으로 이동 */
  onGoHome?: () => void
  /** 피상담자 마이크 선택 (헤더에 표시) */
  audioInputDevices?: { deviceId: string; label: string }[]
  selectedMicDeviceId?: string
  onMicChange?: (deviceId: string) => void
}

function SpeechLevelBars({
  level,
  activeColor,
  inactiveColor,
}: {
  level: number
  activeColor: string
  inactiveColor: string
}) {
  const clamped = Math.max(0, Math.min(1, Number(level) || 0))
  const dotCount = 12
  const activeCount = Math.max(1, Math.round(clamped * dotCount))
  return (
    <div className="mt-2 flex items-center gap-2">
      {Array.from({ length: dotCount }).map((_, idx) => {
        const active = idx < activeCount
        return (
          <span
            key={`dot-${idx}`}
            className="w-3 h-3 rounded-full transition-colors duration-100"
            style={{ backgroundColor: active ? activeColor : inactiveColor }}
          />
        )
      })}
    </div>
  )
}

// 시안_260205 피상담자 화면 Figma 토큰 (윤곽선 또렷하게)
const FIGMA = {
  sidemenuBg: '#eff2fe',
  sidemenuBorder: '#b8c4f0',
  workspaceBorder: '#a8b8e8',
  tabBg: 'rgba(204, 213, 252, 0.5)',
  accent: '#5c79f6',
  text: '#121212',
  textSecondary: '#8f8f8f',
  bubbleOutcomingBg: '#ffffff',
  bubbleOutcomingBorder: '#b0b0b0',
  bubbleOutcomingText: '#323232',
  bubbleIncomingBg: '#c8cef0',
  bubbleIncomingBorder: '#b0b0b0',
  typingDots: '#ccd5fc',
  topBg: '#ffffff',
  font: 'Pretendard, sans-serif',
}

export default function ClientScreen({
  language,
  languages,
  messages,
  liveInterimText,
  remoteInterimText,
  liveSpeechLevel = 0,
  remoteSpeechLevel = 0,
  liveFinalizingTexts = [],
  remoteFinalizingTexts = [],
  liveListeningPendingFinalizing = false,
  remoteListeningPendingFinalizing = false,
  onChangeLanguage,
  onStartRecording,
  onStopRecording,
  isRecording,
  isRemoteBlocking = false,
  recordingStatus,
  ttsEnabled = true,
  onTtsChange,
  chatSessions = [],
  activeChatId = null,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  fontSize = 16,
  onFontSizeChange,
  onGoHome,
  audioInputDevices = [],
  selectedMicDeviceId = '',
  onMicChange,
}: ClientScreenProps) {
  const SCROLL_BOTTOM_THRESHOLD_PX = 48
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false)
  const [micDropdownOpen, setMicDropdownOpen] = useState(false)
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const prevMessageCountRef = useRef(messages.length)
  const langDropdownRef = useRef<HTMLDivElement>(null)
  const micDropdownRef = useRef<HTMLDivElement>(null)
  const showLiveSpeechBubble =
    liveSpeechLevel > 0.10 ||
    Boolean(liveInterimText.trim()) ||
    (liveListeningPendingFinalizing && liveFinalizingTexts.length === 0)
  const showRemoteSpeechBubble =
    remoteSpeechLevel > 0.10 ||
    Boolean(remoteInterimText.trim()) ||
    (remoteListeningPendingFinalizing && remoteFinalizingTexts.length === 0)

  const updatePinnedToBottom = () => {
    const el = messagesContainerRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setIsPinnedToBottom(distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX)
  }

  useEffect(() => {
    const prevMessageCount = prevMessageCountRef.current
    const hasNewMessage = messages.length > prevMessageCount

    if (hasNewMessage || isPinnedToBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      if (hasNewMessage) {
        setIsPinnedToBottom(true)
      }
    }

    prevMessageCountRef.current = messages.length
  }, [
    messages,
    liveInterimText,
    remoteInterimText,
    liveFinalizingTexts,
    remoteFinalizingTexts,
    liveListeningPendingFinalizing,
    remoteListeningPendingFinalizing,
  ])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setLanguageDropdownOpen(false)
      }
      if (micDropdownRef.current && !micDropdownRef.current.contains(e.target as Node)) {
        setMicDropdownOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  const currentLanguage = languages.find((lang) => lang.code === language) || languages[0]
  const displayLangName = language
    ? (LANGUAGE_LABELS[language] || (currentLanguage?.code === language ? currentLanguage.name : null) || language)
    : '언어 선택'
  const selectedMicLabel = selectedMicDeviceId
    ? (audioInputDevices.find((d) => d.deviceId === selectedMicDeviceId)?.label ?? '마이크 선택')
    : (audioInputDevices.length === 0 ? '마이크 없음' : '마이크 선택')
  const chatBodyFontSize = Math.max(14, fontSize)
  const chatHintFontSize = Math.max(12, Math.round(fontSize * 0.875))
  const chatStatusTitleFontSize = Math.max(18, Math.round(fontSize * 1.25))
  const chatStatusSubFontSize = Math.max(14, Math.round(fontSize * 0.95))

  const toggleRecording = () => {
    if (isRecording) {
      onStopRecording()
    } else {
      onStartRecording()
    }
  }

  return (
    <div
      className="h-screen overflow-hidden flex bg-white"
      style={{
        fontFamily: FIGMA.font,
        background: 'linear-gradient(135deg, rgba(123, 103, 240, 0.05) 0%, rgba(54, 143, 254, 0.05) 13.5%, transparent 100%)',
      }}
    >
      {/* 피상담자 화면: 사이드바 없음, 메인만 전체 너비 */}
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Top - 흰색 헤더 + 언어 드롭다운 (상담자 화면과 동일) */}
        <header
          className="h-14 flex items-center justify-end px-6 flex-shrink-0 gap-3 border-b-2 border-gray-200"
          style={{ backgroundColor: FIGMA.topBg }}
        >
          {/* TTS on/off 토글 */}
          {onTtsChange != null && (
            <div className="flex items-center gap-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: FIGMA.textSecondary }} aria-hidden>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              <button
                type="button"
                role="switch"
                aria-checked={ttsEnabled}
                onClick={() => onTtsChange(!ttsEnabled)}
                className="relative inline-flex h-7 w-[72px] flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 items-center"
                style={{
                  backgroundColor: ttsEnabled ? FIGMA.accent : FIGMA.sidemenuBorder,
                }}
              >
                <span className={`pointer-events-none absolute left-1.5 text-xs font-medium transition-opacity ${ttsEnabled ? 'opacity-50' : 'opacity-100'}`} style={{ color: ttsEnabled ? '#fff' : '#4b5563' }}>OFF</span>
                <span className={`pointer-events-none absolute right-1.5 text-xs font-medium transition-opacity ${ttsEnabled ? 'opacity-100' : 'opacity-50'}`} style={{ color: ttsEnabled ? '#fff' : '#4b5563' }}>ON</span>
                <span
                  className={`pointer-events-none inline-block h-7 w-7 rounded-full bg-white shadow ring-0 transition absolute left-0.5 top-1/2 -translate-y-1/2 z-10 ${ttsEnabled ? 'translate-x-[35px]' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
          )}
          {/* 글자 크기 선택 */}
          {onFontSizeChange && (
            <div className="w-[93px] flex-shrink-0">
              <FontSizeSelect value={fontSize} onChange={onFontSizeChange} compact className="w-full" />
            </div>
          )}
          {onMicChange && (
            <div className="relative flex-shrink-0" ref={micDropdownRef}>
              <button
                type="button"
                onClick={() => audioInputDevices.length > 0 && setMicDropdownOpen((v) => !v)}
                disabled={audioInputDevices.length === 0}
                className={`h-9 px-4 rounded-full flex items-center gap-2 transition-colors hover:opacity-90 ${micDropdownOpen ? 'ring-2 ring-offset-1 ring-gray-300' : ''}`}
                style={{
                  minWidth: 112,
                  backgroundColor: FIGMA.sidemenuBg,
                  border: `1px solid ${FIGMA.accent}`,
                  color: FIGMA.accent,
                }}
                title="피상담자 마이크"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <span className="truncate max-w-[64px] text-sm">마이크</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              {micDropdownOpen && (
                <div
                  className="absolute top-full right-0 mt-1 min-w-[220px] w-[320px] max-w-[90vw] bg-white rounded-lg border shadow-lg py-1 z-50"
                  style={{ borderColor: FIGMA.bubbleOutcomingBorder }}
                  role="listbox"
                >
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-xs text-gray-500">고객 마이크</p>
                    <p className="text-sm font-semibold text-gray-800 break-words mt-1">{selectedMicLabel}</p>
                  </div>
                  {audioInputDevices.map((device) => (
                    <button
                      key={device.deviceId}
                      type="button"
                      role="option"
                      onClick={() => {
                        onMicChange(device.deviceId)
                        setMicDropdownOpen(false)
                      }}
                      className="w-full min-h-12 px-4 py-3 flex items-center gap-3 hover:bg-gray-50 text-left text-sm transition-colors"
                      style={{ color: FIGMA.text }}
                    >
                      <span className="flex-1 break-words">{device.label}</span>
                      {device.deviceId === selectedMicDeviceId ? (
                        <span className="text-xs flex-shrink-0" style={{ color: FIGMA.accent }}>✓</span>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="relative" ref={langDropdownRef}>
            <button
              type="button"
              onClick={() => {
                if (onGoHome) {
                  onGoHome()
                  return
                }
                setLanguageDropdownOpen((v) => !v)
              }}
              className="h-9 px-4 rounded-full flex items-center gap-2 transition-colors hover:opacity-90"
              style={{
                minWidth: 93,
                backgroundColor: FIGMA.sidemenuBg,
                borderColor: FIGMA.accent,
                color: FIGMA.accent,
                border: '1px solid',
              }}
            >
              {language ? <LangIcon code={language} /> : <span className="w-6 h-6 flex items-center justify-center rounded bg-white/80 text-gray-500 text-xs shrink-0">—</span>}
              <span className="text-sm">{displayLangName}</span>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            {!onGoHome && languageDropdownOpen && (
              <div
                className="absolute top-full right-0 mt-1 w-[241px] bg-white rounded-lg border shadow-lg py-1 z-50"
                style={{ borderColor: FIGMA.bubbleOutcomingBorder }}
                role="listbox"
              >
                {languages.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    role="option"
                    onClick={() => {
                      onChangeLanguage(lang.code)
                      setLanguageDropdownOpen(false)
                    }}
                    className="w-full h-12 px-4 flex items-center gap-3 hover:bg-gray-50 text-left text-sm transition-colors"
                    style={{ minHeight: 48, color: FIGMA.text }}
                  >
                    <LangIcon code={lang.code} />
                    <span className="flex-1">{LANGUAGE_LABELS[lang.code] || lang.name}</span>
                    {lang.code === language ? (
                      <span className="text-xs flex-shrink-0" style={{ color: FIGMA.accent }}>✓</span>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {/* 채팅 영역 */}
        <div
          ref={messagesContainerRef}
          onScroll={updatePinnedToBottom}
          className="flex-1 overflow-y-auto px-6 py-4"
        >
          {messages.length === 0 && !showLiveSpeechBubble && !showRemoteSpeechBubble && liveFinalizingTexts.length === 0 && remoteFinalizingTexts.length === 0 ? (
            <div className="h-full flex items-center justify-center min-h-[300px]">
              <div className="text-center" style={{ color: FIGMA.textSecondary }}>
                <p style={{ fontSize: `${chatHintFontSize}px` }}>Press the microphone button to start speaking.</p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, index) => (
                <ChatMessage
                  key={index}
                  message={msg}
                  isSender={msg.sender === 'client'}
                  variant="clientScreen"
                  fontSize={fontSize}
                />
              ))}

              {showLiveSpeechBubble && (
                <div className="flex justify-end mb-4">
                  <div className="max-w-[500px] flex flex-col items-end">
                    <div
                      className="rounded-2xl rounded-br-md px-4 py-3 border-2 bg-indigo-100 text-indigo-800 border-indigo-300"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-[#eef2ff] flex items-center justify-center" style={{ color: FIGMA.accent }}>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm0 0v4m-4 0h8" />
                          </svg>
                        </div>
                        <div className="flex flex-col">
                          <p className="font-medium" style={{ fontSize: `${chatStatusTitleFontSize}px`, lineHeight: 1.15 }}>Listening....</p>
                          <p className="mt-1" style={{ fontSize: `${chatStatusSubFontSize}px`, lineHeight: 1.2 }}>(음성 입력 중)</p>
                          <SpeechLevelBars level={liveSpeechLevel} activeColor="#2f85df" inactiveColor="#b7c9ed" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {liveFinalizingTexts.map((text, index) => (
                <div key={`live-finalizing-${index}-${text}`} className="flex justify-end mb-4">
                  <div className="max-w-[500px] flex flex-col items-end">
                    <div
                      className="rounded-2xl rounded-br-md px-4 py-3 border-2 bg-indigo-50 text-indigo-900 border-indigo-200"
                    >
                      <p className="leading-relaxed whitespace-pre-wrap break-words" style={{ fontSize: `${chatBodyFontSize}px` }}>
                        {text}
                      </p>
                      <p className="mt-1" style={{ color: FIGMA.textSecondary, fontSize: `${chatHintFontSize}px` }}>
                        번역 중...
                      </p>
                    </div>
                  </div>
                </div>
              ))}

              {showRemoteSpeechBubble && (
                <div className="flex justify-start mb-4">
                  <div className="max-w-[500px] flex flex-col items-start">
                    <div
                      className="rounded-2xl rounded-bl-md px-4 py-3 bg-gray-200 text-gray-800 border border-gray-300"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-[#eef2ff] flex items-center justify-center text-[#2f85df]">
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12h2m2-3v6m4-8v10m4-12v14m4-10v6" />
                          </svg>
                        </div>
                        <div className="flex flex-col">
                          <p className="font-medium" style={{ fontSize: `${chatStatusTitleFontSize}px`, lineHeight: 1.15 }}>Speech detected</p>
                          <p className="mt-1" style={{ fontSize: `${chatStatusSubFontSize}px`, lineHeight: 1.2 }}>(음성 감지됨)</p>
                          <SpeechLevelBars level={remoteSpeechLevel} activeColor="#2f85df" inactiveColor="#b7c9ed" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {remoteFinalizingTexts.map((text, index) => (
                <div key={`remote-finalizing-${index}-${text}`} className="flex justify-start mb-4">
                  <div className="max-w-[500px] flex flex-col items-start">
                    <div
                      className="rounded-2xl rounded-bl-md px-4 py-3 border bg-gray-100 text-gray-800 border-gray-300"
                    >
                      <p className="leading-relaxed whitespace-pre-wrap break-words" style={{ fontSize: `${chatBodyFontSize}px` }}>
                        {text}
                      </p>
                      <p className="mt-1" style={{ color: FIGMA.textSecondary, fontSize: `${chatHintFontSize}px` }}>
                        상대방 발화를 번역 중...
                      </p>
                    </div>
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* 하단 입력 영역 - 시안_260205: 안내 문구 + 원형 마이크 */}
        <div className="flex-shrink-0 py-6 px-6">
          <style>{`
            @keyframes float-point {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-10px); }
            }
          `}</style>
          {/* 아래를 가리키는 손가락 - 녹음 중이거나 차단 중에는 숨김 */}
          {!isRecording && (
            <div
              className="flex justify-center mb-1"
              style={{ animation: 'float-point 2s ease-in-out infinite' }}
              aria-hidden
            >
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: FIGMA.accent }}>
                <path d="M8 12v8.5a1.5 1.5 0 0 0 3 0v-7.5" />
                <path d="M11 13.5v2a1.5 1.5 0 0 0 3 0v-2.5" />
                <path d="M14 14.5a1.5 1.5 0 0 0 3 0v-1.5" />
                <path d="M17 13.5a1.5 1.5 0 0 0 3 0v-4.5a6 6 0 0 0-6-6h-2.208a6 6 0 0 0-5.012 2.7l-.196.3q-.468.718-3.286 5.728a1.5 1.5 0 0 0 .536 2.022c.734.44 1.674.325 2.28-.28l1.47-1.47" />
              </svg>
            </div>
          )}
          <div className="flex flex-col items-center gap-4">
            <div className="w-full flex items-center justify-center gap-4 relative">
              {/* 마이크 버튼 - 중앙 */}
              <button
                type="button"
                onClick={toggleRecording}
                className="w-[72px] h-[72px] rounded-full flex items-center justify-center transition-transform shadow-lg flex-shrink-0"
                style={{
                  backgroundColor: FIGMA.accent,
                  color: '#ffffff',
                  transform: 'scale(1)',
                  cursor: 'pointer',
                  opacity: 1,
                }}
                aria-label={isRecording ? '녹음 중지' : '말하기'}
              >
                {isRecording ? (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z" />
                  </svg>
                )}
              </button>
              {/* 홈 버튼 - 우측 */}
              {onGoHome && (
                <button
                  type="button"
                  onClick={onGoHome}
                  className="absolute right-0 w-12 h-12 rounded-full flex items-center justify-center transition-colors hover:opacity-90"
                  style={{
                    backgroundColor: FIGMA.sidemenuBg,
                    border: `1px solid ${FIGMA.sidemenuBorder}`,
                    color: FIGMA.accent,
                  }}
                  aria-label="홈 (언어 선택)"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

    </div>
  )
}
