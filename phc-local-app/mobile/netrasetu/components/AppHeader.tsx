
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { makeStyles, useTheme } from '../theme/ThemeContext';
import { useSync } from '../sync/useSync';
import { syncManager } from '../sync/syncManager';
import { useAuth } from '../auth/AuthContext';
import { getConfig } from '../config';
import { LANGUAGES } from '../i18n';
import { kvSet } from '../db/database';
import { formatAgo } from '../lib/format';
import { Btn } from './ui';
import { useToast } from './Toast';
import { exportBundleToShare, importBundleFromPicker } from '../peer/bundleFiles';

function useConsoleMessage(): string {
  const sync = useSync();
  if (sync.activity) return sync.activity;
  if (sync.connectivity === 'offline') return `OFFLINE · ${sync.pendingCount} CASE(S) SAVED ON DEVICE`;
  if (sync.connectivity === 'no_server') return `CENTRAL SERVER UNREACHABLE · RETRYING`;
  if (sync.connectivity === 'unknown') return 'CHECKING CONNECTION...';
  if (sync.pendingCount > 0) return `${sync.pendingCount} CASE(S) WAITING TO SYNC`;
  return `ALL CASES SYNCED · LAST ${formatAgo(sync.lastSyncAt).toUpperCase()}`;
}

/** Typewriter reveal of the current message (the desktop console's look, honest content). */
function ConsoleLine() {
  const s = useStyles();
  const message = useConsoleMessage();
  const [shown, setShown] = useState('');
  useEffect(() => {
    let i = 0;
    setShown('');
    const id = setInterval(() => {
      i += 2;
      setShown(message.slice(0, i));
      if (i >= message.length) clearInterval(id);
    }, 25);
    return () => clearInterval(id);
  }, [message]);
  return (
    <View style={s.console}>
      <Text style={s.consoleText} numberOfLines={1}>{'> '}{shown}<Text style={s.caret}>▍</Text></Text>
    </View>
  );
}

export function SyncChip() {
  const s = useStyles();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const sync = useSync();
  const online = sync.connectivity === 'online';
  const label = online ? t('header.status.online') : sync.connectivity === 'no_server' ? t('mobile.noServer', 'NO SERVER') : t('header.status.offline');
  return (
    <Pressable style={s.chip} onPress={() => syncManager.trigger()} accessibilityLabel={`${label}, ${sync.pendingCount} pending. Tap to sync now.`}>
      <Text style={s.phc} numberOfLines={1}>{getConfig().phcName.toUpperCase()}</Text>
      <View style={s.chipRow}>
        <View style={[s.dot, { backgroundColor: online ? theme.c.success : sync.connectivity === 'unknown' ? theme.c.textMuted : theme.c.crimson }]} />
        <Text style={s.chipText}>{label}</Text>
        <Text style={[s.chipText, { opacity: 0.6 }]}> ● {sync.pendingCount} {t('header.status.pending')}</Text>
      </View>
    </Pressable>
  );
}

export function AppHeader({ onBack }: { onBack?: () => void }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View style={[s.header, { paddingTop: insets.top + 6 }]}>
      <View style={s.row}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={s.back}>
            <Text style={s.backText}>←</Text>
          </Pressable>
        ) : null}
        <Text style={s.logo} accessibilityRole="header">Netra<Text style={s.logoAccent}>Setu</Text></Text>
        <View style={{ flex: 1 }} />
        <SyncChip />
        <Pressable onPress={() => setMenuOpen(true)} style={s.menuBtn} accessibilityRole="button" accessibilityLabel="Open menu">
          <Text style={s.menuIcon}>☰</Text>
        </Pressable>
      </View>
      <ConsoleLine />
      <MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} />
    </View>
  );
}

function MenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useStyles();
  const { t, i18n } = useTranslation();
  const { theme, toggleContrast } = useTheme();
  const { session, logout } = useAuth();
  const sync = useSync();
  const navigation = useNavigation<any>();
  const toast = useToast();
  const lang = i18n.language.split('-')[0];

  const rows = useMemo(() => [
    ['PHC', getConfig().phcName],
    ['SITE CODE', getConfig().phcCode],
    ['LAST SYNC', formatAgo(sync.lastSyncAt)],
    ['CONNECTION', sync.connectivity.replace('_', ' ').toUpperCase()],
    ['PHC PC LINK', sync.pcLink.toUpperCase()],
    ['LAST PC SYNC', formatAgo(sync.pcLastSyncAt)],
  ], [sync.lastSyncAt, sync.connectivity, sync.pcLink, sync.pcLastSyncAt]);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <SafeAreaView edges={['top', 'bottom']} style={s.sheet}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
          <View style={s.operator}>
            <View style={s.operatorDot} />
            <View style={{ flex: 1 }}>
              <Text style={s.operatorRole}>{session?.roleTitle ?? 'PHC TECHNICIAN'}</Text>
              <Text style={s.operatorName}>{session?.name ?? '—'}</Text>
            </View>
          </View>

          <View>
            {rows.map(([k, v]) => (
              <View key={k} style={s.kv}>
                <Text style={s.kvKey}>{k}</Text>
                <Text style={s.kvVal}>{v}</Text>
              </View>
            ))}
            {sync.lastError ? <Text style={s.errorText}>{sync.lastError}</Text> : null}
          </View>

          <View>
            <Text style={s.menuLabel}>{t('mobile.language', 'LANGUAGE')}</Text>
            <View style={s.langGrid}>
              {LANGUAGES.map((l) => (
                <Pressable
                  key={l.code}
                  onPress={() => { i18n.changeLanguage(l.code); kvSet('lang', l.code); }}
                  style={[s.lang, lang === l.code && s.langActive]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: lang === l.code }}
                >
                  <Text style={[s.langText, lang === l.code && s.langTextActive]}>{l.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <Btn
            variant="outline"
            label={theme.mode === 'dark' ? t('mobile.lightMode', 'STANDARD CONTRAST') : t('mobile.darkMode', 'HIGH CONTRAST (DARK)')}
            icon="◐"
            onPress={() => { toggleContrast(); kvSet('contrast', theme.mode === 'dark' ? 'light' : 'dark'); }}
          />
          <Btn variant="outline" label={t('mobile.syncNow', 'SYNC NOW')} icon="⟳" onPress={() => { syncManager.trigger(); onClose(); }} />
          <Btn variant="outline" label={t('mobile.pcLink', 'PHC PC LINK / PAIRING')} icon="⇄" onPress={() => { onClose(); navigation.navigate('Pairing'); }} />
          <Btn
            variant="outline"
            label={t('mobile.exportBundle', 'EXPORT BUNDLE (NO NETWORK)')}
            icon="⇩"
            onPress={async () => {
              try {
                const r = await exportBundleToShare();
                toast(`Bundle ready: ${r.records} records, ${r.images} images, encrypted for the PHC PC.`, 'success');
              } catch (e) { toast(`Export failed: ${(e as Error).message}`); }
            }}
          />
          <Btn
            variant="outline"
            label={t('mobile.importBundle', 'IMPORT BUNDLE FROM PC')}
            icon="⇧"
            onPress={async () => {
              try {
                const r = await importBundleFromPicker();
                if (r) { toast(`Imported ${r.records} records (${r.applied} new).`, 'success'); syncManager.trigger(); }
              } catch (e) { toast(`Import failed: ${(e as Error).message}`); }
            }}
          />
          <Btn variant="outline" label={t('mobile.settings', 'DEVICE SETTINGS')} icon="⚙" onPress={() => { onClose(); navigation.navigate('Settings'); }} />
          <Btn label={`${t('header.logout', 'LOG OUT')} ⏻`} onPress={() => { onClose(); logout(); }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const useStyles = makeStyles((t) => ({
  header: {
    backgroundColor: t.c.headerBg,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(196, 43, 43, 0.25)',
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { paddingRight: 4 },
  backText: { fontFamily: t.fonts.monoBold, fontSize: 20, color: t.c.crimson },
  logo: { fontFamily: t.fonts.heavy, fontSize: 20, letterSpacing: -0.6, color: t.c.text },
  logoAccent: { color: t.c.crimson },
  chip: { alignItems: 'flex-end' },
  phc: { fontFamily: t.fonts.mono, fontSize: 9, color: t.c.textMuted, maxWidth: 150 },
  chipRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 5 },
  chipText: { fontFamily: t.fonts.monoMedium, fontSize: 10, color: t.c.text },
  menuBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.c.border },
  menuIcon: { fontSize: 18, color: t.c.text },
  console: { marginTop: 6 },
  consoleText: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.crimson, letterSpacing: 0.4 },
  caret: { color: t.c.crimson },
  backdrop: { ...({ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 } as const), backgroundColor: t.c.overlay },
  sheet: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '84%',
    maxWidth: 380,
    backgroundColor: t.c.surface,
    borderLeftWidth: 3,
    borderLeftColor: t.c.crimson,
  },
  operator: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.c.border, padding: 12 },
  operatorDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.c.success },
  operatorRole: { fontFamily: t.fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: t.c.textMuted },
  operatorName: { fontFamily: t.fonts.bold, fontSize: 16, color: t.c.text },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.c.grid },
  kvKey: { fontFamily: t.fonts.monoBold, fontSize: 10, letterSpacing: 1, color: t.c.textMuted },
  kvVal: { fontFamily: t.fonts.mono, fontSize: 11, color: t.c.text, flexShrink: 1, textAlign: 'right' },
  errorText: { marginTop: 8, fontFamily: t.fonts.mono, fontSize: 10, color: t.c.danger },
  menuLabel: { fontFamily: t.fonts.monoBold, fontSize: 10, letterSpacing: 1.2, color: t.c.textMuted, marginBottom: 8 },
  langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  lang: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: 'rgba(196, 43, 43, 0.3)', minHeight: 40, justifyContent: 'center' },
  langActive: { backgroundColor: t.c.crimson, borderColor: t.c.crimson },
  langText: { fontFamily: t.fonts.semibold, fontSize: 13, color: t.c.text },
  langTextActive: { color: t.c.onCrimson },
}));
