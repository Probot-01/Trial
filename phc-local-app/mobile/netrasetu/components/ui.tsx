
import React, { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, StyleProp, Text, TextInput, TextInputProps, TextStyle, View, ViewStyle,
} from 'react-native';
import { makeStyles, useTheme } from '../theme/ThemeContext';
import { TOUCH } from '../theme/tokens';

// ── Button (.btn, .btn--outline, .btn--success, .btn--danger, .login-auth-submit) ──
type BtnVariant = 'primary' | 'outline' | 'success' | 'danger' | 'ghost';

export function Btn({
  label, onPress, variant = 'primary', disabled, loading, style, icon, size = 'md', testID, accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  variant?: BtnVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: string;
  size?: 'sm' | 'md' | 'lg';
  testID?: string;
  accessibilityHint?: string;
}) {
  const s = useUiStyles();
  const { theme } = useTheme();
  const box = [
    s.btn,
    size === 'lg' && s.btnLg,
    size === 'sm' && s.btnSm,
    variant === 'outline' && s.btnOutline,
    variant === 'success' && s.btnSuccess,
    variant === 'danger' && s.btnDanger,
    variant === 'ghost' && s.btnGhost,
    (disabled || loading) && s.btnDisabled,
    style,
  ];
  const textColor =
    variant === 'outline' || variant === 'ghost' ? theme.c.crimson
      : variant === 'success' ? '#FFFFFF'
        : theme.c.onCrimson;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [...box, pressed && !disabled && s.btnPressed]}
    >
      {loading ? <ActivityIndicator color={textColor} /> : null}
      <Text style={[s.btnText, size === 'sm' && s.btnTextSm, { color: textColor }]} numberOfLines={2}>
        {icon ? `${icon} ` : ''}{label}
      </Text>
    </Pressable>
  );
}

// ── Section header (.reg-section-header) ──────────────────────────────────
export function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  const s = useUiStyles();
  return (
    <View style={s.section} accessibilityRole="header">
      {badge ? <Text style={s.sectionBadge}>{badge}</Text> : null}
      <Text style={s.sectionTitle} numberOfLines={2}>{title}</Text>
      <View style={s.sectionLine} />
    </View>
  );
}

// ── Label / field (.reg-label, .reg-field) ────────────────────────────────
export function Label({ children, required, style }: { children: ReactNode; required?: boolean; style?: StyleProp<TextStyle> }) {
  const s = useUiStyles();
  return (
    <Text style={[s.label, style]}>
      {required ? <Text style={s.req}>* </Text> : null}{children}
    </Text>
  );
}

