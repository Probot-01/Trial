
import React, { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react';
import { Animated, Pressable, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles } from '../theme/ThemeContext';

type Tone = 'error' | 'info' | 'success';
interface ToastState { message: string; tone: Tone }

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => { });

export function ToastProvider({ children }: { children: ReactNode }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setToast(null));
  }, [opacity]);

  const show = useCallback((message: string, tone: Tone = 'error') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, tone });
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    timer.current = setTimeout(hide, tone === 'error' ? 6000 : 3500);
  }, [hide, opacity]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <Animated.View style={[s.wrap, { top: insets.top + 8, opacity }]} accessibilityLiveRegion="polite">
          <Pressable onPress={hide} style={[s.toast, toast.tone === 'success' && s.success, toast.tone === 'info' && s.info]}>
            <Text style={s.icon}>{toast.tone === 'error' ? '⚠' : toast.tone === 'success' ? '✓' : 'ℹ'}</Text>
            <Text style={s.text}>{toast.message}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

const useStyles = makeStyles((t) => ({
  wrap: { position: 'absolute', left: 12, right: 12, zIndex: 100 },
  toast: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: t.c.creamLight,
    borderWidth: 2,
    borderColor: t.c.crimson,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 6,
  },
  success: { borderColor: t.c.success },
  info: { borderColor: t.c.warning },
  icon: { fontFamily: t.fonts.monoBold, color: t.c.crimson, fontSize: 14 },
  text: { flex: 1, fontFamily: t.fonts.medium, fontSize: 13, lineHeight: 18, color: t.c.text },
}));
