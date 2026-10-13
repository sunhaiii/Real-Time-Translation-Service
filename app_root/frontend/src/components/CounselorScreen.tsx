'use client'

import { useState, useRef, useEffect } from 'react'
import ReactCountryFlag from 'react-country-flag'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'
import FontSizeSelect from './FontSizeSelect'
import { getCountryCodeForLang } from '../lib/langCountry'

interface Language {
  code: string
  name: string
}

interface Message {
  sender: string
  text: string
  timestamp?: string
}

interface CounselorScreenProps {
  /** 상담자(내) 언어 */
  language: string
  /** 같은 세션 피상담자가 선택한 언어 (상담자가 대리 선택 가능) */
  targetLanguage: string | null
  languages: Language[]
  favoriteTargetLanguages?: Language[]
  targetLanguages?: Language[]
  messages: Message[]
  liveInterimText: string
  remoteInterimText: string
  liveSpeechLevel?: number
  remoteSpeechLevel?: number
  liveFinalizingTexts?: string[]
  remoteFinalizingTexts?: string[]
  liveListeningPendingFinalizing?: boolean
  remoteListeningPendingFinalizing?: boolean
  onSendMessage: (text: string) => void
  onChangeLanguage: (code: string) => void
  /** 상담자 화면에서 피상담자 언어를 선택했을 때 호출 (피상담자 언어 자동 적용) */
  onChangeTargetLanguage?: (code: string) => void
  onStartRecording: () => void
  onStopRecording: () => void
  isRecording: boolean
  /** 피상담자가 녹음 중일 때 true → 상담자 마이크 차단 상태 표시 */
  isRemoteBlocking?: boolean
  /** 새 채팅 모달 기본값용 */
  clientTtsEnabled?: boolean
  chatSaveEnabled?: boolean
  /** 채팅 입력창 표시 여부. true면 입력창+마이크, false면 client 스타일 원형 마이크만 (동일 동작) */
  chatInputEnabled?: boolean
  /** 사이드바 «설정» → 부모에서 채팅 설정 모달 표시 */
  onOpenChatSettings?: () => void
  /** 헤더 «네트워크 상태» 패널 열기 */
  onOpenNetworkStatus?: () => void
  /** 네트워크 상태 요약 라벨 */
  networkStatusLabel?: string
  /** 현재 RTT(ms) */
  networkPingMs?: number | null
  /** 채팅 이력 */
  chatSessions?: { id: number; title: string; created_at?: string; updated_at?: string }[]
  activeChatId?: number | null
  /** 새 채팅 설정 모달에서 확인 시 호출 (채팅 저장·소리·글자 크기·도메인 적용) */
  onStartNewChat?: (settings: { chatSave: boolean; tts: boolean; fontSize: number; domain: string }) => void
  onSelectChat?: (chatId: number) => void
  onDeleteChat?: (chatId: number) => void
  onRenameChat?: (chatId: number, newTitle: string) => void
  fontSize?: number
  /** 상담자 마이크 선택 (헤더에 표시) */
  audioInputDevices?: { deviceId: string; label: string }[]
  clientAudioInputDevices?: { deviceId: string; label: string }[]
  selectedMicDeviceId?: string
  selectedClientMicDeviceId?: string
  clientAssignedMicLabel?: string
  clientMicAssignmentNotice?: string
  clientMicTestNotice?: string
  clientMicTestLevel?: number
  clientMicTestingDeviceId?: string | null
  onMicChange?: (deviceId: string) => void
  onClientMicChange?: (deviceId: string) => void
  onClientMicTest?: (deviceId: string) => void
  /** 시스템 종료: 사이드바 하단 프로필 영역 */
  onSystemShutdown?: () => void
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
  const dotCount = 10
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

// Figma 시안_260205 상담자 화면: 언어 드롭다운 표시명
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
}

const FLAG_SIZE = 24
const HEADER_ICON_SIZE = 20
const HEADER_CHEVRON_SIZE = 16
const HEADER_BUTTON_HEIGHT_PX = 36
const HEADER_BUTTON_FONT_SIZE_PX = 16
const KOREAN_LANGUAGE_DISPLAY_NAMES =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames !== 'undefined'
    ? new Intl.DisplayNames(['ko'], { type: 'language' })
    : null

function normalizeLangCodeForKoreanLabel(code: string): string {
  if (code === 'tl') return 'fil'
  if (code === 'zh-CN') return 'zh-Hans'
  if (code === 'zh-HK') return 'zh-Hant-HK'
  return code
}

// Figma 상담자 화면(v2) 사이드바 스펙 (위치·크기 픽셀 단위)
const FIGMA_SIDEBAR = {
  columnWidth: 280,
  collapsedColumnWidth: 128,
  panelInset: 16,
  panelRadius: 32,
  collapsedPanelRadius: 9999,
  sidemenuBg: '#eff2fe',
  sidemenuBorder: '#d1d5db',
  accent: '#5c79f6', // 언어 선택 강조 (ClientScreen 드롭다운과 동일)
  tabBg: 'rgba(204, 213, 252, 0.5)',
  labelColor: '#8f8f8f',
  text: '#121212',
  iconColor: '#565656',
  // 레이아웃 (px)
  workspaceHeight: 56,
  paddingH: 20,           // 좌우 패딩 (248 - 208 = 40, 20씩)
  contentBlockGapTop: 32,  // Workspace 아래 ~ 새 채팅 위
  newChatButtonHeight: 36,
  newChatButtonRadius: 8,
  newChatButtonGap: 8,     // 아이콘~텍스트
  myChatLabelGapTop: 24,   // 새 채팅 버튼 아래 ~ 내 채팅 라벨
  myChatLabelHeight: 24,
  myChatLabelGapBottom: 4, // 라벨 ~ 첫 번째 아이템
  chatItemHeight: 28,
  chatItemGap: 4,
  chatItemPaddingLeft: 8,
  chatItemRadius: 4,
  profileSectionPaddingV: 20,
  profileSectionPaddingH: 20,
  profilePillHeight: 52,
  profilePillPaddingLeft: 12,
  profilePillPaddingV: 10,
  profileAvatarSize: 32,
  profileAvatarGap: 12,
  logoWidth: 320,
  logoHeight: 70,
  panelIconSize: 20,
  collapsedWorkspaceWidth: 60,
  collapsedNewChatButtonWidth: 40,
  collapsedProfilePillWidth: 56,
}

