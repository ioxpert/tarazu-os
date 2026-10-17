import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'

/**
 * English is bundled (first paint, fallback for every missing key). Hindi is complete and loaded on demand.
 * Punjabi and Gujarati files exist with no strings yet: every UI string is already a key, so adding a language is
 * a translation task with no code change (missing keys fall back to English).
 */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ' },
  { code: 'gu', label: 'ગુજરાતી' },
] as const
export type LanguageCode = (typeof LANGUAGES)[number]['code']

const LANG_KEY = 'tarazu.lang'

const loaders: Record<Exclude<LanguageCode, 'en'>, () => Promise<{ default: Record<string, unknown> }>> = {
  hi: () => import('./hi.json'),
  pa: () => import('./pa.json'),
  gu: () => import('./gu.json'),
}

export function storedLanguage(): LanguageCode {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (LANGUAGES.some((l) => l.code === v)) return v as LanguageCode
  } catch {
    // storage unavailable: default language
  }
  return 'en'
}

export async function setLanguage(code: LanguageCode): Promise<void> {
  if (code !== 'en' && !i18next.hasResourceBundle(code, 'translation')) {
    const mod = await loaders[code]()
    i18next.addResourceBundle(code, 'translation', mod.default)
  }
  await i18next.changeLanguage(code)
  try {
    localStorage.setItem(LANG_KEY, code)
  } catch {
    // not persisted; still applied for this session
  }
  document.documentElement.lang = code
}

export async function initI18n(): Promise<void> {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }, // React escapes
    returnNull: false,
  })
  const lang = storedLanguage()
  if (lang !== 'en') await setLanguage(lang)
}

export { i18next }
