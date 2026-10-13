'use client'

import { useEffect, useState, useRef } from 'react'
import FontSizeSelect, { SETTINGS_DROPDOWN_TOKENS } from './FontSizeSelect'

export type CounselorChatSettingsApply = {
  chatSave: boolean
  tts: boolean
  chatInputEnabled: boolean
  fontSize: number
  domain: string
}

export type AudioInputOption = {
  deviceId: string
  label: string
}

const DOMAIN_OPTIONS = [
  { id: 'bank', name: '은행' },
  { id: 'hospital', name: '병원' },
]

/** 용어 사전 / 원격 관리 / 시스템 종료 — 본문 #13448c보다 연한 톤 */
const ROW_ACTION_BTN_CLASS =
  'w-full rounded-lg font-medium transition-colors border border-[#c8d9eb] bg-[#e8f1fa] text-[#13448c] hover:bg-[#dae8f6]'


type Props = {
  open: boolean
  initialChatSave: boolean
  initialTts?: boolean
  initialChatInputEnabled: boolean
  initialFontSize: number
  initialDomain?: string
  onApply: (settings: CounselorChatSettingsApply) => void
  onOpenWordDictionary?: () => void
  /** 마이크 설정 모달 열기 */
  onOpenMicSetup?: () => void
  /** 원격 관리 링크를 앱 내 오버레이로 열기 */
  onOpenRemote?: () => void
  dismissible?: boolean
  onDismiss?: () => void
}