function LangIcon({ code }: { code: string }) {
  const countryCode = getCountryCodeForLang(code)
  if (countryCode) {
    return (
      <span
        className="flex items-center justify-center shrink-0 overflow-hidden rounded"
        style={{ width: FLAG_SIZE, height: FLAG_SIZE }}
        title={code}
      >
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
      className="flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px] font-semibold uppercase shrink-0"
      style={{ width: FLAG_SIZE, height: FLAG_SIZE }}
      title={code}
    >
      {fallback}
    </span>
  )
}

export default function CounselorScreen(props: CounselorScreenProps) {
  const {
    language,
    targetLanguage,
    languages,
    favoriteTargetLanguages = [],
    targetLanguages,
    messages,
    liveInterimText,
    remoteInterimText,
    liveSpeechLevel = 0,
    remoteSpeechLevel = 0,
    liveFinalizingTexts = [],
    remoteFinalizingTexts = [],
    liveListeningPendingFinalizing = false,
    remoteListeningPendingFinalizing = false,
    onSendMessage,
    onChangeLanguage,
    onChangeTargetLanguage,
    onStartRecording,
    onStopRecording,
    isRecording,
    isRemoteBlocking = false,
    clientTtsEnabled = true,
    chatSaveEnabled = true,
    chatInputEnabled = true,
    onOpenChatSettings,
    onOpenNetworkStatus,
    networkStatusLabel = '확인 필요',
    networkPingMs = null,
    chatSessions = [],
    activeChatId = null,
    onStartNewChat,
    onSelectChat,
    onDeleteChat,
    onRenameChat,
    fontSize = 16,
    audioInputDevices = [],
    clientAudioInputDevices = [],
    selectedMicDeviceId = '',
    selectedClientMicDeviceId = '',
    clientAssignedMicLabel = '미설정',
    clientMicAssignmentNotice = '',
    clientMicTestNotice = '',
    clientMicTestLevel = 0,
    clientMicTestingDeviceId = null,
    onMicChange,
    onClientMicChange,
    onClientMicTest,
    onSystemShutdown,
  } = props

  const [showLanguageModal, setShowLanguageModal] = useState(false)
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false)
  const [targetLanguageDropdownOpen, setTargetLanguageDropdownOpen] = useState(false)
  const [micDropdownOpen, setMicDropdownOpen] = useState(false)
  const [openCounselorMicList, setOpenCounselorMicList] = useState(false)
  const [openClientMicList, setOpenClientMicList] = useState(false)
  const [testingMicToken, setTestingMicToken] = useState<string | null>(null)
  const [testMicLevel, setTestMicLevel] = useState(0)
  const [counselorMicTestNotice, setCounselorMicTestNotice] = useState('')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [editingChatId, setEditingChatId] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [newChatSave, setNewChatSave] = useState(true)
  const [newChatTts, setNewChatTts] = useState(true)
  const [newChatFontSize, setNewChatFontSize] = useState(16)
  const [newChatDomain, setNewChatDomain] = useState('bank')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const langDropdownRef = useRef<HTMLDivElement>(null)
  const targetLangDropdownRef = useRef<HTMLDivElement>(null)
  const micDropdownRef = useRef<HTMLDivElement>(null)
  const testStreamRef = useRef<MediaStream | null>(null)
  const testAudioCtxRef = useRef<AudioContext | null>(null)
  const testAnalyserRef = useRef<AnalyserNode | null>(null)
  const testRafRef = useRef<number | null>(null)
  const showLiveSpeechBubble =
    liveSpeechLevel > 0.10 ||
    Boolean(liveInterimText.trim()) ||
    (liveListeningPendingFinalizing && liveFinalizingTexts.length === 0)
  const showRemoteSpeechBubble =
    remoteSpeechLevel > 0.10 ||
    Boolean(remoteInterimText.trim()) ||
    (remoteListeningPendingFinalizing && remoteFinalizingTexts.length === 0)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
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
    if (showNewChatModal) {
      setNewChatSave(chatSaveEnabled !== false)
      setNewChatTts(clientTtsEnabled)
      setNewChatFontSize(fontSize)
    }
  }, [showNewChatModal, chatSaveEnabled, clientTtsEnabled, fontSize])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setLanguageDropdownOpen(false)
      }
      if (targetLangDropdownRef.current && !targetLangDropdownRef.current.contains(e.target as Node)) {
        setTargetLanguageDropdownOpen(false)
      }
      if (micDropdownRef.current && !micDropdownRef.current.contains(e.target as Node)) {
        setMicDropdownOpen(false)
        setOpenCounselorMicList(false)
        setOpenClientMicList(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  const currentLanguage = languages.find(lang => lang.code === language) || languages[0]
  const targetLanguageOptions = targetLanguages ?? languages
  const favoriteTargetLanguageCodes = new Set(favoriteTargetLanguages.map((lang) => lang.code))
  const remainingTargetLanguageOptions = targetLanguageOptions.filter((lang) => !favoriteTargetLanguageCodes.has(lang.code))
  const currentTargetLanguage = targetLanguageOptions.find(lang => lang.code === targetLanguage)
  const displayLangName = LANGUAGE_LABELS[language] || currentLanguage.name
  const getTargetLanguageLabel = (code: string, fallbackName: string) => {
    const normalizedCode = normalizeLangCodeForKoreanLabel(code)
    return KOREAN_LANGUAGE_DISPLAY_NAMES?.of(normalizedCode) || fallbackName || code
  }
  const displayTargetName = targetLanguage
    ? getTargetLanguageLabel(targetLanguage, currentTargetLanguage?.name || targetLanguage)
    : null
  const selectedCounselorMicLabel = selectedMicDeviceId
    ? (audioInputDevices.find((d) => d.deviceId === selectedMicDeviceId)?.label ?? '마이크 선택')
    : (audioInputDevices.length === 0 ? '마이크 없음' : '마이크 선택')
  const selectedClientMicLabel = selectedClientMicDeviceId
    ? (
      clientAudioInputDevices.find((d) => d.deviceId === selectedClientMicDeviceId)?.label
      ?? audioInputDevices.find((d) => d.deviceId === selectedClientMicDeviceId)?.label
      ?? clientAssignedMicLabel
    )
    : clientAssignedMicLabel
  const chatBodyFontSize = Math.max(14, fontSize)
  const chatHintFontSize = Math.max(12, Math.round(fontSize * 0.875))
  const chatStatusTitleFontSize = Math.max(18, Math.round(fontSize * 1.25))
  const chatStatusSubFontSize = Math.max(14, Math.round(fontSize * 0.95))
  const networkTone: Record<string, { badgeBg: string; badgeText: string; border: string }> = {
    '매우 좋음': { badgeBg: '#16a34a', badgeText: '#ffffff', border: '#86efac' },
    '좋음': { badgeBg: '#2563eb', badgeText: '#ffffff', border: '#93c5fd' },
    '보통': { badgeBg: '#f59e0b', badgeText: '#ffffff', border: '#fcd34d' },
    '나쁨': { badgeBg: '#f97316', badgeText: '#ffffff', border: '#fdba74' },
    '매우 나쁨': { badgeBg: '#ef4444', badgeText: '#ffffff', border: '#fca5a5' },
    '확인 필요': { badgeBg: '#6b7280', badgeText: '#ffffff', border: '#d1d5db' },
  }
  const networkStyle = networkTone[networkStatusLabel] || networkTone['확인 필요']

  const handleSendText = (text: string) => onSendMessage(text)
  const toggleRecording = () => (isRecording ? onStopRecording() : onStartRecording())

  const stopMicTest = () => {
    if (testRafRef.current) {
      cancelAnimationFrame(testRafRef.current)
      testRafRef.current = null
    }
    testAnalyserRef.current?.disconnect()
    void testAudioCtxRef.current?.close()
    testStreamRef.current?.getTracks().forEach((track) => track.stop())
    testAnalyserRef.current = null
    testAudioCtxRef.current = null
    testStreamRef.current = null
    setTestingMicToken(null)
    setTestMicLevel(0)
  }

  const handleMicDropdownToggle = () => {
    if (audioInputDevices.length === 0 && clientAudioInputDevices.length === 0) return
    setMicDropdownOpen((prev) => {
      const next = !prev
      if (next) {
        setOpenCounselorMicList(false)
        setOpenClientMicList(false)
      }
      return next
    })
  }

  const startMicTest = async (deviceId: string, token: string) => {
    if (!deviceId) return
    if (isRecording) {
      setCounselorMicTestNotice('녹음 중에는 상담 마이크 테스트를 시작할 수 없습니다. 녹음을 먼저 중지해 주세요.')
      return
    }
    setCounselorMicTestNotice('')
    stopMicTest()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      })
      testStreamRef.current = stream
      const actx = new AudioContext()
      testAudioCtxRef.current = actx
      const analyser = actx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.6
      testAnalyserRef.current = analyser
      actx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const centered = (data[i] - 128) / 128
          sum += centered * centered
        }
        const rms = Math.sqrt(sum / data.length)
        const level = Math.max(0, Math.min(1, rms * 7))
        setTestMicLevel(level)
        testRafRef.current = requestAnimationFrame(tick)
      }
      tick()
      setTestingMicToken(token)
      setCounselorMicTestNotice('상담 마이크 테스트 중입니다. 말씀하시면 입력 레벨이 표시됩니다.')
    } catch (error) {
      console.warn('Mic test failed:', error)
      setCounselorMicTestNotice('상담 마이크 테스트를 시작하지 못했습니다. 마이크 권한/점유 상태를 확인해 주세요.')
      stopMicTest()
    }
  }

  useEffect(() => {
    if (!micDropdownOpen) stopMicTest()
  }, [micDropdownOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stopMicTest(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const rootStyle = {
    fontFamily: 'Pretendard, sans-serif',
    backgroundColor: '#ffffff',
    background: 'linear-gradient(135deg, rgba(123, 103, 240, 0.02) 0%, rgba(54, 143, 254, 0.02) 13.5%, transparent 100%), #ffffff',
  }
  const sidebarColumnWidth = isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedColumnWidth : FIGMA_SIDEBAR.columnWidth
  const sidebarRadius = isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedPanelRadius : FIGMA_SIDEBAR.panelRadius
  const pillClipPath = 'inset(0 round 9999px)'

  return (
    <div className="h-screen w-full flex overflow-hidden relative" style={rootStyle}>
      {/* 사이드바: 화면 전체 높이, 왼쪽 영역 */}
      <aside
        className="absolute left-0 top-0 bottom-0 flex flex-col pointer-events-none z-10"
        style={{ width: sidebarColumnWidth }}
      >
        <div className="pointer-events-auto flex-1 flex flex-col min-h-0" style={{ margin: FIGMA_SIDEBAR.panelInset }}>
          {/* 라운드 패널만: 248px 폭, 32px radius */}
          <div
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            style={{
              borderRadius: sidebarRadius,
              backgroundColor: FIGMA_SIDEBAR.sidemenuBg,
              border: `1px solid ${FIGMA_SIDEBAR.sidemenuBorder}`,
            }}
          >
            {/* Workspace: 상단 라운드 */}
            <div
              className="flex items-center flex-shrink-0"
              style={{
                height: FIGMA_SIDEBAR.workspaceHeight,
                justifyContent: isSidebarCollapsed ? 'center' : 'space-between',
                width: isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedWorkspaceWidth : undefined,
                alignSelf: isSidebarCollapsed ? 'center' : undefined,
                paddingLeft: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.paddingH,
                paddingRight: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.paddingH,
                borderTopLeftRadius: sidebarRadius,
                borderTopRightRadius: sidebarRadius,
              }}
            >
            {!isSidebarCollapsed && (
              <img
                src="/main_logo.png"
                alt="메인 로고"
                className="object-contain"
                style={{ width: FIGMA_SIDEBAR.logoWidth, height: FIGMA_SIDEBAR.logoHeight }}
                width={FIGMA_SIDEBAR.logoWidth}
                height={FIGMA_SIDEBAR.logoHeight}
              />
            )}
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed((prev) => !prev)}
              className="flex items-center justify-center rounded shrink-0"
              style={{
                color: FIGMA_SIDEBAR.iconColor,
                width: FIGMA_SIDEBAR.panelIconSize,
                height: FIGMA_SIDEBAR.panelIconSize,
              }}
              title={isSidebarCollapsed ? '패널 펼치기' : '패널 접기'}
              aria-label={isSidebarCollapsed ? '패널 펼치기' : '패널 접기'}
              aria-expanded={!isSidebarCollapsed}
            >
              <svg width={FIGMA_SIDEBAR.panelIconSize} height={FIGMA_SIDEBAR.panelIconSize} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={isSidebarCollapsed ? 'M7 4l6 6-6 6' : 'M13 4l-6 6 6 6'} />
              </svg>
            </button>
          </div>

          {/* 새 채팅: 상단 32px, 좌우 20px, 버튼 208×36, radius 8 */}
          <div
            className="flex-shrink-0"
            style={{
              paddingTop: FIGMA_SIDEBAR.contentBlockGapTop,
              paddingLeft: isSidebarCollapsed ? FIGMA_SIDEBAR.panelInset : FIGMA_SIDEBAR.paddingH,
              paddingRight: isSidebarCollapsed ? FIGMA_SIDEBAR.panelInset : FIGMA_SIDEBAR.paddingH,
            }}
          >
            <button
              type="button"
              onClick={() => setShowNewChatModal(true)}
              className="flex items-center transition-colors hover:opacity-90"
              style={{
                height: HEADER_BUTTON_HEIGHT_PX,
                paddingLeft: 12,
                paddingRight: 12,
                gap: FIGMA_SIDEBAR.newChatButtonGap,
                backgroundColor: FIGMA_SIDEBAR.tabBg,
                borderRadius: FIGMA_SIDEBAR.newChatButtonRadius,
                width: isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedNewChatButtonWidth : '100%',
                margin: '0 auto',
                justifyContent: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              {!isSidebarCollapsed && (
                <span
                  className="font-medium"
                  style={{
                    color: FIGMA_SIDEBAR.text,
                    letterSpacing: 0,
                    fontSize: HEADER_BUTTON_FONT_SIZE_PX,
                    lineHeight: `${HEADER_BUTTON_HEIGHT_PX}px`,
                  }}
                >
                  새 채팅
                </span>
              )}
            </button>
          </div>

          {!isSidebarCollapsed && (
            <>
              {/* 내 채팅: 라벨 24px 높이 + 4px gap, 아이템 28px, 4px 간격 */}
              <div
                className="flex-1 overflow-y-auto min-h-0"
                style={{
                  paddingTop: FIGMA_SIDEBAR.myChatLabelGapTop,
                  paddingLeft: FIGMA_SIDEBAR.paddingH,
                  paddingRight: FIGMA_SIDEBAR.paddingH,
                }}
              >
                <p
                  className="flex items-center"
                  style={{
                    height: FIGMA_SIDEBAR.myChatLabelHeight,
                    marginBottom: FIGMA_SIDEBAR.myChatLabelGapBottom,
                    color: FIGMA_SIDEBAR.labelColor,
                    fontSize: 12,
                    fontWeight: 400,
                    letterSpacing: 0.2,
                    lineHeight: 16,
                  }}
                >
                  내 채팅
                </p>
                <ul style={{ display: 'flex', flexDirection: 'column', gap: FIGMA_SIDEBAR.chatItemGap }}>
                  {chatSessions.length === 0 ? (
                    <li className="text-xs py-2 px-0" style={{ color: FIGMA_SIDEBAR.labelColor }}>
                      채팅 기록이 없습니다
                    </li>
                  ) : (
                    chatSessions.map((chat) => {
                      const isActive = chat.id === activeChatId
                      const isEditing = editingChatId === chat.id
                      const rawTitle = chat.title != null ? String(chat.title).trim() : ''
                      const displayTitle = rawTitle || `세션 ${(chat as { room_number?: number }).room_number ?? chat.id}`
                      const dateStr = chat.updated_at
                        ? (() => { const d = new Date(chat.updated_at); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0'); return `${y}.${m}.${day}` })()
                        : ''
                      const submitRename = () => {
                        const t = editingTitle.trim()
                        if (t && onRenameChat) {
                          onRenameChat(chat.id, t)
                        }
                        setEditingChatId(null)
                        setEditingTitle('')
                      }
                      return (
                        <li key={chat.id} className="group flex items-center gap-1">
                          {isEditing ? (
                            <div className="flex-1 min-w-0 flex items-center gap-1" style={{ height: FIGMA_SIDEBAR.chatItemHeight }}>
                              <input
                                type="text"
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onBlur={submitRename}
                                onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') { setEditingChatId(null); setEditingTitle('') } }}
                                autoFocus
                                className="flex-1 min-w-0 border rounded px-2 py-0.5 text-sm"
                                style={{ color: FIGMA_SIDEBAR.text }}
                              />
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => onSelectChat?.(chat.id)}
                                className="flex-1 min-w-0 text-left flex flex-col justify-center transition-colors hover:bg-white/50 overflow-hidden"
                                style={{
                                  minWidth: 0,
                                  height: FIGMA_SIDEBAR.chatItemHeight,
                                  paddingLeft: FIGMA_SIDEBAR.chatItemPaddingLeft,
                                  paddingRight: 8,
                                  color: FIGMA_SIDEBAR.labelColor,
                                  fontSize: 14,
                                  fontWeight: 400,
                                  letterSpacing: 0.2,
                                  lineHeight: 20,
                                  borderRadius: FIGMA_SIDEBAR.chatItemRadius,
                                  backgroundColor: isActive ? 'rgba(92,121,246,0.12)' : 'transparent',
                                }}
                                title={displayTitle}
                              >
                                <span
                                  className="block min-w-0 flex-shrink-0"
                                  style={{
                                    minHeight: 20,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    color: FIGMA_SIDEBAR.labelColor,
                                  }}
                                >
                                  {displayTitle}
                                </span>
                                {dateStr && (
                                  <span className="block text-xs mt-0.5 flex-shrink-0" style={{ color: FIGMA_SIDEBAR.labelColor }}>{dateStr}</span>
                                )}
                              </button>
                              {onRenameChat && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setEditingChatId(chat.id); setEditingTitle(rawTitle || displayTitle) }}
                                  className="shrink-0 p-1.5 rounded opacity-60 hover:opacity-100 hover:bg-black/10 transition-opacity"
                                  style={{ color: FIGMA_SIDEBAR.iconColor }}
                                  title="세션 이름 변경"
                                  aria-label="세션 이름 변경"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                  </svg>
                                </button>
                              )}
                            </>
                          )}
                          {!isEditing && onDeleteChat && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id) }}
                              className="shrink-0 p-1.5 rounded opacity-60 hover:opacity-100 hover:bg-black/10 transition-opacity"
                              style={{ color: FIGMA_SIDEBAR.iconColor }}
                              title="채팅방 삭제"
                              aria-label="채팅방 삭제"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                <line x1="10" y1="11" x2="10" y2="17" />
                                <line x1="14" y1="11" x2="14" y2="17" />
                              </svg>
                            </button>
                          )}
                        </li>
                      )
                    })
                  )}
                </ul>
              </div>
            </>
          )}

          {/* 설정 버튼: 사용자명(프로필)과 같은 크기 */}
          <div
            className="flex-shrink-0"
            style={{
              paddingLeft: FIGMA_SIDEBAR.profileSectionPaddingH,
              paddingRight: FIGMA_SIDEBAR.profileSectionPaddingH,
              paddingTop: isSidebarCollapsed ? 12 : 0,
              paddingBottom: 8,
            }}
          >
            <button
              type="button"
              onClick={() => onOpenChatSettings?.()}
              className="flex items-center rounded-full w-full border-0 cursor-pointer transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-400"
              style={{
                width: isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedProfilePillWidth : '100%',
                margin: isSidebarCollapsed ? '0 auto' : undefined,
                justifyContent: isSidebarCollapsed ? 'center' : undefined,
                height: HEADER_BUTTON_HEIGHT_PX,
                paddingLeft: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.profilePillPaddingLeft,
                paddingRight: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.profilePillPaddingLeft,
                paddingTop: FIGMA_SIDEBAR.profilePillPaddingV,
                paddingBottom: FIGMA_SIDEBAR.profilePillPaddingV,
                backgroundColor: '#ffffff',
                overflow: 'hidden',
                clipPath: pillClipPath,
              }}
              aria-label="설정"
            >
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  width: FIGMA_SIDEBAR.profileAvatarSize,
                  height: FIGMA_SIDEBAR.profileAvatarSize,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: FIGMA_SIDEBAR.iconColor }}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </div>
              {!isSidebarCollapsed && (
                <span
                  className="font-semibold truncate"
                  style={{
                    marginLeft: FIGMA_SIDEBAR.profileAvatarGap,
                    color: FIGMA_SIDEBAR.text,
                    letterSpacing: 0.2,
                    lineHeight: `${HEADER_BUTTON_HEIGHT_PX}px`,
                    fontSize: HEADER_BUTTON_FONT_SIZE_PX,
                  }}
                >
                  설 정
                </span>
              )}
            </button>
          </div>

          {/* 프로필 + 시스템 종료: 하단 라운드 유지 */}
          <div
            className="flex-shrink-0"
            style={{
              paddingTop: 0,
              paddingBottom: FIGMA_SIDEBAR.profileSectionPaddingV,
              paddingLeft: FIGMA_SIDEBAR.profileSectionPaddingH,
              paddingRight: FIGMA_SIDEBAR.profileSectionPaddingH,
              borderBottomLeftRadius: sidebarRadius,
              borderBottomRightRadius: sidebarRadius,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {/* 사용자 명 pill */}
            <div
              className="flex items-center rounded-full"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedProfilePillWidth : '100%',
                margin: isSidebarCollapsed ? '0 auto' : undefined,
                justifyContent: isSidebarCollapsed ? 'center' : undefined,
                height: HEADER_BUTTON_HEIGHT_PX,
                paddingLeft: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.profilePillPaddingLeft,
                paddingRight: isSidebarCollapsed ? 0 : 8,
                paddingTop: FIGMA_SIDEBAR.profilePillPaddingV,
                paddingBottom: FIGMA_SIDEBAR.profilePillPaddingV,
                backgroundColor: '#ffffff',
                position: 'relative',
                zIndex: 1,
                cursor: 'default',
                overflow: 'hidden',
                clipPath: pillClipPath,
              }}
            >
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  width: FIGMA_SIDEBAR.profileAvatarSize,
                  height: FIGMA_SIDEBAR.profileAvatarSize,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: FIGMA_SIDEBAR.iconColor }}>
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              {!isSidebarCollapsed && (
                <span
                  className="font-semibold truncate flex-1 min-w-0"
                  style={{
                    marginLeft: FIGMA_SIDEBAR.profileAvatarGap,
                    color: FIGMA_SIDEBAR.text,
                    letterSpacing: 0.2,
                    lineHeight: `${HEADER_BUTTON_HEIGHT_PX}px`,
                    fontSize: HEADER_BUTTON_FONT_SIZE_PX,
                  }}
                >
                  사용자 명
                </span>
              )}
            </div>

            {/* 시스템 종료 버튼 */}
            {onSystemShutdown && (
              <button
                type="button"
                onClick={onSystemShutdown}
                className="flex items-center rounded-full w-full border-0 cursor-pointer transition-opacity hover:opacity-90 focus:outline-none"
                style={{
                  width: isSidebarCollapsed ? FIGMA_SIDEBAR.collapsedProfilePillWidth : '100%',
                  margin: isSidebarCollapsed ? '0 auto' : undefined,
                  justifyContent: isSidebarCollapsed ? 'center' : undefined,
                  height: HEADER_BUTTON_HEIGHT_PX,
                  paddingLeft: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.profilePillPaddingLeft,
                  paddingRight: isSidebarCollapsed ? 0 : FIGMA_SIDEBAR.profilePillPaddingLeft,
                  paddingTop: FIGMA_SIDEBAR.profilePillPaddingV,
                  paddingBottom: FIGMA_SIDEBAR.profilePillPaddingV,
                  backgroundColor: '#fef2f2',
                  overflow: 'hidden',
                  clipPath: pillClipPath,
                }}
                aria-label="시스템 종료"
              >
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0"
                  style={{
                    width: FIGMA_SIDEBAR.profileAvatarSize,
                    height: FIGMA_SIDEBAR.profileAvatarSize,
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" />
                  </svg>
                </div>
                {!isSidebarCollapsed && (
                  <span
                    className="font-semibold truncate"
                    style={{
                      marginLeft: FIGMA_SIDEBAR.profileAvatarGap,
                      color: '#ef4444',
                      letterSpacing: 0.2,
                      lineHeight: `${HEADER_BUTTON_HEIGHT_PX}px`,
                      fontSize: HEADER_BUTTON_FONT_SIZE_PX,
                    }}
                  >
                    종 료
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
        </div>
      </aside>

      {/* 메인: 헤더 + 채팅. 헤더가 메인 전체 너비(사이드바 제외) 상단, 사이드바는 맨 위~아래 전체 높이 */}
      <main
        className="flex-1 min-w-0 min-h-0 flex flex-col"
        style={{ paddingLeft: sidebarColumnWidth - FIGMA_SIDEBAR.panelInset }}
      >
        {/* 상단 헤더: 메인 영역 전체 너비 */}
        <header
          className="flex-shrink-0 flex items-center justify-end border-b-2 border-gray-300 bg-white w-full"
          style={{ height: 56, paddingLeft: 16, paddingRight: 16, gap: 12 }}
        >
          <div className="flex items-center" style={{ gap: 8 }}>
            {onOpenNetworkStatus && (
              <button
                type="button"
                onClick={() => onOpenNetworkStatus()}
                className="h-9 px-3 rounded-full border text-sm font-semibold flex items-center gap-2 transition-colors hover:opacity-90"
                style={{
                  height: 36,
                  paddingLeft: 12,
                  paddingRight: 12,
                  fontSize: 16,
                  lineHeight: '20px',
                  gap: 8,
                  borderColor: networkStyle.border,
                  color: '#334155',
                  backgroundColor: '#ffffff',
                }}
                title="통신상태 확인"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                  <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                  <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                  <line x1="12" y1="20" x2="12.01" y2="20" />
                </svg>
                <span>통신상태</span>
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-bold"
                  style={{
                    fontSize: 14,
                    lineHeight: '18px',
                    padding: '2px 8px',
                    backgroundColor: networkStyle.badgeBg,
                    color: networkStyle.badgeText,
                  }}
                >
                  {networkStatusLabel}
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" className="text-gray-500" style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
            {onMicChange && (
              <div className="relative flex-shrink-0" ref={micDropdownRef}>
                <button
                  type="button"
                  onClick={handleMicDropdownToggle}
                  disabled={audioInputDevices.length === 0 && clientAudioInputDevices.length === 0}
                  className={`h-9 px-3 rounded-full text-sm font-medium flex items-center gap-2 transition-colors ${micDropdownOpen ? 'ring-2 ring-offset-1 ring-gray-300' : ''}`}
                  style={{
                    height: 36,
                    paddingLeft: 12,
                    paddingRight: 12,
                    fontSize: 16,
                    lineHeight: '20px',
                    minWidth: 112,
                    backgroundColor: FIGMA_SIDEBAR.sidemenuBg,
                    border: '1px solid',
                    borderColor: FIGMA_SIDEBAR.accent,
                    color: FIGMA_SIDEBAR.accent,
                  }}
                  title="마이크"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0" style={{ width: HEADER_ICON_SIZE, height: HEADER_ICON_SIZE }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                  <span className="truncate max-w-[64px]">마이크</span>
                  <svg xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0" style={{ width: HEADER_ICON_SIZE, height: HEADER_ICON_SIZE }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {micDropdownOpen && (
                  <div
                    className="absolute top-full right-0 mt-1 min-w-[240px] w-[380px] max-w-[92vw] bg-white rounded-lg border border-gray-200 shadow-lg py-1 z-50"
                    role="listbox"
                  >
                    <div className="px-4 py-3 border-b border-gray-100">
                      <button
                        type="button"
                        className="w-full flex items-center justify-between text-left"
                        onClick={() => setOpenCounselorMicList((v) => !v)}
                      >
                        <span className="text-xs text-gray-500">상담 마이크</span>
                        <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 text-gray-500 transition-transform ${openCounselorMicList ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <p className="font-semibold text-gray-800 break-words mt-1" style={{ fontSize: 16, lineHeight: '20px' }}>{selectedCounselorMicLabel}</p>
                      {counselorMicTestNotice ? (
                        <p className="mt-1 text-xs text-indigo-600 break-words">{counselorMicTestNotice}</p>
                      ) : null}
                      {openCounselorMicList && (
                        <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/40">
                          {audioInputDevices.map((device) => {
                            const token = `counselor:${device.deviceId}`
                            const isTesting = testingMicToken === token
                            return (
                              <div key={`counselor-${device.deviceId}`} className="w-full min-h-11 px-3 py-2 flex items-start gap-2 hover:bg-gray-50 text-gray-800">
                                <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, lineHeight: '20px' }}>{device.label}</span>
                                <button
                                  type="button"
                                  onClick={() => isTesting ? stopMicTest() : startMicTest(device.deviceId, token)}
                                  className="w-14 flex-shrink-0 px-2 py-1 rounded-md text-xs text-center font-semibold border border-gray-200 bg-white hover:bg-gray-100"
                                >
                                  {isTesting ? '중지' : '테스트'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onMicChange?.(device.deviceId)
                                    setMicDropdownOpen(false)
                                  }}
                                  className="w-14 flex-shrink-0 px-2 py-1 rounded-md text-xs text-center font-semibold bg-indigo-500 text-white hover:bg-indigo-600"
                                >
                                  선택
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    <div className="px-4 py-3">
                      <button
                        type="button"
                        className="w-full flex items-center justify-between text-left"
                        onClick={() => setOpenClientMicList((v) => !v)}
                      >
                        <span className="text-xs text-gray-500">고객 마이크</span>
                        <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 text-gray-500 transition-transform ${openClientMicList ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <p className="font-semibold text-gray-800 break-words mt-1" style={{ fontSize: 16, lineHeight: '20px' }}>{selectedClientMicLabel}</p>
                      {clientMicAssignmentNotice ? (
                        <p className="mt-1 text-xs text-gray-500 break-words">{clientMicAssignmentNotice}</p>
                      ) : null}
                      {clientMicTestNotice ? (
                        <p className="mt-1 text-xs text-indigo-600 break-words">{clientMicTestNotice}</p>
                      ) : null}
                      {openClientMicList && (
                        <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/40">
                          {clientAudioInputDevices.map((device) => {
                            return (
                              <div key={`client-${device.deviceId}`} className="w-full min-h-11 px-3 py-2 flex items-start gap-2 hover:bg-gray-50 text-gray-800">
                                <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, lineHeight: '20px' }}>{device.label}</span>
                                {onClientMicTest && (
                                  <button
                                    type="button"
                                    onClick={() => onClientMicTest(device.deviceId)}
                                    className="w-14 flex-shrink-0 px-2 py-1 rounded-md text-xs text-center font-semibold border border-gray-200 bg-white hover:bg-gray-100"
                                  >
                                    테스트
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    onClientMicChange?.(device.deviceId)
                                    setMicDropdownOpen(false)
                                  }}
                                  className="w-14 flex-shrink-0 px-2 py-1 rounded-md text-xs text-center font-semibold bg-indigo-500 text-white hover:bg-indigo-600"
                                >
                                  선택
                                </button>
                              </div>
                            )
                          })}
                          {clientAudioInputDevices.length === 0 && (
                            <div className="w-full px-3 py-3 text-sm text-gray-500">
                              고객 장치 목록 수신 대기 중
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {(testingMicToken || clientMicTestingDeviceId) && (
                      <div className="px-4 pb-2 pt-0">
                        <div className="w-full h-1.5 rounded-full bg-gray-200 overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 transition-all duration-75"
                            style={{
                              width: `${Math.max(
                                2,
                                Math.round(
                                  (
                                    clientMicTestingDeviceId
                                      ? clientMicTestLevel
                                      : testMicLevel
                                  ) * 100,
                                ),
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="relative" ref={langDropdownRef}>
              <button
                type="button"
                onClick={() => setLanguageDropdownOpen((v) => !v)}
                className="h-9 px-4 rounded-full text-sm font-medium flex items-center gap-2 transition-colors hover:opacity-90"
                style={{
                  height: 36,
                  paddingLeft: 16,
                  paddingRight: 16,
                  fontSize: 16,
                  lineHeight: '20px',
                  minWidth: 93,
                  backgroundColor: FIGMA_SIDEBAR.sidemenuBg,
                  border: '1px solid',
                  borderColor: FIGMA_SIDEBAR.accent,
                  color: FIGMA_SIDEBAR.accent,
                }}
              >
                <LangIcon code={language} />
                <span>{displayLangName}</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="text-current opacity-70" style={{ width: HEADER_CHEVRON_SIZE, height: HEADER_CHEVRON_SIZE }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              {languageDropdownOpen && (
                <div
                  className="absolute top-full right-0 mt-1 w-[241px] bg-white rounded-lg border border-gray-200 shadow-lg py-1 z-50"
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
                      className="w-full h-12 px-4 flex items-center gap-3 hover:bg-gray-50 text-left text-sm text-gray-800"
                      style={{ minHeight: 48, fontSize: 16, lineHeight: '20px' }}
                    >
                      <LangIcon code={lang.code} />
                      <span className="flex-1">{LANGUAGE_LABELS[lang.code] || lang.name}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative" ref={targetLangDropdownRef}>
              <button
                type="button"
                onClick={() => onChangeTargetLanguage && setTargetLanguageDropdownOpen((v) => !v)}
                className={`h-9 px-4 rounded-full text-sm font-medium flex items-center gap-2 transition-colors ${targetLanguageDropdownOpen ? 'ring-2 ring-offset-1 ring-gray-300' : ''} ${targetLanguage ? 'hover:opacity-90' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                style={{
                  height: 36,
                  paddingLeft: 16,
                  paddingRight: 16,
                  fontSize: 16,
                  lineHeight: '20px',
                  minWidth: 93,
                  ...(targetLanguage
                    ? {
                        backgroundColor: FIGMA_SIDEBAR.sidemenuBg,
                        border: '1px solid',
                        borderColor: FIGMA_SIDEBAR.accent,
                        color: FIGMA_SIDEBAR.accent,
                      }
                    : {}),
                }}
                title={targetLanguage ? '고객 언어 (클릭하여 변경)' : '고객 언어'}
                disabled={!onChangeTargetLanguage}
              >
                {targetLanguage ? <LangIcon code={targetLanguage} /> : <span className="flex items-center justify-center rounded bg-gray-200 text-gray-400 text-xs shrink-0" style={{ width: FLAG_SIZE, height: FLAG_SIZE }}>—</span>}
                <span>{targetLanguage ? displayTargetName : '고객 언어'}</span>
                {onChangeTargetLanguage && (
                  <svg xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0 text-current opacity-70" style={{ width: HEADER_CHEVRON_SIZE, height: HEADER_CHEVRON_SIZE }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
              {targetLanguageDropdownOpen && onChangeTargetLanguage && (
                <div
                  className="absolute top-full right-0 mt-1 w-[280px] max-h-[420px] overflow-y-auto bg-white rounded-lg border border-gray-200 shadow-lg py-1 z-50"
                  role="listbox"
                >
                  {favoriteTargetLanguages.length > 0 && (
                    <div className="px-4 pt-2 pb-1 text-xs font-semibold text-gray-500">즐겨찾기</div>
                  )}
                  {favoriteTargetLanguages.map((lang) => (
                    <button
                      key={`fav-${lang.code}`}
                      type="button"
                      role="option"
                      onClick={() => {
                        onChangeTargetLanguage(lang.code)
                        setTargetLanguageDropdownOpen(false)
                      }}
                      className="w-full h-12 px-4 flex items-center gap-3 hover:bg-gray-50 text-left text-sm text-gray-800"
                      style={{ minHeight: 48, fontSize: 16 }}
                    >
                      <LangIcon code={lang.code} />
                      <span className="flex-1">{getTargetLanguageLabel(lang.code, lang.name)}</span>
                      {lang.code === targetLanguage ? (
                        <span className="text-xs flex-shrink-0" style={{ color: FIGMA_SIDEBAR.accent }}>✓</span>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </button>
                  ))}
                  {favoriteTargetLanguages.length > 0 && remainingTargetLanguageOptions.length > 0 && (
                    <div className="my-1 border-t border-gray-100" />
                  )}
                  {remainingTargetLanguageOptions.map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      role="option"
                      onClick={() => {
                        onChangeTargetLanguage(lang.code)
                        setTargetLanguageDropdownOpen(false)
                      }}
                      className="w-full h-12 px-4 flex items-center gap-3 hover:bg-gray-50 text-left text-sm text-gray-800"
                      style={{ minHeight: 48, fontSize: 13 }}
                    >
                      <LangIcon code={lang.code} />
                      <span className="flex-1">{getTargetLanguageLabel(lang.code, lang.name)}</span>
                      {lang.code === targetLanguage ? (
                        <span className="text-xs flex-shrink-0" style={{ color: FIGMA_SIDEBAR.accent }}>✓</span>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* 채팅 영역 Figma 1192×728 (상담자 화면_채팅) */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          {messages.length === 0 && !showLiveSpeechBubble && !showRemoteSpeechBubble && liveFinalizingTexts.length === 0 && remoteFinalizingTexts.length === 0 ? (
            <div className="h-full flex items-center justify-center min-h-[300px]">
              <p className="text-gray-400" style={{ fontSize: `${chatHintFontSize}px` }}>상담을 시작하세요</p>
            </div>
          ) : (
            <>
              {messages.map((msg, index) => (
                <ChatMessage
                  key={index}
                  message={msg}
                  isSender={msg.sender === 'counselor'}
                  fontSize={fontSize}
                />
              ))}
              {liveFinalizingTexts.map((text, index) => (
                <div key={`live-finalizing-${index}-${text}`} className="flex justify-end mb-4">
                  <div className="max-w-[70%] flex flex-col items-end">
                    <div className="rounded-2xl px-4 py-3 bg-indigo-50 text-indigo-900 rounded-br-sm border-2 border-indigo-200">
                      <p className="leading-relaxed whitespace-pre-wrap break-words" style={{ fontSize: `${chatBodyFontSize}px` }}>{text}</p>
                      <p className="mt-1 text-indigo-600" style={{ fontSize: `${chatHintFontSize}px` }}>번역 중...</p>
                    </div>
                  </div>
                </div>
              ))}
              {remoteFinalizingTexts.map((text, index) => (
                <div key={`remote-finalizing-${index}-${text}`} className="flex justify-start mb-4">
                  <div className="max-w-[70%] flex flex-col items-start">
                    <div className="rounded-2xl px-4 py-3 bg-gray-100 text-gray-800 rounded-bl-sm border border-gray-300">
                      <p className="leading-relaxed whitespace-pre-wrap break-words" style={{ fontSize: `${chatBodyFontSize}px` }}>{text}</p>
                      <p className="mt-1 text-gray-500" style={{ fontSize: `${chatHintFontSize}px` }}>상대방 발화를 번역 중...</p>
                    </div>
                  </div>
                </div>
              ))}
              {showLiveSpeechBubble && (
                <div className="flex justify-end mb-4">
                  <div className="max-w-[70%] flex flex-col items-end">
                    <div className="rounded-2xl px-4 py-3 bg-indigo-100 text-indigo-800 rounded-br-sm border-2 border-indigo-300">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-white/75 flex items-center justify-center">
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm0 0v4m-4 0h8" />
                          </svg>
                        </div>
                        <div className="flex flex-col">
                          <p className="font-medium" style={{ fontSize: `${chatStatusTitleFontSize}px`, lineHeight: 1.15 }}>Listening....</p>
                          <p className="mt-1" style={{ fontSize: `${chatStatusSubFontSize}px`, lineHeight: 1.2 }}>(음성 입력 중)</p>
                          <SpeechLevelBars level={liveSpeechLevel} activeColor="#2f85df" inactiveColor="#9ec4f0" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {showRemoteSpeechBubble && (
                <div className="flex justify-start mb-4">
                  <div className="max-w-[70%] flex flex-col items-start">
                    <div className="rounded-2xl px-4 py-3 bg-gray-200 text-gray-800 rounded-bl-sm border border-gray-300">
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
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* 입력 영역 - chatInputEnabled면 입력창+마이크, 아니면 client 스타일 원형 마이크만 (동일 onStartRecording/onStopRecording) */}
        <div className="flex-shrink-0 w-full flex flex-col items-center px-5 py-6 gap-2">
          {chatInputEnabled ? (
            <ChatInput
              onSend={handleSendText}
              placeholder="내용을 입력해주세요."
              isRecording={isRecording}
              onToggleRecording={toggleRecording}
              useFigmaStyle={true}
              fontSize={fontSize}
            />
          ) : (
            <div className="flex flex-col items-center gap-4 w-full">
              {!isRecording && (
                <div
                  className="flex justify-center mb-1"
                  style={{ animation: 'float-point 2s ease-in-out infinite' }}
                  aria-hidden
                >
                  <style>{`@keyframes float-point { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }`}</style>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: FIGMA_SIDEBAR.accent }}>
                    <path d="M8 12v8.5a1.5 1.5 0 0 0 3 0v-7.5" />
                    <path d="M11 13.5v2a1.5 1.5 0 0 0 3 0v-2.5" />
                    <path d="M14 14.5a1.5 1.5 0 0 0 3 0v-1.5" />
                    <path d="M17 13.5a1.5 1.5 0 0 0 3 0v-4.5a6 6 0 0 0-6-6h-2.208a6 6 0 0 0-5.012 2.7l-.196.3q-.468.718-3.286 5.728a1.5 1.5 0 0 0 .536 2.022c.734.44 1.674.325 2.28-.28l1.47-1.47" />
                  </svg>
                </div>
              )}
              <button
                type="button"
                onClick={toggleRecording}
                className="w-[72px] h-[72px] rounded-full flex items-center justify-center transition-transform shadow-lg flex-shrink-0"
                style={{
                  backgroundColor: FIGMA_SIDEBAR.accent,
                  color: '#ffffff',
                  cursor: 'pointer',
                  opacity: 1,
                }}
                aria-label={isRecording ? '녹음 중지' : '음성 입력'}
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
            </div>
          )}
        </div>
      </main>

      {/* 기존 모달형 언어 선택 (드롭다운 외 추가 옵션용 - 숨김 처리하고 드롭다운만 사용) */}
      {showLanguageModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setShowLanguageModal(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-gray-800">내 언어 선택</h2>
              <button type="button" onClick={() => setShowLanguageModal(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {languages.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => { onChangeLanguage(lang.code); setShowLanguageModal(false); }}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${lang.code === language ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-indigo-300 text-gray-700'}`}
                >
                  <p className="font-medium">{lang.name}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 새 채팅 설정 모달: 설정 창과 동일 스타일, 채팅방 생성 전 적용할 설정 */}
      {showNewChatModal && onStartNewChat && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={() => setShowNewChatModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-chat-modal-title"
        >
          <div
            className="bg-white rounded-2xl p-6 shadow-xl w-[420px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-5">
              <p id="new-chat-modal-title" className="text-xl font-semibold text-gray-800">새 채팅</p>
              <button
                type="button"
                onClick={() => setShowNewChatModal(false)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                aria-label="닫기"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex flex-col gap-4 pl-4 pr-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-gray-700">채팅 저장</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={newChatSave}
                  onClick={() => setNewChatSave(!newChatSave)}
                  className="relative inline-flex h-7 w-[72px] flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#13448c] items-center"
                  style={{ backgroundColor: newChatSave ? '#13448c' : '#d1d5db' }}
                >
                  <span className={`pointer-events-none absolute left-1.5 text-xs font-medium transition-opacity ${newChatSave ? 'opacity-50' : 'opacity-100'}`} style={{ color: newChatSave ? '#fff' : '#4b5563' }}>OFF</span>
                  <span className={`pointer-events-none absolute right-1.5 text-xs font-medium transition-opacity ${newChatSave ? 'opacity-100' : 'opacity-50'}`} style={{ color: newChatSave ? '#fff' : '#4b5563' }}>ON</span>
                  <span
                    className={`pointer-events-none inline-block h-7 w-7 rounded-full bg-white shadow ring-0 transition absolute left-0.5 top-1/2 -translate-y-1/2 z-10 ${newChatSave ? 'translate-x-[35px]' : 'translate-x-0'}`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-gray-700">소리 설정</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={newChatTts}
                  onClick={() => setNewChatTts(!newChatTts)}
                  className="relative inline-flex h-7 w-[72px] flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#13448c] items-center"
                  style={{ backgroundColor: newChatTts ? '#13448c' : '#d1d5db' }}
                >
                  <span className={`pointer-events-none absolute left-1.5 text-xs font-medium transition-opacity ${newChatTts ? 'opacity-50' : 'opacity-100'}`} style={{ color: newChatTts ? '#fff' : '#4b5563' }}>OFF</span>
                  <span className={`pointer-events-none absolute right-1.5 text-xs font-medium transition-opacity ${newChatTts ? 'opacity-100' : 'opacity-50'}`} style={{ color: newChatTts ? '#fff' : '#4b5563' }}>ON</span>
                  <span
                    className={`pointer-events-none inline-block h-7 w-7 rounded-full bg-white shadow ring-0 transition absolute left-0.5 top-1/2 -translate-y-1/2 z-10 ${newChatTts ? 'translate-x-[35px]' : 'translate-x-0'}`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-gray-700">글자 크기</span>
                <div className="w-[120px] flex-shrink-0">
                  <FontSizeSelect value={newChatFontSize} onChange={setNewChatFontSize} compact={false} className="w-full" />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-gray-700">도메인</span>
                <select
                  value={newChatDomain}
                  onChange={(e) => setNewChatDomain(e.target.value)}
                  className="w-[120px] border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#13448c] bg-white"
                  style={{ padding: '6px 10px' }}
                >
                  <option value="bank">은행</option>
                  <option value="hospital">병원</option>
                </select>
              </div>
            </div>
            <div className="flex justify-center mt-6 w-full">
              <button
                type="button"
                onClick={() => {
                  onStartNewChat({ chatSave: newChatSave, tts: newChatTts, fontSize: newChatFontSize, domain: newChatDomain })
                  setShowNewChatModal(false)
                }}
                className="w-full py-3 rounded-lg text-sm font-medium text-white hover:opacity-90"
              style={{ backgroundColor: '#13448c' }}
              >
                채팅 시작
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
