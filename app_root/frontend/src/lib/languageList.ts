/**
 * 언어 선택 화면용 목록
 * - 즐겨찾기: 3행 4열 (한국어 표기)
 * - 그 외: Google Cloud Translation 지원 언어 기준, 알파벳(영문명) 정렬
 * @see https://cloud.google.com/translate/docs/languages
 */

export interface LanguageOption {
  code: string
  name: string
}

/** 즐겨찾기용: 플래그 + 현지어 이름 + 영문명 (예: 🇰🇷 대한민국/Korea) */
export interface FavoriteLanguageItem {
  code: string
  flag: string
  name: string
  nameEn: string
}

/** 즐겨찾기 12개 (3x4): 플래그/name/nameEn */
export const FAVORITE_LANGUAGES: FavoriteLanguageItem[] = [
  { code: 'ko', flag: '🇰🇷', name: '대한민국', nameEn: 'Korea' },
  { code: 'zh-CN', flag: '🇨🇳', name: '中国', nameEn: 'China' },
  { code: 'vi', flag: '🇻🇳', name: 'Việt Nam', nameEn: 'Vietnam' },
  { code: 'th', flag: '🇹🇭', name: 'ไทย', nameEn: 'Thailand' },
  { code: 'en', flag: '🇺🇸', name: 'United States', nameEn: 'USA' },
  { code: 'uz', flag: '🇺🇿', name: "O'zbekiston", nameEn: 'Uzbekistan' },
  { code: 'tl', flag: '🇵🇭', name: 'Pilipinas', nameEn: 'Philippines' },
  { code: 'id', flag: '🇮🇩', name: 'Indonesia', nameEn: 'Indonesia' },
  { code: 'ja', flag: '🇯🇵', name: '日本', nameEn: 'Japan' },
  { code: 'zh-HK', flag: '🇭🇰', name: '香港', nameEn: 'Hong Kong' },
  { code: 'en-SG', flag: '🇸🇬', name: 'Singapore', nameEn: 'Singapore' },
  { code: 'fr', flag: '🇫🇷', name: 'France', nameEn: 'France' },
]

const FAVORITE_CODES = new Set(FAVORITE_LANGUAGES.map((l) => l.code))

/** 즐겨찾기 항목 중 원본 목록에 없는 것: "언어 (나라)" 형식으로 추가용 */
const FAVORITE_AS_ALPHABET: LanguageOption[] = FAVORITE_LANGUAGES.map((f) => ({
  code: f.code,
  name: `${getLanguageNameEn(f.code)} (${f.nameEn})`,
}))

function getLanguageNameEn(code: string): string {
  const map: Record<string, string> = {
    ko: 'Korean',
    vi: 'Vietnamese',
    th: 'Thai',
    en: 'English',
    uz: 'Uzbek',
    tl: 'Tagalog',
    id: 'Indonesian',
    ja: 'Japanese',
    'zh-HK': 'Chinese',
    'en-SG': 'English',
    fr: 'French',
  }
  return map[code] ?? code
}

/**
 * Google Cloud Translation (Translation LLM) 지원 언어 + 즐겨찾기(목록에 없던 것).
 * 알파벳(영문명) 순 정렬, 형식: 언어 (나라).
 */
