

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import hi from './locales/hi.json';
import mr from './locales/mr.json';
import te from './locales/te.json';
import ta from './locales/ta.json';
import pa from './locales/pa.json';
import bn from './locales/bn.json';
import { mobileEn } from './mobile.en';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिंदी' },
  { code: 'mr', name: 'मराठी' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'pa', name: 'ਪੰਜਾਬੀ' },
  { code: 'bn', name: 'বাংলা' },
] as const;

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: { ...en, mobile: mobileEn } },
    hi: { translation: hi },
    mr: { translation: mr },
    te: { translation: te },
    ta: { translation: ta },
    pa: { translation: pa },
    bn: { translation: bn },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
