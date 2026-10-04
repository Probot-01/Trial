
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { makeStyles, useTheme } from '../theme/ThemeContext';
import { ImageViewer } from '../components/ImageViewer';
import { QualityResultPanel } from '../components/QualityResultPanel';
import { PIPELINE, PROBLEM_LABEL } from '../components/StageIndicator';
import { Btn, Notice } from '../components/ui';
import { useToast } from '../components/Toast';
import { RootStackParamList } from '../navigation/types';
import { getQueueEntry, resetForRetry } from '../db/captures';
import { CentralError, getReport, gradcamSource } from '../api/central';
import { PhcReport, QueueEntry } from '../types';
import { gradeLabel, isReferable, TIER_TEXT } from '../lib/grades';
import { InfoModalButton } from '../components/InfoModalButton';


const CAVEAT_MARKERS = [
  'PROVISIONAL', 'never been measured', 'should be refitted', 'was fitted on',
  'This grade may be an under-call', 'not the literature',
];
function splitCaveat(text: string | null | undefined): { finding: string | null; caveat: string | null } {
  if (!text) return { finding: text ?? null, caveat: null };
  const sentences = text.match(/[^.]+\.(\s+|$)/g) || [text];
  const last = sentences[sentences.length - 1] || '';
  if (sentences.length > 1 && CAVEAT_MARKERS.some((m) => last.includes(m))) {
    return { finding: sentences.slice(0, -1).join('').trim(), caveat: last.trim() };
  }
  return { finding: text, caveat: null };
}

const REPORT_INFO_ROWS = [
  { term: 'CNN CONFIDENCE', text: 'The AI’s own certainty in its grade (0–100%). Below 70% warrants extra caution before treating this as settled.' },
  { term: 'RULE ENGINE', text: 'A second, independent AI grade produced by counting specific lesion features against clinical thresholds — checked against the main AI grade to catch disagreements.' },
  { term: 'BRANCHES: AGREE / DISAGREE', text: 'Whether the two AI methods above reached the same grade. DISAGREE means an ophthalmologist must resolve it manually before this case is considered settled.' },
  { term: 'TIER', text: 'How much the case was auto-cleared vs held for review — A is the highest-confidence band, C the lowest.' },
  { term: 'AI RESULT vs CONFIRMED vs CORRECTED', text: 'AI RESULT means no ophthalmologist has reviewed it yet — treat it as provisional. CONFIRMED means a doctor agreed with the AI. CORRECTED means a doctor assigned a different final grade.' },
];
import { formatDateTime, formatTime, pct } from '../lib/format';
import { getConfig } from '../config';
import { syncManager } from '../sync/syncManager';
import { useSync } from '../sync/useSync';

type ReportState =
  | { kind: 'not_uploaded' }
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: PhcReport; fetchedAt: string };

