
import React from 'react';
import { Text, View } from 'react-native';
import { makeStyles, useTheme } from '../theme/ThemeContext';
import { QualityResult } from '../types';
import { POLICY } from '../config';
import { CAMERA_PRESETS } from '../lib/quality/qualityGate';
import { Btn, Notice } from './ui';
import { InfoModalButton } from './InfoModalButton';

const QUALITY_INFO_ROWS = [
  { term: 'QUALITY PASS / BORDERLINE / FAIL', text: 'PASS means the image is good enough to grade as-is. BORDERLINE means no single problem is bad enough to reject it, but overall quality is low — it is still graded, with extra enhancement applied centrally. FAIL means retake: the image is not usable.' },
  { term: 'QUALITY SCORE', text: 'Mean of focus, illumination and field of view. Below 70% is why an otherwise-passing image gets marked borderline.' },
  { term: 'GLARE / MOTION / OCCLUSION', text: 'Separate checks from the quality score above — any one of these failing on its own sends the image straight to retake, regardless of the overall score.' },
  { term: 'RETAKE LIMIT / BEST EFFORT', text: 'After several failed retakes for the same patient today, you can mark the image "best effort" and proceed anyway rather than retaking indefinitely — the case is still sent, flagged so the ophthalmologist knows it was a difficult capture.' },
];

export const QUALITY_REASON_MESSAGES: Record<string, string> = {
  blur: 'Image is blurry — hold the camera or lens steady on the patient’s eye and retake',
  low_illumination: 'Image is too dark — adjust lighting and retake',
  insufficient_fov: 'Insufficient field of view — ensure full retinal coverage',
  glare: 'Glare detected in image — reduce direct light source',
  motion_artifact: 'Motion artifact detected — ask patient to hold still',
  eyelash_occlusion: 'Eyelash/eyelid obstruction — gently retract and retake',
};

interface Metric { id: string; label: string; value: number; good: boolean; higherIsBetter: boolean; limit: string }

function metricsOf(r: QualityResult): Metric[] {
  const p = CAMERA_PRESETS[r.preset] ?? CAMERA_PRESETS.default;
  const s = r.scores;
  return [
    { id: 'focus', label: 'FOCUS', value: s.focusScore, good: s.focusScore >= p.focusThreshold, higherIsBetter: true, limit: `≥ ${Math.round(p.focusThreshold * 100)}%` },
    { id: 'illum', label: 'ILLUMINATION', value: s.illuminationScore, good: s.illuminationScore >= p.illuminationThreshold, higherIsBetter: true, limit: `≥ ${Math.round(p.illuminationThreshold * 100)}%` },
    { id: 'fov', label: 'FIELD OF VIEW', value: s.coveragePercent, good: s.coveragePercent >= 0.5, higherIsBetter: true, limit: '≥ 50%' },
    { id: 'glare', label: 'GLARE', value: s.glareScore, good: s.glareScore <= 0.3, higherIsBetter: false, limit: '≤ 30%' },
    { id: 'motion', label: 'MOTION', value: s.motionScore, good: s.motionScore <= 0.3, higherIsBetter: false, limit: '≤ 30%' },
    { id: 'occl', label: 'OCCLUSION', value: s.occlusionScore, good: s.occlusionScore <= 0.18, higherIsBetter: false, limit: '≤ 18%' },
  ];
}

