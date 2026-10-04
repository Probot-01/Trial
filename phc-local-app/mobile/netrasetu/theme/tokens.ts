

export interface Palette {
  crimson: string;
  crimsonLight: string;
  crimsonDark: string;
  crimsonDim: string;
  black: string;
  surface: string;
  surfaceAlt: string;
  cream: string;
  creamLight: string;
  creamDark: string;
  grid: string;
  text: string;
  textMuted: string;
  onCrimson: string;
  success: string;
  successBg: string;
  successBorder: string;
  warning: string;
  warningBg: string;
  warningBorder: string;
  danger: string;
  dangerBg: string;
  dangerBorder: string;
  border: string;
  headerBg: string;
  overlay: string;
  shadow: string;
}

export const light: Palette = {
  crimson: '#C42B2B',
  crimsonLight: '#D94444',
  crimsonDark: '#9B1B1B',
  crimsonDim: '#6E1414',
  black: '#1A1008',
  surface: '#FAF6EF',
  surfaceAlt: '#F0E4D0',
  cream: '#F5EDE0',
  creamLight: '#FAF6EF',
  creamDark: '#E8DCC8',
  grid: 'rgba(26, 16, 8, 0.10)',
  text: '#2C1810',
  textMuted: 'rgba(44, 24, 16, 0.55)',
  onCrimson: '#FAF6EF',
  success: '#2D8F6F',
  successBg: '#EAF5E9',
  successBorder: '#A5D6A7',
  warning: '#D4860A',
  warningBg: '#FFF4E0',
  warningBorder: '#F2C27A',
  danger: '#A82222',
  dangerBg: 'rgba(230, 20, 20, 0.08)',
  dangerBorder: '#C42B2B',
  border: 'rgba(26, 16, 8, 0.18)',
  headerBg: 'rgba(250, 246, 239, 0.96)',
  overlay: 'rgba(26, 16, 8, 0.55)',
  shadow: '#000000',
};

export const dark: Palette = {
  crimson: '#E05555',
  crimsonLight: '#F06666',
  crimsonDark: '#C03030',
  crimsonDim: '#7A1C1C',
  black: '#F0E4D0',
  surface: '#0D0A06',
  surfaceAlt: '#161209',
  cream: '#161209',
  creamLight: '#1C1710',
  creamDark: '#221C14',
  grid: 'rgba(224, 85, 85, 0.07)',
  text: '#EDE0CC',
  textMuted: 'rgba(237, 224, 204, 0.50)',
  onCrimson: '#FFFFFF',
  success: '#3FB38C',
  successBg: 'rgba(63, 179, 140, 0.12)',
  successBorder: 'rgba(63, 179, 140, 0.45)',
  warning: '#E8A13A',
  warningBg: 'rgba(232, 161, 58, 0.12)',
  warningBorder: 'rgba(232, 161, 58, 0.45)',
  danger: '#F06666',
  dangerBg: 'rgba(224, 85, 85, 0.12)',
  dangerBorder: '#E05555',
  border: 'rgba(237, 224, 204, 0.14)',
  headerBg: 'rgba(13, 10, 6, 0.96)',
  overlay: 'rgba(0, 0, 0, 0.7)',
  shadow: '#000000',
};

/** Font families. RN on Android ignores fontWeight for custom fonts, so each weight is its own family. */
export const fonts = {
  body: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  heavy: 'Inter_900Black',
  serif: 'PlayfairDisplay_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
  monoBold: 'JetBrainsMono_700Bold',
  monoHeavy: 'JetBrainsMono_800ExtraBold',
};

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

export const fontSize = { tiny: 10, mono: 11, small: 13, body: 15, h3: 17, h2: 20, h1: 24, display: 30 } as const;

/** Minimum touch target (Android guideline) -- the desktop's small buttons are grown to this on mobile. */
export const TOUCH = 48;

export interface Theme {
  mode: 'light' | 'dark';
  c: Palette;
  fonts: typeof fonts;
  space: typeof space;
  fontSize: typeof fontSize;
}
