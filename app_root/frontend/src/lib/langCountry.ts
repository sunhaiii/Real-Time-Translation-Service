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
  ta: 'IN', te: 'IN', tr: 'TR', uk: 'UA', ur: 'PK', cy: 'GB', zu: 'ZA', si: 'LK', kk: 'KZ',
}

export function getCountryCodeForLang(code: string): string | undefined {
  return LANG_TO_COUNTRY[code]
}