export default function CaseReportScreen() {
  const s = useStyles();
  const { theme } = useTheme();
  const toast = useToast();
  const sync = useSync();
  const navigation = useNavigation();
  const { captureId } = useRoute<RouteProp<RootStackParamList, 'CaseReport'>>().params;
  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [report, setReport] = useState<ReportState>({ kind: 'loading' });
  const [showGradcam, setShowGradcam] = useState(false);

  const load = useCallback(async () => {
    const e = await getQueueEntry(captureId);
    setEntry(e);
    if (!e?.sync?.centralCaseId) { setReport({ kind: 'not_uploaded' }); return; }
    setReport({ kind: 'loading' });
    try {
      const r = await getReport(captureId);
      setReport({ kind: 'ready', report: r, fetchedAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof CentralError && (err.kind === 'network' || err.kind === 'timeout')) setReport({ kind: 'offline' });
      else setReport({ kind: 'error', message: (err as Error).message });
    }
  }, [captureId]);

  useEffect(() => { load(); }, [load]);

  if (!entry) {
    return <SafeAreaView style={[s.root, s.center]}><ActivityIndicator color={theme.c.crimson} /></SafeAreaView>;
  }

  const r = report.kind === 'ready' ? report.report : null;
  const finalGrade = r?.review?.decision === 'override' && r.review.correctedGrade !== null ? r.review.correctedGrade : r?.drGradeCnn ?? null;
  const eyeCode = entry.capture.eye === 'left' ? 'OS' : entry.capture.eye === 'right' ? 'OD' : '—';

  const shareSlip = async () => {
    try {

      const { base64 } = await Print.printToFileAsync({ html: slipHtml(entry, r, finalGrade), base64: true });
      if (!base64) throw new Error('Print did not return the PDF data.');
      const dest = new File(Paths.cache, `clinical-slip-${captureId}.pdf`);
      if (dest.exists) dest.delete();
      dest.write(base64, { encoding: 'base64' });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(dest.uri, { mimeType: 'application/pdf', dialogTitle: 'Clinical slip' });
      else await Print.printAsync({ uri: dest.uri });
    } catch (e) {
      toast(`Could not create the clinical slip: ${(e as Error).message}`);
    }
  };

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={s.badge}>● {r?.status === 'graded' ? 'AI DIAGNOSTIC REPORT' : 'CASE REPORT'}</Text>
            {r?.status === 'graded' ? <InfoModalButton title="DIAGNOSTIC REPORT" rows={REPORT_INFO_ROWS} /> : null}
          </View>
          <Text style={s.captureId}>CAPTURE ID: {captureId}</Text>
        </View>
        <Pressable onPress={() => navigation.goBack()} style={s.close} accessibilityRole="button" accessibilityLabel="Close report">
          <Text style={s.closeText}>✕ CLOSE</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {/* Patient strip */}
        <View style={s.strip}>
          {[
            ['PATIENT NAME', `${entry.patient.name} (${entry.patient.age}Y)`],
            ['PATIENT ID', entry.patient.patientId],
            ['TIME OF CAPTURE', formatDateTime(entry.capture.capturedAt)],
            ['PRIMARY HEALTH CENTRE', getConfig().phcName],
          ].map(([k, v]) => (
            <View key={k} style={s.stripItem}>
              <Text style={s.infoLabel}>{k}</Text>
              <Text style={s.infoVal}>{v}</Text>
            </View>
          ))}
        </View>

        {/* Verdict */}
        <View style={s.verdict}>
          <Text style={s.tagline}>AI SEVERITY CLASSIFICATION</Text>
          <FullReportVerdict state={report} entry={entry} finalGrade={finalGrade} onRetry={load} onRetrySync={async () => {
            await resetForRetry(captureId); syncManager.trigger(); toast('Queued for another sync attempt.', 'info');
          }} online={sync.connectivity === 'online'} />
        </View>

        {/* Scan */}
        <View style={s.scanHeader}>
          <Text style={s.scanTitle}>FUNDUS SCAN ({eyeCode}){entry.capture.source === 'lens' ? ' · FUNDUS LENS' : ''}</Text>
          <Text style={[s.scanBadge, entry.capture.qualityStatus !== 'pass' && { backgroundColor: theme.c.warning }]}>
            {entry.capture.bestEffort ? 'BEST EFFORT' : entry.capture.qualityStatus === 'pass' ? 'QUALITY PASSED' : entry.capture.qualityStatus.toUpperCase()}
          </Text>
        </View>
        <ImageViewer
          source={{ uri: entry.capture.imagePath }}
          overlay={showGradcam && r?.gradCamAvailable ? gradcamSource(captureId) : null}
          height={300}
        />
        {r?.gradCamAvailable ? (
          <Btn size="sm" variant={showGradcam ? 'primary' : 'outline'} label={showGradcam ? 'HIDE GRADCAM HEATMAP' : 'SHOW GRADCAM HEATMAP'}
            onPress={() => setShowGradcam((v) => !v)} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
        ) : null}
        {showGradcam && r?.gradCamAvailable ? (
          <Text style={[s.caption, { textAlign: 'center', marginTop: 6 }]}>
            Grad-CAM view shows the model's own cropped working image, not the original capture — the crop can look tighter or offset from the photo above.
          </Text>
        ) : null}

        {/* Biomarkers */}
        {r && r.status === 'graded' ? (
          <View style={{ marginTop: 16 }}>
            <Text style={s.checklistTitle}>BIOMARKER EVIDENCE SUMMARY</Text>
            {biomarkers(r).map((b) => (
              <View key={b.name} style={[s.bio, b.detected && s.bioDetected]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.bioName}>{b.name}</Text>
                  <Text style={s.bioNotes}>{b.notes}</Text>
                </View>
                <Text style={[s.bioBadge, b.detected ? s.bioBadgeDetected : b.value === null ? s.bioBadgeNa : s.bioBadgeNone]}>{b.badge}</Text>
              </View>
            ))}
            {r.foveaUnreliable ? <Text style={s.caption}>Fovea could not be located reliably; lesion positions relative to it are not trustworthy.</Text> : null}
            {r.eyeLateralityMismatch ? <Text style={[s.caption, { color: theme.c.danger }]}>Eye mismatch: the image reports a different eye than was selected.</Text> : null}
          </View>
        ) : null}

        {/* Referral / sync notice -- what is actually true about this case */}
        <View style={{ marginTop: 16 }}>
          <Notice title="TELE-OPHTHALMOLOGY SYNC NOTICE">{syncNotice(entry, r)}</Notice>
        </View>

        {/* Local quality report -- always available */}
        <Text style={[s.checklistTitle, { marginTop: 20 }]}>LOCAL QUALITY REPORT (THIS DEVICE)</Text>
        {entry.capture.qualityScores ? (
          <QualityResultPanel result={entry.capture.qualityScores} retakeCount={entry.capture.retakeCount} readOnly />
        ) : (
          <Text style={s.caption}>No quality result stored for this capture.</Text>
        )}

        {report.kind === 'ready' ? <Text style={[s.caption, { marginTop: 12 }]}>Full report fetched {formatTime(report.fetchedAt)} · model {r?.modelVersion ?? 'not reported'}</Text> : null}
      </ScrollView>

      <View style={s.footer}>
        <Btn variant="outline" label="⎙ SHARE CLINICAL SLIP" onPress={shareSlip} style={{ flex: 1 }} />
        <Btn label="DONE & RETURN TO QUEUE" onPress={() => navigation.goBack()} style={{ flex: 1.2 }} />
      </View>
    </SafeAreaView>
  );
}