export default function CounselorChatSettingsModal({
  open,
  initialChatSave,
  initialTts = false,
  initialChatInputEnabled,
  initialFontSize,
  initialDomain = 'bank',
  onApply,
  onOpenWordDictionary,
  onOpenRemote,
  dismissible = false,
  onDismiss,
}: Props) {
  const [chatSave, setChatSave] = useState(initialChatSave)
  const [tts, setTts] = useState(initialTts)
  const [chatInputEnabled, setChatInputEnabled] = useState(initialChatInputEnabled)
  const [fontSize, setFontSize] = useState(initialFontSize)
  const [domain, setDomain] = useState(initialDomain)
  const [domainOpen, setDomainOpen] = useState(false)
  const domainDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setChatSave(initialChatSave)
      setTts(initialTts)
      setChatInputEnabled(initialChatInputEnabled)
      setFontSize(initialFontSize)
      setDomain(initialDomain)
    } else {
      setDomainOpen(false)
    }
  }, [open, initialChatSave, initialTts, initialChatInputEnabled, initialFontSize, initialDomain])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (domainDropdownRef.current && !domainDropdownRef.current.contains(e.target as Node)) {
        setDomainOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  if (!open) return null

  const close = () => onDismiss?.()

  // 글자 크기 20px일 때의 1rem 기준으로 모달 크기 고정 (앱 설정 영향 없음)
  const R = 20
  const s = {
    titleFontSize: 1.25 * R,      // text-xl
    labelFontSize: 0.875 * R,     // text-sm 17.5
    smallFontSize: 0.75 * R,      // text-xs 15
    cardPadding: 1.5 * R,        // p-6 → 30
    cardRadius: 1 * R,            // rounded-2xl → 20
    headerMarginBottom: 1.25 * R, // mb-5 → 25
    closePadding: 0.25 * R,       // p-1 → 5
    closeIconSize: 1.5 * R,       // h-6 w-6 → 30
    gridGapY: 1.25 * R,           // gap-y-5 → 25
    gridGapX: 1 * R,              // gap-x-4 → 20
    gridPaddingX: 1 * R,          // pl-4 pr-4 → 20
    toggleHeight: 1.75 * R,       // h-7 → 35
    toggleWidth: 72,
    knobInset: 0.125 * R,         // 왼쪽 여백 2.5
    knobInsetRight: 0.25 * R,     // 오른쪽 여백 5
    knobSize: 1.5 * R,            // h-6 w-6 → 30
    knobTranslateOn: 72 - 0.125 * R - 1.5 * R - 0.25 * R, // 34
    toggleTextInset: 0.375 * R,   // left-1.5 → 7.5
    submitPaddingY: 0.75 * R,     // py-3 → 15
    submitMarginTop: 1.5 * R,    // mt-6 → 30
    saveBtnMarginTop: 0.75 * R,  // 설정 저장 위 간격
  }

  const Toggle = ({
    checked,
    onChange,
  }: {
    checked: boolean
    onChange: () => void
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="relative inline-flex flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#13448c] items-center justify-self-end self-center"
      style={{
        backgroundColor: checked ? '#13448c' : '#d1d5db',
        height: s.toggleHeight,
        width: s.toggleWidth,
      }}
    >
      <span
        className="pointer-events-none inline-block rounded-full bg-white shadow ring-0 transition-[transform] duration-200 absolute top-1/2 -translate-y-1/2 z-10"
        style={{
          left: s.knobInset,
          width: s.knobSize,
          height: s.knobSize,
          transform: checked
            ? `translateX(${s.knobTranslateOn}px) translateY(-50%)`
            : 'translateX(0) translateY(-50%)',
        }}
      />
    </button>
  )

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="counselor-chat-settings-title"
      onClick={dismissible ? close : undefined}
    >
      <div
        className="bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          fontSize: `${R}px`,
          width: 420,
          padding: s.cardPadding,
          borderRadius: s.cardRadius,
        }}
      >
        <div className="flex justify-between items-center" style={{ marginBottom: s.headerMarginBottom }}>
          <p id="counselor-chat-settings-title" className="font-semibold text-gray-800 leading-tight" style={{ fontSize: s.titleFontSize }}>
            채팅 설정
          </p>
          {onDismiss && (
            <button
              type="button"
              onClick={close}
              className="rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              style={{ padding: s.closePadding }}
              aria-label="닫기"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ width: s.closeIconSize, height: s.closeIconSize, flexShrink: 0 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center"
          style={{ gap: `${s.gridGapY}px ${s.gridGapX}px`, paddingLeft: s.gridPaddingX, paddingRight: s.gridPaddingX }}
        >
          <span className="font-medium text-gray-700 self-center" style={{ fontSize: s.labelFontSize }}>채팅 저장</span>
          <Toggle checked={chatSave} onChange={() => setChatSave(!chatSave)} />

          <span className="font-medium text-gray-700 self-center" style={{ fontSize: s.labelFontSize }}>소리 설정</span>
          <Toggle checked={tts} onChange={() => setTts(!tts)} />

          <span className="font-medium text-gray-700 self-center" style={{ fontSize: s.labelFontSize }}>채팅 입력</span>
          <Toggle checked={chatInputEnabled} onChange={() => setChatInputEnabled(!chatInputEnabled)} />

          <span className="font-medium text-gray-700 self-center" style={{ fontSize: s.labelFontSize }}>글자 크기</span>
          <div className="flex-shrink-0 justify-self-end self-center" style={{ width: 120 }}>
            <FontSizeSelect value={fontSize} onChange={setFontSize} compact={false} fixedSize className="w-full" />
          </div>

          <span className="font-medium text-gray-700 self-center" style={{ fontSize: s.labelFontSize }}>도메인</span>
          <div
            ref={domainDropdownRef}
            className="flex-shrink-0 justify-self-end self-center relative"
            style={{ width: 120 }}
          >
            <div className="relative flex items-center w-full">
              <button
                type="button"
                onClick={() => setDomainOpen((v) => !v)}
                className="rounded-full font-medium flex items-center justify-center gap-2 transition-colors hover:opacity-90 w-full focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-[#5c79f6]"
                style={{
                  minWidth: 120,
                  backgroundColor: SETTINGS_DROPDOWN_TOKENS.triggerBg,
                  border: '1px solid',
                  borderColor: SETTINGS_DROPDOWN_TOKENS.triggerBorder,
                  color: SETTINGS_DROPDOWN_TOKENS.triggerColor,
                  height: 2.25 * R,
                  paddingLeft: 1 * R,
                  paddingRight: 1 * R,
                  fontSize: 0.875 * R,
                  gap: 0.5 * R,
                }}
                aria-expanded={domainOpen}
                aria-haspopup="listbox"
                aria-label="도메인"
              >
                <span>{DOMAIN_OPTIONS.find((o) => o.id === domain)?.name ?? domain}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="flex-shrink-0 opacity-70"
                  style={{ width: R, height: R }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              {domainOpen && (
                <div
                  className="absolute top-full right-0 overflow-y-auto bg-white border shadow-lg z-[110]"
                  style={{
                    borderColor: SETTINGS_DROPDOWN_TOKENS.panelBorder,
                    marginTop: 0.25 * R,
                    width: 140,
                    borderRadius: 0.5 * R,
                    paddingTop: 0.25 * R,
                    paddingBottom: 0.25 * R,
                  }}
                  role="listbox"
                  aria-label="도메인 선택"
                >
                  {DOMAIN_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={domain === opt.id}
                      onClick={() => {
                        setDomain(opt.id)
                        setDomainOpen(false)
                      }}
                      className="w-full flex items-center justify-between gap-3 hover:bg-gray-50 text-left text-gray-800 flex-shrink-0"
                      style={{
                        minHeight: 3 * R,
                        paddingLeft: 1 * R,
                        paddingRight: 1 * R,
                        fontSize: 0.875 * R,
                      }}
                    >
                      <span>{opt.name}</span>
                      <span
                        className="flex-shrink-0 inline-flex justify-end"
                        style={{ width: 1.25 * R, minWidth: 1.25 * R }}
                      >
                        {domain === opt.id ? (
                          <span style={{ color: SETTINGS_DROPDOWN_TOKENS.triggerColor, fontSize: 0.75 * R }}>✓</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 하단: 용어 사전 1행 + 원격 바로가기 1행 */}
        <div style={{ marginTop: s.submitMarginTop }}>
          <div
            className="grid grid-cols-1 w-full"
            style={{ gap: `${0.75 * R}px` }}
          >
            <button
              type="button"
              onClick={onOpenWordDictionary}
              disabled={!onOpenWordDictionary}
              className={ROW_ACTION_BTN_CLASS}
              style={{
                paddingTop: s.submitPaddingY,
                paddingBottom: s.submitPaddingY,
                fontSize: s.labelFontSize,
                opacity: onOpenWordDictionary ? 1 : 0.4,
              }}
            >
              용어 사전
            </button>
          </div>
          <button
            type="button"
            onClick={onOpenRemote}
            disabled={!onOpenRemote}
            className={ROW_ACTION_BTN_CLASS}
            style={{
              width: '100%',
              paddingTop: s.submitPaddingY,
              paddingBottom: s.submitPaddingY,
              fontSize: s.labelFontSize,
              opacity: onOpenRemote ? 1 : 0.4,
              marginTop: 0.75 * R,
            }}
          >
            원격용 바탕화면 바로가기
          </button>
        </div>

        <button
          type="button"
          onClick={() => onApply({ chatSave, tts, chatInputEnabled, fontSize, domain })}
          className="w-full rounded-lg font-medium text-white hover:opacity-90"
          style={{
            backgroundColor: '#13448c',
            paddingTop: s.submitPaddingY,
            paddingBottom: s.submitPaddingY,
            fontSize: s.labelFontSize,
            marginTop: s.saveBtnMarginTop,
          }}
        >
          설정 저장
        </button>
      </div>
    </div>
  )
}