export function Field({ label, required, error, hint, children, style }: {
  label: string; required?: boolean; error?: string | null; hint?: string; children: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const s = useUiStyles();
  return (
    <View style={[s.field, style]}>
      <Label required={required}>{label}</Label>
      {children}
      {error ? <Text style={s.error}>{error}</Text> : hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Input({ invalid, style, ...props }: TextInputProps & { invalid?: boolean }) {
  const s = useUiStyles();
  const { theme } = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.c.textMuted}
      {...props}
      style={[s.input, props.multiline && s.inputMulti, invalid && s.inputInvalid, props.editable === false && s.inputReadOnly, style]}
    />
  );
}

/** Two fields side by side on a phone -- the desktop's 4-column .reg-grid, folded. */
export function Row({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 12 }}>{React.Children.map(children, (c) => <View style={{ flex: 1 }}>{c}</View>)}</View>;
}

// ── Chips (.reg-chip / .meta-chip) ────────────────────────────────────────
export interface ChipOption<T extends string> { value: T; label: string }

export function ChipGroup<T extends string>({
  options, value, onChange, columns,
}: {
  options: ChipOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  columns?: number;
}) {
  const s = useUiStyles();
  return (
    <View style={s.chipGroup} accessibilityRole="radiogroup">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[s.chip, columns ? { flexBasis: `${100 / columns - 3}%`, flexGrow: 1 } : null, active && s.chipActive]}
          >
            <Text style={[s.chipText, active && s.chipTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function MultiChipGroup<T extends string>({
  options, values, onToggle, columns,
}: {
  options: ChipOption<T>[];
  values: T[];
  onToggle: (v: T) => void;
  columns?: number;
}) {
  const s = useUiStyles();
  return (
    <View style={s.chipGroup}>
      {options.map((o) => {
        const active = values.includes(o.value);
        return (
          <Pressable
            key={o.value}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: active }}
            onPress={() => onToggle(o.value)}
            style={[s.chip, columns ? { flexBasis: `${100 / columns - 3}%`, flexGrow: 1 } : null, active && s.chipActive]}
          >
            <Text style={[s.chipText, active && s.chipTextActive]}>{active ? '✓ ' : ''}{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Toggle (.meta-toggle) ─────────────────────────────────────────────────
export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  const s = useUiStyles();
  return (
    <Pressable
      style={s.toggleRow}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
    >
      <Label style={{ flex: 1, marginBottom: 0 }}>{label}</Label>
      <View style={[s.track, value && s.trackOn]}>
        <View style={[s.thumb, value && s.thumbOn]} />
      </View>
    </Pressable>
  );
}

// ── Card (.panel / .meta-card) ────────────────────────────────────────────
export function Card({ title, children, style, right }: { title?: string; children: ReactNode; style?: StyleProp<ViewStyle>; right?: ReactNode }) {
  const s = useUiStyles();
  return (
    <View style={[s.card, style]}>
      {title ? (
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>{title}</Text>
          {right}
        </View>
      ) : null}
      <View style={s.cardBody}>{children}</View>
    </View>
  );
}

export function MonoText({ children, style, muted }: { children: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean }) {
  const s = useUiStyles();
  return <Text style={[s.mono, muted && s.muted, style]}>{children}</Text>;
}

/** Left-accented notice box (.referral-notice / .reg-consent-block). */
export function Notice({ title, children, tone = 'crimson', style }: {
  title?: string; children: ReactNode; tone?: 'crimson' | 'warning' | 'success'; style?: StyleProp<ViewStyle>;
}) {
  const s = useUiStyles();
  const { theme } = useTheme();
  const color = tone === 'warning' ? theme.c.warning : tone === 'success' ? theme.c.success : theme.c.crimson;
  return (
    <View style={[s.notice, { borderLeftColor: color }, style]}>
      {title ? <Text style={[s.noticeTitle, { color }]}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={s.noticeText}>{children}</Text> : children}
    </View>
  );
}

export const useUiStyles = makeStyles((t) => ({
  btn: {
    minHeight: TOUCH,
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: t.c.crimson,
    borderWidth: 2,
    borderColor: t.c.crimson,
    shadowColor: t.c.shadow,
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 3,
  },
  btnLg: { minHeight: 56, paddingVertical: 16 },
  btnSm: { minHeight: 36, paddingVertical: 6, paddingHorizontal: 12, elevation: 0, shadowOpacity: 0 },
  btnOutline: { backgroundColor: 'transparent', shadowOpacity: 0, elevation: 0 },
  btnSuccess: { backgroundColor: t.c.success, borderColor: t.c.success },
  btnDanger: { backgroundColor: t.c.danger, borderColor: t.c.danger },
  btnGhost: { backgroundColor: 'transparent', borderColor: 'transparent', shadowOpacity: 0, elevation: 0 },
  btnDisabled: { opacity: 0.45 },
  btnPressed: { transform: [{ translateX: 2 }, { translateY: 2 }], shadowOffset: { width: 1, height: 1 } },
  btnText: {
    fontFamily: t.fonts.monoBold,
    fontSize: t.fontSize.small,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  btnTextSm: { fontSize: t.fontSize.tiny },

  section: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 28, marginBottom: 14 },
  sectionBadge: {
    fontFamily: t.fonts.monoBold,
    fontSize: t.fontSize.mono,
    color: t.c.onCrimson,
    backgroundColor: t.c.crimson,
    paddingHorizontal: 8,
    paddingVertical: 2,
    letterSpacing: 0.6,
  },
  sectionTitle: {
    fontFamily: t.fonts.monoBold,
    fontSize: t.fontSize.mono,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: t.c.text,
    flexShrink: 1,
  },
  sectionLine: { flex: 1, height: 1, backgroundColor: t.c.border, minWidth: 12 },

  field: { marginBottom: 14 },
  label: {
    fontFamily: t.fonts.monoBold,
    fontSize: t.fontSize.tiny,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: t.c.textMuted,
    marginBottom: 6,
  },
  req: { color: t.c.crimson },
  error: { fontFamily: t.fonts.medium, fontSize: 12, color: t.c.danger, marginTop: 4 },
  hint: { fontFamily: t.fonts.body, fontSize: 12, color: t.c.textMuted, marginTop: 4, lineHeight: 16 },
  input: {
    minHeight: TOUCH,
    backgroundColor: t.c.creamDark,
    borderWidth: 1,
    borderColor: t.c.border,
    color: t.c.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: t.fonts.body,
    fontSize: t.fontSize.body,
  },
  inputMulti: { minHeight: 84, textAlignVertical: 'top' },
  inputInvalid: { borderColor: t.c.danger, borderWidth: 1.5 },
  inputReadOnly: { opacity: 0.6 },

  chipGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(196, 43, 43, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chipActive: { backgroundColor: t.c.crimson, borderColor: t.c.crimson },
  chipText: {
    fontFamily: t.fonts.monoBold,
    fontSize: t.fontSize.tiny,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: t.c.text,
    textAlign: 'center',
  },
  chipTextActive: { color: t.c.onCrimson },

  toggleRow: { flexDirection: 'row', alignItems: 'center', minHeight: TOUCH, gap: 12 },
  track: {
    width: 44,
    height: 24,
    borderRadius: 12,
    backgroundColor: t.c.creamDark,
    borderWidth: 1,
    borderColor: t.c.border,
    justifyContent: 'center',
  },
  trackOn: { backgroundColor: t.c.crimson, borderColor: t.c.crimson },
  thumb: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF', marginLeft: 2, elevation: 1 },
  thumbOn: { marginLeft: 22 },

  card: { backgroundColor: t.c.creamLight, borderWidth: 1, borderColor: t.c.border },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: t.c.crimson,
  },
  cardTitle: {
    fontFamily: t.fonts.monoBold,
    fontSize: t.fontSize.mono,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: t.c.text,
  },
  cardBody: { padding: 14 },

  mono: { fontFamily: t.fonts.mono, fontSize: t.fontSize.mono, color: t.c.text },
  muted: { color: t.c.textMuted },

  notice: {
    backgroundColor: t.c.creamDark,
    borderLeftWidth: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  noticeTitle: { fontFamily: t.fonts.monoBold, fontSize: t.fontSize.tiny, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4 },
  noticeText: { fontFamily: t.fonts.body, fontSize: 13, lineHeight: 19, color: t.c.text },
}));
