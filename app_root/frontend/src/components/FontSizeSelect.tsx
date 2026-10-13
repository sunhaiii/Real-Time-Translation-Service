'use client'

import { useState, useRef, useEffect } from 'react'

export const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30] as const
export type FontSizeOption = (typeof FONT_SIZE_OPTIONS)[number]

const FONT_SIZE_LABELS: Record<number, string> = {
  12: '12px',
  14: '14px',
  16: '16px',
  18: '18px',
  20: '20px',
  22: '22px',
  24: '24px',
  26: '26px',
  28: '28px',
  30: '30px',
}

const STORAGE_KEY = 'app-font-size'
export const DEFAULT_FONT_SIZE = 20

export function getStoredFontSize(): number {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
  const stored = localStorage.getItem(STORAGE_KEY)
  const n = stored ? parseInt(stored, 10) : NaN
  return FONT_SIZE_OPTIONS.includes(n as FontSizeOption) ? n : DEFAULT_FONT_SIZE
}

export function setStoredFontSize(px: number): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, String(px))
}

/** 채팅 설정 모달 등 — 글자 크기·도메인 드롭다운 공통 토큰 */
export const SETTINGS_DROPDOWN_TOKENS = {
  triggerBg: '#eff2fe',
  triggerBorder: '#5c79f6',
  triggerColor: '#5c79f6',
  panelBorder: '#b0b0b0',
} as const

const DROPDOWN_STYLE = SETTINGS_DROPDOWN_TOKENS

interface FontSizeSelectProps {
  value: number
  onChange: (px: number) => void
  /** 헤더용 작은 스타일(트리거만). false면 모달 등에서 사용하는 넓은 스타일 */
  compact?: boolean
  /** true면 20px(1rem) 기준 px로 고정 (채팅 설정 모달 등) */
  fixedSize?: boolean
  className?: string
}

export default function FontSizeSelect({
  value,
  onChange,
  compact = true,
  fixedSize = false,
  className = '',
}: FontSizeSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  // fixedSize: 20px일 때 1rem=20 기준 (h-9=45, px-4=20, text-sm=17.5, gap-2=10, icon 20)
  const R = 20
  const triggerStyle = {
    minWidth: compact ? 93 : 120,
    backgroundColor: DROPDOWN_STYLE.triggerBg,
    border: '1px solid',
    borderColor: DROPDOWN_STYLE.triggerBorder,
    color: DROPDOWN_STYLE.triggerColor,
    ...(fixedSize && {
      height: 2.25 * R,   // h-9
      paddingLeft: 1 * R,
      paddingRight: 1 * R,
      fontSize: 0.875 * R, // text-sm
      gap: 0.5 * R,
    }),
  }

  return (
    <div className={`relative flex items-center ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full font-medium flex items-center justify-center gap-2 transition-colors hover:opacity-90 ${compact ? '' : 'w-full'} ${fixedSize ? '' : 'h-9 px-4 text-sm'}`}
        style={triggerStyle}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="글자 크기"
        title="글자 크기"
      >
        <span>{FONT_SIZE_LABELS[value] ?? `${value}px`}</span>
        <svg xmlns="http://www.w3.org/2000/svg" className={fixedSize ? 'flex-shrink-0 opacity-70' : 'h-4 w-4 flex-shrink-0 opacity-70'} style={fixedSize ? { width: 1 * R, height: 1 * R } : undefined} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute top-full right-0 overflow-y-auto bg-white border shadow-lg z-50 ${!fixedSize ? 'mt-1 w-[140px] max-h-[300px] rounded-lg py-1' : ''}`}
          style={{
            borderColor: DROPDOWN_STYLE.panelBorder,
            ...(fixedSize && {
              marginTop: 0.25 * R,
              width: 140,
              maxHeight: 300,
              borderRadius: 0.5 * R,
              paddingTop: 0.25 * R,
              paddingBottom: 0.25 * R,
            }),
          }}
          role="listbox"
          aria-label="글자 크기 선택"
        >
          {FONT_SIZE_OPTIONS.map((px) => (
            <button
              key={px}
              type="button"
              role="option"
              aria-selected={value === px}
              onClick={() => {
                onChange(px)
                setOpen(false)
              }}
              className={`w-full flex items-center justify-between gap-3 hover:bg-gray-50 text-left flex-shrink-0 text-gray-800 ${!fixedSize ? 'h-12 px-4 text-sm' : ''}`}
              style={{
                ...(fixedSize && {
                  minHeight: 3 * R,   // h-12
                  paddingLeft: 1 * R,
                  paddingRight: 1 * R,
                  fontSize: 0.875 * R,
                }),
              }}
            >
              <span>{FONT_SIZE_LABELS[px]}</span>
              {/* 선택된 항목만 체크, 비선택은 > 없이 공간만 확보 */}
              <span className="flex-shrink-0" style={{ width: fixedSize ? 1.25 * R : 20, minWidth: fixedSize ? 1.25 * R : 20, display: 'inline-flex', justifyContent: 'flex-end' }}>
                {value === px ? (
                  <span style={{ color: DROPDOWN_STYLE.triggerColor, ...(fixedSize && { fontSize: 0.75 * R }) }}>✓</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