function FullReportVerdict({ state, entry, finalGrade, onRetry, onRetrySync, online }: {
  state: ReportState; entry: QueueEntry; finalGrade: number | null; onRetry: () => void; onRetrySync: () => void; online: boolean;
}) {
  const s = useStyles();
  const { theme } = useTheme();
  if (state.kind === 'not_uploaded') {
    const failed = entry.problem === 'upload_failed';
    return (
      <View style={{ gap: 8 }}>
        <Text style={s.grade}>{failed ? PROBLEM_LABEL.upload_failed : PIPELINE[entry.lifecycle].label}</Text>
        <Text style={s.desc}>
          {entry.lifecycle === 'captured'
            ? 'This attempt did not pass the quality gate and was not sent for grading.'
            : failed
              ? `Central rejected this case: ${entry.sync?.lastError ?? 'unknown error'}. Fix the cause and retry.`
              : 'Not uploaded yet. It is saved on this phone and uploads automatically when the central server is reachable. The full report appears after grading.'}
        </Text>
        {failed ? <Btn size="sm" label="RETRY SYNC ⟳" onPress={onRetrySync} style={{ alignSelf: 'flex-start' }} /> : null}
      </View>
    );
  }
  if (state.kind === 'loading') return <ActivityIndicator color={theme.c.crimson} style={{ alignSelf: 'flex-start' }} />;
  if (state.kind === 'offline') {
    return (
      <View style={{ gap: 8 }}>
        <Text style={s.grade}>FULL REPORT UNAVAILABLE OFFLINE</Text>
        <Text style={s.desc}>The full report is only shown while the central server is reachable{online ? '' : ', and this phone is offline'}. The local quality report below is always available.</Text>
        <Btn size="sm" variant="outline" label="TRY AGAIN" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={{ gap: 8 }}>
        <Text style={s.grade}>REPORT COULD NOT BE LOADED</Text>
        <Text style={s.desc}>{state.message}</Text>
        <Btn size="sm" variant="outline" label="TRY AGAIN" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
      </View>
    );
  }

  const r = state.report;
  if (r.status === 'error') {
    return (
      <View style={{ gap: 6 }}>
        <Text style={[s.grade, { color: theme.c.danger }]}>GRADING FAILED</Text>
        <Text style={s.desc}>Central could not grade this image ({r.failureCode ?? 'no code'}). No result exists; this is not a normal finding. The case remains with central for review.</Text>
      </View>
    );
  }
  if (r.status !== 'graded') {
    return (
      <View style={{ gap: 6 }}>
        <Text style={s.grade}>{r.status === 'awaiting_image' ? 'AWAITING IMAGE UPLOAD' : 'AI PROCESSING…'}</Text>
        <Text style={s.desc}>Central has the case and is {r.status === 'awaiting_image' ? 'waiting for the image' : 'grading it'}. Check back in a minute.</Text>
        <Btn size="sm" variant="outline" label="REFRESH" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
      </View>
    );
  }

  const label = gradeLabel(finalGrade);
  const confirmation = !r.review
    ? { text: 'AI RESULT · AWAITING OPHTHALMOLOGIST CONFIRMATION', color: theme.c.warning }
    : r.review.decision === 'confirm'
      ? { text: `CONFIRMED BY OPHTHALMOLOGIST · ${formatDateTime(r.review.reviewedAt)}`, color: theme.c.success }
      : { text: `CORRECTED BY OPHTHALMOLOGIST (AI SAID: ${gradeLabel(r.drGradeCnn)?.toUpperCase() ?? 'N/A'})`, color: theme.c.crimson };
  const { finding, caveat } = splitCaveat(r.evidenceSummaryText);

  return (
    <View style={{ gap: 8 }}>
      <Text style={s.grade}>{label ? `GRADE ${finalGrade} · ${label.toUpperCase()}` : 'NO GRADE PRODUCED'}</Text>
      <Text style={[s.confirm, { color: confirmation.color, borderColor: confirmation.color }]}>{confirmation.text}</Text>
      <Text style={s.desc}>{finding ?? 'Central produced no evidence summary for this case.'}</Text>
      {caveat ? <Text style={s.caption}>ⓘ Methodology note: {caveat}</Text> : null}
      <View style={s.stats}>
        <Stat label="CNN CONFIDENCE" value={pct(r.confidenceScore)} />
        <Stat label="RULE ENGINE" value={r.drGradeRuleEngine === null ? 'N/A' : `GRADE ${r.drGradeRuleEngine}`} />
        <Stat label="BRANCHES" value={r.branchAgreement === null ? 'N/A' : r.branchAgreement ? 'AGREE' : 'DISAGREE'} />
        <Stat label="TIER" value={r.conformalTier ?? 'N/A'} />
      </View>
      {r.conformalTier ? <Text style={s.caption}>{TIER_TEXT[r.conformalTier]}{r.tierReason ? ` · ${r.tierReason.split(':')[0]}` : ''}</Text> : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const s = useStyles();
  return (
    <View style={s.stat}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.statVal}>{value}</Text>
    </View>
  );
}

function biomarkers(r: PhcReport) {
  const lc = r.lesionCounts;
  const row = (name: string, value: number | null | undefined, what: string) => ({
    name,
    value: value ?? null,
    detected: (value ?? 0) > 0,
    badge: value === null || value === undefined ? 'NOT AVAILABLE' : value > 0 ? `DETECTED (${value})` : 'NONE',
    notes: value === null || value === undefined ? 'Not measured for this case' : value > 0 ? `${value} ${what} found` : `No ${what} found`,
  });
  const rows = [
    row('Microaneurysms', lc?.microaneurysms, 'microaneurysm(s)'),
    row('Hemorrhages', lc?.hemorrhages, 'hemorrhage(s)'),
    row('Hard Exudates', lc?.hardExudates, 'hard exudate region(s)'),
    row('Cotton Wool Spots (soft exudates)', lc?.softExudates, 'soft exudate(s)'),
  ];
  rows.push({
    name: 'Neovascularization suspicion',
    value: r.nvSuspicionScore,
    detected: false, // a suspicion score, not a detection -- no threshold is invented here
    badge: r.nvSuspicionScore === null ? 'NOT AVAILABLE' : pct(r.nvSuspicionScore),
    notes: r.nvSuspicionScore === null ? 'Not scored for this case' : 'Suspicion score, not a segmentation',
  });
  return rows;
}

function syncNotice(e: QueueEntry, r: PhcReport | null): string {
  if (!e.sync) return 'This capture is only on this device.';
  if (e.sync.state !== 'synced') return 'Waiting to upload. Nothing has reached the central review pipeline yet.';
  if (!r || r.status !== 'graded') return 'Central has received this case. Grading and ophthalmologist routing follow automatically.';
  if (r.review) {
    return isReferable(r.review.correctedGrade ?? r.drGradeCnn)
      ? 'An ophthalmologist has reviewed this case and it is referable. The referral and patient SMS are handled by the central system.'
      : 'An ophthalmologist has reviewed this case. No referral was raised.';
  }
  if (r.conformalTier === 'A') return 'High-confidence result routed as auto-clear (Tier A).';
  return 'This result is queued for ophthalmologist review. Do not give the patient a diagnosis from this screen.';
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function slipHtml(e: QueueEntry, r: PhcReport | null, finalGrade: number | null): string {
  const q = e.capture.qualityScores;
  const grade = r?.status === 'graded' && gradeLabel(finalGrade)
    ? `Grade ${finalGrade} · ${gradeLabel(finalGrade)} ${r.review ? `(${r.review.decision === 'confirm' ? 'confirmed' : 'corrected'} by ophthalmologist)` : '(AI result, awaiting ophthalmologist confirmation)'}`
    : 'Not available: the full report has not been produced or could not be loaded.';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,Roboto,sans-serif;color:#2C1810;padding:24px}
    h1{font-size:18px;color:#C42B2B;margin:0 0 4px} .mono{font-family:monospace;font-size:11px;color:#6b5a4f}
    table{border-collapse:collapse;width:100%;margin-top:12px} td{border:1px solid #d9ccb8;padding:6px 8px;font-size:12px}
    td:first-child{width:38%;font-family:monospace;font-size:10px;letter-spacing:.06em;color:#6b5a4f}
    .note{margin-top:16px;border-left:4px solid #C42B2B;background:#F5EDE0;padding:10px;font-size:11px}
  </style></head><body>
    <h1>NetraSetu · Clinical Slip</h1>
    <div class="mono">${esc(getConfig().phcName)} · capture ${esc(e.capture.captureId)}</div>
    <table>
      <tr><td>PATIENT</td><td>${esc(e.patient.name)} (${e.patient.age}Y)</td></tr>
      <tr><td>PATIENT ID</td><td>${esc(e.patient.patientId)}</td></tr>
      <tr><td>CAPTURED</td><td>${esc(formatDateTime(e.capture.capturedAt))}</td></tr>
      <tr><td>EYE</td><td>${e.capture.eye === 'left' ? 'Left (OS)' : e.capture.eye === 'right' ? 'Right (OD)' : '—'}</td></tr>
      <tr><td>IMAGE QUALITY</td><td>${q ? `${esc(q.status)}${q.reason ? ` (${esc(q.reason)})` : ''} · score ${Math.round(q.compositeScore * 100)}%` : 'Not available'}${e.capture.bestEffort ? ' · best effort' : ''}</td></tr>
      <tr><td>SCREENING RESULT</td><td>${esc(grade)}</td></tr>
    </table>
    <div class="note">${esc(syncNotice(e, r))}<br/><br/>This slip supports screening and does not replace a clinical diagnosis.</div>
  </body></html>`;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.c.surface },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    backgroundColor: t.c.crimson,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: t.c.black,
  },
  badge: { fontFamily: t.fonts.monoBold, fontSize: 11, letterSpacing: 1.2, color: '#FFFFFF' },
  captureId: { fontFamily: t.fonts.mono, fontSize: 10, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  close: { borderWidth: 1.5, borderColor: '#FFFFFF', paddingHorizontal: 10, paddingVertical: 6 },
  closeText: { fontFamily: t.fonts.monoBold, fontSize: 10, color: '#FFFFFF' },
  scroll: { padding: 16, paddingBottom: 32 },
  strip: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderColor: t.c.border },
  stripItem: { flexBasis: '50%', padding: 10, borderWidth: 0.5, borderColor: t.c.border },
  infoLabel: { fontFamily: t.fonts.monoBold, fontSize: 9, letterSpacing: 1, color: t.c.textMuted },
  infoVal: { fontFamily: t.fonts.semibold, fontSize: 13, color: t.c.text, marginTop: 2 },
  verdict: { marginTop: 16, padding: 14, borderWidth: 2, borderColor: t.c.black, backgroundColor: t.c.creamLight },
  tagline: { fontFamily: t.fonts.mono, fontSize: 10, letterSpacing: 1.2, color: t.c.textMuted, marginBottom: 6 },
  grade: { fontFamily: t.fonts.heavy, fontSize: 21, textTransform: 'uppercase', color: t.c.text, lineHeight: 26 },
  confirm: { fontFamily: t.fonts.monoBold, fontSize: 9.5, letterSpacing: 0.8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
  desc: { fontFamily: t.fonts.body, fontSize: 13.5, lineHeight: 20, color: t.c.text },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  stat: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderColor: t.c.border, padding: 8 },
  statVal: { fontFamily: t.fonts.monoBold, fontSize: 13, color: t.c.text, marginTop: 2 },
  scanHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 6 },
  scanTitle: { fontFamily: t.fonts.monoHeavy, fontSize: 11, color: t.c.text },
  scanBadge: { fontFamily: t.fonts.monoBold, fontSize: 9, color: '#FFFFFF', backgroundColor: t.c.success, paddingHorizontal: 6, paddingVertical: 3 },
  checklistTitle: { fontFamily: t.fonts.monoBold, fontSize: 11, letterSpacing: 1.2, color: t.c.text, marginBottom: 8 },
  bio: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderColor: t.c.border, marginBottom: 6 },
  bioDetected: { borderLeftWidth: 4, borderLeftColor: t.c.danger },
  bioName: { fontFamily: t.fonts.bold, fontSize: 13.5, color: t.c.text },
  bioNotes: { fontFamily: t.fonts.body, fontSize: 11.5, color: t.c.textMuted },
  bioBadge: { fontFamily: t.fonts.monoBold, fontSize: 9, paddingHorizontal: 6, paddingVertical: 3, overflow: 'hidden' },
  bioBadgeDetected: { backgroundColor: '#A82222', color: '#FFFFFF' },
  bioBadgeNone: { backgroundColor: t.c.successBg, color: t.c.success },
  bioBadgeNa: { backgroundColor: t.c.creamDark, color: t.c.textMuted },
  caption: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.textMuted, lineHeight: 15, marginTop: 4 },
  footer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: t.c.border, backgroundColor: t.c.surface },
}));