export function QualityResultPanel({
  result, retakeCount, elevatedRisk, onRetake, onAccept, onBestEffort, readOnly,
}: {
  result: QualityResult;
  /** Failed attempts for this patient today, BEFORE this one. */
  retakeCount: number;
  elevatedRisk?: boolean;
  onRetake?: () => void;
  onAccept?: () => void;
  onBestEffort?: () => void;
  readOnly?: boolean;
}) {
  const s = useStyles();
  const { theme } = useTheme();
  const isPass = result.status === 'pass';
  const isRetake = result.status === 'retake';
  const composite = Math.round(result.compositeScore * 100);
  const failedAttempts = retakeCount + (isRetake ? 1 : 0);
  const bestEffortAvailable = isRetake && failedAttempts >= POLICY.maxRetakesBeforeBestEffort;

  const hero = isPass
    ? { icon: '✓', title: 'Quality pass', sub: 'image meets diagnostic threshold', bg: theme.c.successBg, border: theme.c.successBorder, fg: theme.c.success }
    : isRetake
      ? { icon: '✕', title: 'Quality fail', sub: 'image below diagnostic threshold', bg: theme.c.dangerBg, border: theme.c.dangerBorder, fg: theme.c.danger }
      : { icon: '⚠', title: 'Borderline quality', sub: 'image meets partial diagnostic criteria', bg: theme.c.warningBg, border: theme.c.warningBorder, fg: theme.c.warning };

  const metrics = metricsOf(result);

  return (
    <View style={{ gap: 10 }}>
      <View style={[s.hero, { backgroundColor: hero.bg, borderColor: hero.border }]}>
        <View style={[s.heroIcon, { backgroundColor: hero.fg }]}><Text style={s.heroIconText}>{hero.icon}</Text></View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[s.heroTitle, { color: hero.fg }]}>{hero.title}</Text>
            <InfoModalButton title="QUALITY CHECK" rows={QUALITY_INFO_ROWS} />
          </View>
          <Text style={s.heroSub}>{hero.sub}</Text>
        </View>
      </View>

      <View style={s.card}>
        <View style={s.cardRow}>
          <Text style={s.label}>QUALITY SCORE</Text>
          <Text style={s.scoreNum}>{composite}%</Text>
        </View>
        <View style={s.track}>
          <View style={[s.fill, { width: `${Math.min(100, composite)}%`, backgroundColor: composite >= 70 ? theme.c.success : theme.c.warning }]} />
        </View>
        <Text style={s.caption}>Mean of focus, illumination and field of view · pass ≥ 70%</Text>
      </View>

      <View style={s.grid}>
        {metrics.map((m) => {
          const pct = Math.round(m.value * 100);
          return (
            <View key={m.id} style={[s.card, s.metric]}>
              <View style={s.cardRow}>
                <Text style={s.label}>{m.label}</Text>
                <Text style={[s.metricNum, { color: m.good ? theme.c.text : theme.c.danger }]}>{pct}%</Text>
              </View>
              <View style={s.track}>
                <View style={[s.fill, { width: `${Math.min(100, pct)}%`, backgroundColor: m.good ? theme.c.success : theme.c.danger }]} />
              </View>
              <Text style={s.caption}>{m.good ? 'OK' : 'OUT OF RANGE'} · {m.limit}</Text>
            </View>
          );
        })}
      </View>

      {result.reason ? (
        <View style={[s.card, { borderColor: theme.c.warning }]}>
          <Text style={[s.label, { color: theme.c.warning }]}>DETECTED ISSUES</Text>
          <Text style={s.issue}>{(QUALITY_REASON_MESSAGES[result.reason] ?? result.reason).toUpperCase()}</Text>
        </View>
      ) : null}

      <Text style={s.caption}>
        Analysed on this device at {result.analysedAt} px · preset “{result.preset}”
        {retakeCount > 0 ? ` · ${retakeCount} earlier failed attempt(s) today` : ''}
      </Text>

      {readOnly ? null : isRetake ? (
        <View style={{ gap: 8, marginTop: 6 }}>
          <Notice title="✕ INSTANT RETAKE ADVISORY">
            {result.reason ? QUALITY_REASON_MESSAGES[result.reason] : 'Image falls below the diagnostic threshold. Retake.'}
          </Notice>
          <Btn variant="danger" size="lg" icon="↺" label="RETAKE IMAGE (RESOLVE DEFECT)" onPress={onRetake} />
          {bestEffortAvailable ? (
            <>
              <Btn variant="outline" label="MARK BEST EFFORT — PROCEED AS UNGRADABLE" onPress={onBestEffort} />
              <Text style={s.caption}>
                {failedAttempts} failed attempts. The case goes to mandatory Tier C ophthalmologist review, flagged ungradable.
              </Text>
              {elevatedRisk ? (
                <Notice tone="warning" title="STANDING GUIDANCE (NOT AN IMAGE RESULT)">
                  The questionnaire reports elevated risk factors. Consider direct referral to a specialist based on those reported factors.
                </Notice>
              ) : null}
            </>
          ) : (
            <Text style={s.caption}>
              Attempt {failedAttempts} of {POLICY.maxRetakesBeforeBestEffort}. After {POLICY.maxRetakesBeforeBestEffort} failed attempts you can proceed with a best-effort image.
            </Text>
          )}
        </View>
      ) : (
        <View style={s.actions}>
          <Btn variant="outline" icon="↺" label="RETAKE" onPress={onRetake} style={{ flex: 1 }} />
          <Btn variant="success" label="ACCEPT & CONTINUE →" onPress={onAccept} style={{ flex: 1.6 }} />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderRadius: 4 },
  heroIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  heroIconText: { color: '#FFFFFF', fontFamily: t.fonts.monoHeavy, fontSize: 16 },
  heroTitle: { fontFamily: t.fonts.heavy, fontSize: 17, textTransform: 'capitalize' },
  heroSub: { fontFamily: t.fonts.body, fontSize: 12, color: t.c.textMuted },
  card: { backgroundColor: t.c.creamLight, borderWidth: 1, borderColor: t.c.border, padding: 10, gap: 6 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontFamily: t.fonts.monoBold, fontSize: 9.5, letterSpacing: 1, color: t.c.textMuted },
  scoreNum: { fontFamily: t.fonts.heavy, fontSize: 22, color: t.c.text },
  metricNum: { fontFamily: t.fonts.monoBold, fontSize: 13 },
  track: { height: 6, backgroundColor: t.c.creamDark, overflow: 'hidden' },
  fill: { height: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { flexBasis: '47%', flexGrow: 1 },
  caption: { fontFamily: t.fonts.mono, fontSize: 9.5, color: t.c.textMuted, lineHeight: 14 },
  issue: { fontFamily: t.fonts.monoBold, fontSize: 11, color: t.c.text, lineHeight: 16 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
}));