const RAW_ALPHABET_LIST: LanguageOption[] = [
  { code: 'af', name: 'Afrikaans' },
    { code: 'sq', name: 'Albanian' },
    { code: 'am', name: 'Amharic' },
    { code: 'ar', name: 'Arabic' },
    { code: 'ar-SA', name: 'Arabic (Saudi Arabia)' },
    { code: 'hy', name: 'Armenian' },
    { code: 'az', name: 'Azerbaijani' },
    { code: 'eu', name: 'Basque' },
    { code: 'be', name: 'Belarusian' },
    { code: 'bn', name: 'Bengali' },
    { code: 'bn-IN', name: 'Bengali (India)' },
    { code: 'bs', name: 'Bosnian' },
    { code: 'bs-Cyrl', name: 'Bosnian (Cyrillic)' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'my', name: 'Burmese' },
    { code: 'ca', name: 'Catalan' },
    { code: 'zh', name: 'Chinese' },
    { code: 'zh-Hans', name: 'Chinese (Simplified)' },
    { code: 'zh-Hant', name: 'Chinese (Traditional)' },
    { code: 'zh-TW', name: 'Chinese (Taiwan)' },
    { code: 'hr', name: 'Croatian' },
    { code: 'cs', name: 'Czech' },
    { code: 'da', name: 'Danish' },
    { code: 'nl', name: 'Dutch' },
    { code: 'nl-BE', name: 'Dutch (Belgium)' },
    { code: 'en-AU', name: 'English (Australia)' },
    { code: 'en-CA', name: 'English (Canada)' },
    { code: 'en-GB', name: 'English (United Kingdom)' },
    { code: 'en-US', name: 'English (United States)' },
    { code: 'en-NZ', name: 'English (New Zealand)' },
    { code: 'en-PH', name: 'English (Philippines)' },
    { code: 'en-ZA', name: 'English (South Africa)' },
    { code: 'et', name: 'Estonian' },
    { code: 'fil', name: 'Filipino' },
    { code: 'fi', name: 'Finnish' },
    { code: 'fr-CA', name: 'French (Canada)' },
    { code: 'fr-CH', name: 'French (Switzerland)' },
    { code: 'fy', name: 'Frisian' },
    { code: 'gl', name: 'Galician' },
    { code: 'ka', name: 'Georgian' },
    { code: 'de', name: 'German' },
    { code: 'el', name: 'Greek' },
    { code: 'gn', name: 'Guarani' },
    { code: 'gu', name: 'Gujarati' },
    { code: 'ha', name: 'Hausa' },
    { code: 'he', name: 'Hebrew' },
    { code: 'hi', name: 'Hindi' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'is', name: 'Icelandic' },
    { code: 'ig', name: 'Igbo' },
    { code: 'ga', name: 'Irish' },
    { code: 'it', name: 'Italian' },
    { code: 'kn', name: 'Kannada' },
    { code: 'km', name: 'Khmer' },
    { code: 'kk', name: 'Kazakh' },
    { code: 'ky', name: 'Kyrgyz' },
    { code: 'lo', name: 'Lao' },
    { code: 'lv', name: 'Latvian' },
    { code: 'ln', name: 'Lingala' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'lb', name: 'Luxembourgish' },
    { code: 'mk', name: 'Macedonian' },
    { code: 'ms', name: 'Malay' },
    { code: 'ml', name: 'Malayalam' },
    { code: 'mt', name: 'Maltese' },
    { code: 'mr', name: 'Marathi' },
    { code: 'mn', name: 'Mongolian' },
    { code: 'ne', name: 'Nepali' },
    { code: 'nb', name: 'Norwegian Bokmal' },
    { code: 'no', name: 'Norwegian' },
    { code: 'or', name: 'Odia' },
    { code: 'fa', name: 'Persian' },
    { code: 'pl', name: 'Polish' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'pt-BR', name: 'Portuguese (Brazil)' },
    { code: 'pt-PT', name: 'Portuguese (Portugal)' },
    { code: 'pa', name: 'Punjabi' },
    { code: 'pa-PK', name: 'Punjabi (Pakistan)' },
    { code: 'ro', name: 'Romanian' },
    { code: 'ru', name: 'Russian' },
    { code: 'gd', name: 'Scots Gaelic' },
    { code: 'sr', name: 'Serbian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'si', name: 'Sinhala' },
    { code: 'sl', name: 'Slovenian' },
    { code: 'so', name: 'Somali' },
    { code: 'es', name: 'Spanish' },
    { code: 'es-AR', name: 'Spanish (Argentina)' },
    { code: 'es-CL', name: 'Spanish (Chile)' },
    { code: 'es-CO', name: 'Spanish (Colombia)' },
    { code: 'es-419', name: 'Spanish (Latin America)' },
    { code: 'es-MX', name: 'Spanish (Mexico)' },
    { code: 'es-ES', name: 'Spanish (Spain)' },
    { code: 'es-US', name: 'Spanish (United States)' },
    { code: 'sw', name: 'Swahili' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tg', name: 'Tajik' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'tr', name: 'Turkish' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'ur', name: 'Urdu' },
    { code: 'cy', name: 'Welsh' },
    { code: 'zu', name: 'Zulu' },
]

const RAW_CODES = new Set(RAW_ALPHABET_LIST.map((l) => l.code))
const ADDED_FAVORITES = FAVORITE_AS_ALPHABET.filter((l) => !RAW_CODES.has(l.code))

export const ALPHABET_LANGUAGES: LanguageOption[] = [...RAW_ALPHABET_LIST, ...ADDED_FAVORITES].sort(
  (a, b) => a.name.localeCompare(b.name, 'en')
)

/** 알파벳(영문명 첫 글자)별 그룹. 탭용. */
export function getAlphabetGroups(): Record<string, LanguageOption[]> {
  const groups: Record<string, LanguageOption[]> = {}
  for (const lang of ALPHABET_LANGUAGES) {
    const first = (lang.name[0] || '').toUpperCase()
    if (!/^[A-Z]$/.test(first)) continue
    if (!groups[first]) groups[first] = []
    groups[first].push(lang)
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }
  return groups
}

/**
 * 알파벳 탭에 쓸 글자 목록 (언어가 있는 첫 글자만, A–Z 순).
 * 빠진 글자(X 등): ALPHABET_LANGUAGES(Google Cloud 번역 지원 언어 중 즐겨찾기 제외)의
 * 영문명(name) 첫 글자로만 그룹을 만드므로, 그 글자로 시작하는 언어가 하나도 없으면 탭에 안 뜹니다.
 * 예: 영문명이 X로 시작하는 언어가 목록에 없으면 X 탭은 비어 있어서 제외됩니다.
 */
export const ALPHABET_TAB_LETTERS = (() => {
  const g = getAlphabetGroups()
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((letter) => g[letter]?.length)
})()

/**
 * 라이센스 등급 A: 지정 국가/지역에 대응하는 번역·STT·TTS 언어 코드만 허용.
 * B: 제한 없음. 한국어(ko)는 상담 원어로 항상 A에서도 허용.
 */
export const TIER_A_ALLOWED_CODES: ReadonlySet<string> = new Set([
  'ko',
  // 중국·대만·홍콩·싱가포르
  'zh-CN','zh','zh-Hans','zh-Hant','zh-TW','zh-HK','en-SG',
  // 동남아·남아시아 등
  'vi','th','uz','tl','fil','en-PH','ja','ne','id','km','mn','my', 'lo','ms','bn','bn-IN','hi','ta','te','kn','ml','mr','gu','pa','or','ur','pa-PK','si','kk',
  // 미국·영어권
  'en','en-US','en-GB','en-AU','en-CA','en-NZ','en-ZA',
  // 유럽
  'fr','fr-CA','fr-CH','de','nl','nl-BE','sv','da','pl','cs','hu','ro','uk','es','es-ES','es-MX','es-419','it','pt-BR',
  // 러시아·중앙아
  'ru','ky',
  // 중동·아프리카
  'tr','fa','ar','ar-SA','am','sw','ig','ha','af','zu',
])

export function isLanguageAllowedForTier(code: string, tier: string): boolean {
  if (tier !== 'A') return true
  return TIER_A_ALLOWED_CODES.has(code)
}

export function getFavoritesForTier(tier: string): FavoriteLanguageItem[] {
  if (tier !== 'A') return FAVORITE_LANGUAGES
  return FAVORITE_LANGUAGES.filter((f) => TIER_A_ALLOWED_CODES.has(f.code))
}

function buildAlphabetGroupsFromList(list: LanguageOption[]): Record<string, LanguageOption[]> {
  const groups: Record<string, LanguageOption[]> = {}
  for (const lang of list) {
    const first = (lang.name[0] || '').toUpperCase()
    if (!/^[A-Z]$/.test(first)) continue
    if (!groups[first]) groups[first] = []
    groups[first].push(lang)
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }
  return groups
}

/** 등급 A일 때 허용 코드만 알파벳 탭 그룹으로 */
export function getAlphabetGroupsForTier(tier: string): Record<string, LanguageOption[]> {
  if (tier !== 'A') return getAlphabetGroups()
  const list = ALPHABET_LANGUAGES.filter((l) => TIER_A_ALLOWED_CODES.has(l.code))
  return buildAlphabetGroupsFromList(list)
}
