
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { makeStyles, useTheme } from '../theme/ThemeContext';
import { AppHeader } from '../components/AppHeader';
import { PIPELINE, StageIndicator } from '../components/StageIndicator';
import { Btn, Notice } from '../components/ui';
import { InfoModalButton } from '../components/InfoModalButton';

const QUEUE_INFO_ROWS = [
  { term: 'THE 5 STAGES', text: 'Every capture moves through: 1 Captured, 2 Quality check passed, 3 Sent to central, 4 Central is grading it, 5 Result ready. The five dots on each card show which stage it has reached.' },
  { term: 'CAPTURED (RETAKE NEEDED)', text: 'The image failed the on-the-spot quality check and was not uploaded. Open the card to retake it.' },
  { term: 'QUALITY PASS (WAITING/SYNC FAILED)', text: 'Passed the quality check. Waiting to upload, or retrying if the connection dropped — the app keeps trying on its own.' },
  { term: 'SYNCED, AWAITING IMAGE', text: 'Central has accepted the case and is receiving the full image.' },
  { term: 'AI PENDING', text: 'Central is grading the case now. This normally takes under a minute.' },
  { term: 'GRADING FAILED', text: 'Central received the image but could not produce a result. This needs attention at central, not another retake here.' },
  { term: 'RESULT READY', text: 'Grading finished — open the card to see it.' },
];
import { listQueue, queueSize, resetForRetry } from '../db/captures';
import { QueueEntry } from '../types';
import { formatBytes, formatDateTime, shortId } from '../lib/format';
import { storagePressure } from '../lib/storage';
import { POLICY } from '../config';
import { syncManager } from '../sync/syncManager';
import { useQueueReload, useSync } from '../sync/useSync';
import { RootStackParamList } from '../navigation/types';

