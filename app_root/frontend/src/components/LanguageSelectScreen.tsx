'use client'

import { useMemo, useState, type CSSProperties } from 'react'
import ReactCountryFlag from 'react-country-flag'
import {
  getAlphabetGroupsForTier,
  getFavoritesForTier,
  type LanguageOption,
  type FavoriteLanguageItem,
} from '@/lib/languageList'

/** 알파벳 탭: A–Z 26개 (해당 언어 없으면 빈 목록 표시) */
const ALPHABET_A_TO_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** 언어 코드 → react-country-flag countryCode (ISO 3166-1 alpha-2). 즐겨찾기 + 알파벳 리스트용 */
const LANG_TO_COUNTRY: Record<string, string> = {
  ko: 'KR', 'zh-CN': 'CN', vi: 'VN', th: 'TH', en: 'US',
  uz: 'UZ', tl: 'PH', id: 'ID', ja: 'JP', 'zh-HK': 'HK', 'en-SG': 'SG', fr: 'FR',
  af: 'ZA', sq: 'AL', am: 'ET', ar: 'SA', 'ar-SA': 'SA', hy: 'AM', az: 'AZ', eu: 'ES', be: 'BY',
  bn: 'BD', 'bn-IN': 'IN', bs: 'BA', 'bs-Cyrl': 'BA', bg: 'BG', my: 'MM', ca: 'ES', zh: 'CN',
  'zh-Hans': 'CN', 'zh-Hant': 'TW', 'zh-TW': 'TW', hr: 'HR', cs: 'CZ', da: 'DK', nl: 'NL',
  'nl-BE': 'BE', 'en-AU': 'AU', 'en-CA': 'CA', 'en-GB': 'GB', 'en-US': 'US', 'en-NZ': 'NZ',
  'en-PH': 'PH', 'en-ZA': 'ZA', et: 'EE', fil: 'PH', fi: 'FI', 'fr-CA': 'CA', 'fr-CH': 'CH',
  fy: 'NL', gl: 'ES', ka: 'GE', de: 'DE', el: 'GR', gn: 'PY', gu: 'IN', ha: 'NG', he: 'IL',
  hi: 'IN', hu: 'HU', is: 'IS', ig: 'NG', ga: 'IE', it: 'IT', kn: 'IN', km: 'KH', ky: 'KG',
  lo: 'LA', lv: 'LV', ln: 'CD', lt: 'LT', lb: 'LU', mk: 'MK', ms: 'MY', ml: 'IN', mt: 'MT',
  mr: 'IN', mn: 'MN', ne: 'NP', nb: 'NO', no: 'NO', or: 'IN', fa: 'IR', pl: 'PL', pt: 'PT',
  'pt-BR': 'BR', 'pt-PT': 'PT', pa: 'IN', 'pa-PK': 'PK', ro: 'RO', ru: 'RU', gd: 'GB',
  sr: 'RS', sk: 'SK', sl: 'SI', so: 'SO', es: 'ES', 'es-AR': 'AR', 'es-CL': 'CL', 'es-CO': 'CO',
  'es-419': 'MX', 'es-MX': 'MX', 'es-ES': 'ES', 'es-US': 'US', sw: 'KE', sv: 'SE', tg: 'TJ',
  ta: 'IN', te: 'IN', tr: 'TR', uk: 'UA', ur: 'PK', cy: 'GB', zu: 'ZA',
  si: 'LK', kk: 'KZ',
}

interface LanguageSelectScreenProps {
  onSelectLanguage: (code: string) => void
  /** A: 지정 국가권 언어만, B: 전체 */
  licenseTier?: string
  onClose?: () => void
}

/** 글로브 아이콘 (36x36) */
function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="36"
      height="36"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

/** 탭: 별 = 즐겨찾기, 그 외 = 알파벳 */
const FAVORITES_TAB = '★'