export default function QueueScreen() {
  const s = useStyles();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const sync = useSync();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<QueueEntry[] | null>(null);
  const [size, setSize] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    listQueue().then(setItems).catch(() => setItems([]));
    queueSize().then(setSize).catch(() => { });
  }, []);
  useQueueReload(reload);
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const onRefresh = async () => {
    setRefreshing(true);
    syncManager.trigger();
    reload();
    setTimeout(() => setRefreshing(false), 600);
  };

  const pressure = storagePressure();
  const nearCapacity = pressure.low || size >= POLICY.queueWarnCount;

  const renderItem = ({ item }: { item: QueueEntry }) => {
    const cfg = PIPELINE[item.lifecycle];
    const ready = item.lifecycle === 'result_delivered';
    const failed = item.problem === 'upload_failed';
    const actionText = failed ? 'RETRY SYNC ⟳'
      : item.problem === 'grading_failed' ? 'VIEW DETAILS'
        : item.problem === 'retrying' ? 'RETRYING…'
          : cfg.action;
    const open = () => navigation.navigate('CaseReport', { captureId: item.capture.captureId });
    return (
      <Pressable style={[s.row, ready && s.rowReady]} onPress={open} accessibilityRole="button"
        accessibilityLabel={`${item.patient.name}, ${cfg.label}`}>
        <View style={s.rowTop}>
          <Text style={s.id}>{shortId(item.capture.captureId)}</Text>
          <Text style={s.time}>{formatDateTime(item.capture.capturedAt)}</Text>
        </View>
        <Text style={s.name}>{item.patient.name}</Text>
        <Text style={s.meta}>
          {item.patient.patientId}
          {item.capture.eye ? ` · ${item.capture.eye === 'left' ? 'OS' : 'OD'}` : ''}
          {item.capture.source === 'lens' ? ' · LENS' : ''}
          {item.capture.bestEffort ? ' · BEST EFFORT' : ''}
        </Text>
        <View style={s.rowBottom}>
          <StageIndicator lifecycle={item.lifecycle} problem={item.problem} />
          <Pressable
            onPress={failed ? async () => { await resetForRetry(item.capture.captureId); syncManager.trigger(); reload(); } : open}
            style={[s.action, (ready || failed) ? s.actionActive : s.actionIdle, failed && { backgroundColor: theme.c.crimson, borderColor: theme.c.crimsonDark }]}
            accessibilityRole="button"
          >
            <Text style={[s.actionText, (ready || failed) && { color: '#FFFFFF' }]}>{actionText}</Text>
          </Pressable>
        </View>
        {item.sync?.lastError && item.problem ? <Text style={s.error} numberOfLines={2}>{item.sync.lastError}</Text> : null}
      </Pressable>
    );
  };

  return (
    <View style={s.root}>
      <AppHeader />
      <FlatList
        data={items ?? []}
        keyExtractor={(e) => e.capture.captureId}
        renderItem={renderItem}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.c.crimson} colors={[theme.c.crimson]} />}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 12 }}>
            <View style={s.titleRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={s.h1}>{t('queue.title', 'LOCAL QUEUE')}</Text>
                <InfoModalButton title="LOCAL QUEUE" rows={QUEUE_INFO_ROWS} />
              </View>
              <Text style={s.count}>{items?.length ?? 0} {t('queue.items', 'ITEMS')}</Text>
            </View>
            {sync.connectivity !== 'online' && sync.pendingCount > 0 ? (
              <Notice tone="warning" title={sync.connectivity === 'offline' ? 'OFFLINE MODE' : 'CENTRAL SERVER UNREACHABLE'}>
                {`${sync.pendingCount} case(s) are saved on this phone and will upload automatically, most urgent first, when the connection returns.`}
              </Notice>
            ) : null}
            {nearCapacity ? (
              <Notice title="STORAGE PRESSURE">
                {`${size} case(s) on this phone · ${formatBytes(pressure.availableBytes)} free. Sync or export soon, before the device runs out of space.`}
              </Notice>
            ) : null}
            <Btn size="sm" variant="outline" label={sync.syncing ? 'SYNCING…' : 'SYNC NOW ⟳'} onPress={() => syncManager.trigger()} style={{ alignSelf: 'flex-start' }} />
          </View>
        }
        ListEmptyComponent={
          items === null ? null : (
            <View style={s.empty}><Text style={s.emptyText}>{t('queue.empty', 'QUEUE EMPTY')}</Text></View>
          )
        }
      />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.c.surface },
  list: { padding: 16, paddingBottom: 40 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  h1: { fontFamily: t.fonts.heavy, fontSize: 24, color: t.c.text, letterSpacing: -0.5 },
  count: { fontFamily: t.fonts.mono, fontSize: 12, color: t.c.textMuted },
  row: { backgroundColor: t.c.creamLight, borderWidth: 1, borderColor: t.c.border, padding: 12, gap: 4 },
  rowReady: { borderColor: t.c.success, borderLeftWidth: 4 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between' },
  id: { fontFamily: t.fonts.monoBold, fontSize: 11, color: t.c.textMuted },
  time: { fontFamily: t.fonts.mono, fontSize: 11, color: t.c.text },
  name: { fontFamily: t.fonts.bold, fontSize: 15, color: t.c.text },
  meta: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.textMuted },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 },
  action: { paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center', borderWidth: 1.5 },
  actionActive: {
    backgroundColor: '#3B7A2B',
    borderColor: '#28551C',
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.7,
    shadowRadius: 0,
    elevation: 2,
  },
  actionIdle: { borderColor: t.c.border, backgroundColor: 'transparent' },
  actionText: { fontFamily: t.fonts.monoBold, fontSize: 10, letterSpacing: 0.6, color: t.c.textMuted },
  error: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.danger, marginTop: 4 },
  empty: { padding: 40, alignItems: 'center', borderWidth: 1, borderColor: t.c.border, borderStyle: 'dashed' },
  emptyText: { fontFamily: t.fonts.mono, fontSize: 12, color: t.c.textMuted },
}));