/** Figma "최종_260213" > "언어 선택화면" 스펙 반영 */
function LanguageSelectScreen({ onSelectLanguage, licenseTier = 'B', onClose }: LanguageSelectScreenProps) {
  const [selectedLetter, setSelectedLetter] = useState<string>(() => FAVORITES_TAB)
  const groups = useMemo(() => getAlphabetGroupsForTier(licenseTier), [licenseTier])
  const favoritesForTier = useMemo(() => getFavoritesForTier(licenseTier), [licenseTier])
  const listForLetter = useMemo(
    () => (selectedLetter && selectedLetter !== FAVORITES_TAB ? groups[selectedLetter] ?? [] : []),
    [groups, selectedLetter]
  )

  const handleSelect = (code: string) => {
    onSelectLanguage(code)
  }

  const tabItems = useMemo(() => [FAVORITES_TAB, ...ALPHABET_A_TO_Z], [])
  const showFavorites = selectedLetter === FAVORITES_TAB

  return (
    <div
      className="h-screen w-screen flex items-center justify-center bg-[#ffffff] overflow-hidden"
      style={{ fontFamily: 'Pretendard, sans-serif' }}
    >
      {/* 이전 비율 유지: 전체화면에서도 최대 1368×900 영역으로 제한하고 중앙 배치 */}
      <div
        className="w-full h-full max-w-[1368px] max-h-[900px] flex flex-col min-h-0 overflow-hidden"
      >
        <div
          className="w-full flex-1 flex flex-col min-h-0 px-4 sm:px-6 py-4 sm:py-6"
        >
          {onClose && (
            <div className="w-full flex justify-end mb-2 sm:mb-4">
              <button
                type="button"
                onClick={onClose}
                className="w-10 h-10 rounded-full border border-[#b8c4f0] bg-[#eff2fe] text-[#5c79f6] flex items-center justify-center hover:opacity-90 transition-colors"
                aria-label="닫기"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          {/* 타이틀: 글로브 아이콘 + 문구, 가운데 정렬 */}
          <div className="flex flex-col items-center gap-1.5 sm:gap-2 mb-2 sm:mb-4 w-full flex-shrink-0">
            <GlobeIcon className="w-6 h-6 sm:w-8 sm:h-8 shrink-0 text-[#121212]" />
            <h1
              className="text-[#121212] text-center"
              style={{
                fontFamily: 'Pretendard, sans-serif',
                fontSize: 'clamp(18px, 2.5vw, 26px)',
                fontWeight: 600,
                lineHeight: 1.2,
                letterSpacing: -0.4,
              }}
            >
              Please choose your language
            </h1>
          </div>

          {/* 즐겨찾기/알파벳 공통 표시 영역: 즐겨찾기는 4x3 고정·스크롤 없음, 알파벳은 스크롤 */}
          <section
            className="flex-1 min-h-0 w-full max-w-[75%] mx-auto rounded-xl border border-[#d7d7d7] bg-white overflow-hidden flex flex-col"
          >
            {showFavorites ? (
              <div className="p-3 sm:p-4 flex-1 min-h-0 flex flex-col overflow-hidden">
                <div
                  className="flex-1 min-h-0 grid grid-cols-4 w-full"
                  style={{ gap: '6px', gridTemplateRows: 'repeat(3, minmax(0, 1fr))' }}
                >
                  {favoritesForTier.map((lang) => (
                    <div key={lang.code} className="flex justify-center items-center min-h-0 h-full">
                      <FavoriteButton option={lang} onSelect={handleSelect} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-3 sm:p-4 flex-1 min-h-0 overflow-y-auto">
                <div className="w-full max-w-[100%] mx-auto">
                  <div
                    className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                    style={{ gap: '6px' }}
                  >
                    {listForLetter.map((lang) => (
                      <div key={lang.code} className="flex justify-center">
                        <LangRow option={lang} onSelect={handleSelect} />
                      </div>
                    ))}
                  </div>
                  {listForLetter.length === 0 && (
                    <div className="py-8 text-center text-[#888]" style={{ fontSize: 14 }}>
                      
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* 탭: 별(즐겨찾기) + 알파벳 — 9열 3행, 화면 하단 고정 */}
          <section className="flex-shrink-0 w-full max-w-[75%] mx-auto rounded-lg mt-2 sm:mt-4 p-1 sm:p-1.5" style={{ backgroundColor: '#eff2fe' }}>
            <div
              className="grid grid-cols-9 gap-1"
              style={{ gridTemplateColumns: 'repeat(9, minmax(0, 1fr))' }}
            >
              {tabItems.map((letter) => {
                const isSelected = selectedLetter === letter
                return (
                  <button
                    key={letter}
                    type="button"
                    onClick={() => setSelectedLetter(letter)}
                    className="h-6 sm:h-8 md:h-9 flex items-center justify-center transition-colors rounded-none font-bold border-r border-b border-white [&:nth-child(9n)]:border-r-0 [&:nth-child(n+19)]:border-b-0"
                    style={{
                      fontFamily: 'Pretendard, sans-serif',
                      backgroundColor: isSelected ? 'rgba(204, 213, 252, 0.5)' : 'transparent',
                      color: '#121212',
                      fontSize: 'clamp(12px, 2.5vw, 32px)',
                    }}
                  >
                    {letter}
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/** 국기 가로:세로 비율 (3:2) */
const FLAG_ASPECT_RATIO = 3 / 2

/** 괄호 () 기준으로 [첫 줄, 괄호줄] 반환. 괄호 없으면 line2는 null */
function splitNameAtParen(name: string): [string, string | null] {
  const i = name.indexOf('(')
  if (i === -1) return [name, null]
  return [name.slice(0, i).trim(), name.slice(i)]
}

/** 나라 버튼용 라벨: 괄호 있으면 첫 줄 + 밑줄에 (나라), 글자 영역 세로 중앙 */
function ButtonLabel({
  name,
  className = '',
  style = {},
}: {
  name: string
  className?: string
  style?: CSSProperties
}) {
  const [line1, line2] = splitNameAtParen(name)
  return (
    <span
      className={`flex flex-col items-center justify-center text-center min-w-0 px-2 py-1 ${className}`}
      style={style}
    >
      <span>{line1}</span>
      {line2 != null && <span>{line2}</span>}
    </span>
  )
}

/** 즐겨찾기 버튼: 4x3 그리드 셀에 맞춰 채움. 국기는 남는 공간, 라벨은 하단·세로 중앙 */
function FavoriteButton({
  option,
  onSelect,
}: {
  option: FavoriteLanguageItem
  onSelect: (code: string) => void
}) {
  const countryCode = LANG_TO_COUNTRY[option.code]
  return (
    <button
      type="button"
      onClick={() => onSelect(option.code)}
      className="h-full w-4/5 max-w-full min-h-0 flex flex-col rounded-xl border border-[#d7d7d7] transition-opacity hover:opacity-90 overflow-hidden"
      style={{
        fontFamily: 'Pretendard, sans-serif',
        fontSize: 'clamp(12px, 1.5vw, 18px)',
        fontWeight: 400,
        backgroundColor: '#ffffff',
        color: '#121212',
      }}
    >
      {/* 국기: 셀 높이에 맞춰 남는 공간 채움 */}
      {countryCode ? (
        <span
          className="flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden bg-gray-100 border-b border-[#d7d7d7]"
          aria-hidden
        >
          <ReactCountryFlag
            countryCode={countryCode}
            svg
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </span>
      ) : (
        <span className="flex-1 min-h-0 w-full bg-gray-100 border-b border-[#d7d7d7]" aria-hidden />
      )}
      <span className="flex-shrink-0 flex flex-col items-center justify-center min-h-[2.5em]">
        <ButtonLabel name={option.name} />
      </span>
    </button>
  )
}

/** 알파벳 리스트용 버튼: 국기(버튼 너비에 맞춤, 비율 유지) + 텍스트(국기 아래, 괄호 기준 줄바꿈·세로 중앙) */
function LangRow({
  option,
  onSelect,
}: {
  option: LanguageOption
  onSelect: (code: string) => void
}) {
  const countryCode = LANG_TO_COUNTRY[option.code]
  return (
    <button
      type="button"
      onClick={() => onSelect(option.code)}
      className="w-4/5 flex flex-col rounded-xl border border-[#d7d7d7] transition-opacity hover:opacity-90 overflow-hidden"
      style={{
        fontFamily: 'Pretendard, sans-serif',
        fontSize: 18,
        fontWeight: 400,
        backgroundColor: '#ffffff',
        color: '#121212',
      }}
    >
      {/* 국기: 버튼 너비 전체, 세로는 가로에 맞춘 비율 */}
      {countryCode ? (
        <span
          className="w-full flex items-center justify-center overflow-hidden bg-gray-100 border-b border-[#d7d7d7]"
          style={{ aspectRatio: FLAG_ASPECT_RATIO }}
          aria-hidden
        >
          <ReactCountryFlag
            countryCode={countryCode}
            svg
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </span>
      ) : (
        <span
          className="w-full bg-gray-100 border-b border-[#d7d7d7]"
          style={{ aspectRatio: FLAG_ASPECT_RATIO }}
          aria-hidden
        />
      )}
      <span className="flex flex-col items-center justify-center min-h-[2.5em] flex-shrink-0">
        <ButtonLabel name={option.name} />
      </span>
    </button>
  )
}

export default LanguageSelectScreen
