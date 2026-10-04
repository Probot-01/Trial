
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { Asset } from 'expo-asset';
import { useTranslation } from 'react-i18next';
import { makeStyles, useTheme } from '../theme/ThemeContext';
import { AppHeader } from '../components/AppHeader';
import { Stepper } from '../components/Stepper';
import { ImageViewer } from '../components/ImageViewer';
import { QualityResultPanel } from '../components/QualityResultPanel';
import { CaptureMetadataForm, LENS_DEVICE, MetadataDraft, metadataMissing, toMetadataPayload } from '../components/CaptureMetadataForm';
import { Btn, Card, Notice } from '../components/ui';
import { useToast } from '../components/Toast';
import { RootStackParamList } from '../navigation/types';
import { DEMO_TOOLS } from '../config';
import { CaptureSource, Patient, QualityResult } from '../types';
import { getPatient } from '../db/patients';
import { countRetakesToday, discardUnqueuedCapture, newCaptureId, queueCapture, recordCapture } from '../db/captures';
import { persistCaptureImage } from '../lib/storage';
import { runQualityGate } from '../lib/quality/runQualityGate';
import { priorityTier, questionnaireMissing, toQuestionnairePayload } from '../lib/questionnaire';
import { syncManager } from '../sync/syncManager';
import { useSync } from '../sync/useSync';

const SAMPLE = require('../../assets/demo/sample_fundus.jpg');

interface Picked { uri: string; source: CaptureSource; mimeType: string | null }

const EMPTY_META: MetadataDraft = {
  eye: null, cameraDeviceId: 'unknown', pupilStatus: null, lightingEnvironment: null, observedIssues: [], workerUsabilityRating: null,
};

export default function CaptureScreen() {
  const s = useStyles();
  const { theme } = useTheme();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const sync = useSync();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Capture'>>();
  const { patientId, newRegistration, lensPhoto } = route.params;

  const [patient, setPatient] = useState<Patient | null>(null);
  const [step, setStep] = useState(1);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [quality, setQuality] = useState<(QualityResult & { durationMs: number }) | null>(null);
  const [retakesBefore, setRetakesBefore] = useState(0);
  const [bestEffort, setBestEffort] = useState(false);
  const [meta, setMeta] = useState<MetadataDraft>(EMPTY_META);
  const [showMetaErrors, setShowMetaErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  /** The recorded, not-yet-queued capture -- discarded if the technician walks away. */
  const pendingCapture = useRef<string | null>(null);
  const storedUri = useRef<string | null>(null);

  useEffect(() => { getPatient(patientId).then(setPatient); }, [patientId]);
  useEffect(() => () => { if (pendingCapture.current) discardUnqueuedCapture(pendingCapture.current); }, []);

  // A photo coming back from the lens camera screen.
  useEffect(() => {
    if (lensPhoto) {
      resetToStep1();
      setPicked({ uri: lensPhoto.uri, source: 'lens', mimeType: 'image/jpeg' });
      setMeta({ ...EMPTY_META, cameraDeviceId: LENS_DEVICE.value });
    }
  }, [lensPhoto?.uri]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetToStep1 = useCallback(() => {
    if (pendingCapture.current) discardUnqueuedCapture(pendingCapture.current);
    pendingCapture.current = null;
    storedUri.current = null;
    setPicked(null);
    setQuality(null);
    setGateError(null);
    setBestEffort(false);
    setStep(1);
  }, []);

  const importFromGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      toast('Photo library permission is needed to import the fundus camera image.');
      return;
    }
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false });
    if (r.canceled || !r.assets?.[0]) return;
    resetToStep1();
    setPicked({ uri: r.assets[0].uri, source: 'gallery', mimeType: r.assets[0].mimeType ?? null });
    setMeta({ ...EMPTY_META, cameraDeviceId: 'unknown' });
  };

  const loadSample = async () => {
    const [asset] = await Asset.loadAsync(SAMPLE);
    if (!asset.localUri) { toast('Could not load the sample image.'); return; }
    resetToStep1();
    setPicked({ uri: asset.localUri, source: 'sample', mimeType: 'image/jpeg' });
    setMeta({ ...EMPTY_META, cameraDeviceId: 'unknown' });
  };

  const runCheck = async () => {
    if (!picked) return;
    setAnalyzing(true);
    setGateError(null);
    try {
      const captureId = newCaptureId();
      const capturedAt = lensPhoto && picked.source === 'lens' ? lensPhoto.takenAt : new Date().toISOString();
      const stored = await persistCaptureImage(picked.uri, captureId, picked.mimeType);
      storedUri.current = stored.uri;
      const cameraForPreset = picked.source === 'lens' ? LENS_DEVICE.value : meta.cameraDeviceId;
      const result = await runQualityGate(stored.uri, cameraForPreset);
      const before = await countRetakesToday(patientId);
      await recordCapture({
        captureId, patientId, cameraDeviceId: cameraForPreset, source: picked.source,
        imagePath: stored.uri, imageBytes: stored.bytes, quality: result, capturedAt,
      });
      pendingCapture.current = captureId;
      setRetakesBefore(before);
      setQuality(result);
      setStep(2);
    } catch (e) {
      setGateError((e as Error)?.message ?? String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const onRetake = () => {
    // A failed attempt stays recorded (it counts toward the retake limit);
    // a passing one the technician chose not to keep is dropped.
    if (quality?.status === 'retake') pendingCapture.current = null;
    resetToStep1();
  };

  const onAccept = () => { setBestEffort(false); setStep(3); };
  const onBestEffort = () => { setBestEffort(true); setStep(3); };

  const save = async () => {
    const captureId = pendingCapture.current;
    if (!captureId || !patient) return;
    setShowMetaErrors(true);
    const missing = metadataMissing(meta);
    if (missing.length) { toast(`Answer every capture question: ${missing.join(', ')}.`); return; }
    // Both questionnaires are mandatory (§9.1): a patient record with no (or an incomplete) questionnaire
    // must go back to registration, never be filled in with default answers.
    if (!patient.questionnaire || questionnaireMissing(patient.questionnaire).length) {
      toast('This patient has no completed symptom & risk questionnaire. Register the visit again to answer it.');
      return;
    }
    setSaving(true);
    try {
      const questionnaire = toQuestionnairePayload(patient.questionnaire, i18n.language.split('-')[0]);
      const metadata = toMetadataPayload(meta);
      await queueCapture({
        captureId, eye: meta.eye!, cameraDeviceId: meta.cameraDeviceId, bestEffort,
        questionnaire, metadata, priorityTier: priorityTier(questionnaire, metadata, quality, bestEffort),
      });
      pendingCapture.current = null;
      await syncManager.refreshPending();
      syncManager.trigger();
      toast(sync.connectivity === 'online'
        ? 'Saved. Uploading to the central server.'
        : 'Saved on this device. It will sync automatically when the connection returns.', 'success');
      navigation.navigate('Main', { screen: 'Queue' } as never);
    } catch (e) {
      toast(`Could not save the capture: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const elevatedRisk = !!patient?.questionnaire && (
    patient.questionnaire.glycemicControl === 'poor' || patient.questionnaire.yearsSinceDiagnosis === 'gt10'
    || patient.questionnaire.symptoms.suddenVisionChange || patient.questionnaire.symptoms.eyePain);

  const instructions = t(picked?.source === 'lens' || route.params.lensPhoto ? 'mobile.lensInstructions' : 'mobile.galleryInstructions', { returnObjects: true }) as string[];
  const eyeLabel = meta.eye === 'left' ? 'LEFT EYE (OS)' : meta.eye === 'right' ? 'RIGHT EYE (OD)' : 'EYE NOT SET';
  const imageUri = storedUri.current ?? picked?.uri ?? null;

  return (
    <View style={s.root}>
      <AppHeader onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.titlebar}>
          <Text style={s.h1}>{t('capture.title', 'IMAGE CAPTURE')}</Text>
          <Text style={s.patientLine}>
            {t('capture.patient', 'PATIENT:')} <Text style={s.patientName}>{(patient?.name ?? '…').toUpperCase()}</Text>
            {patient ? ` • ${patient.age}Y` : ''}
          </Text>
          <Text style={s.patientId}>{newRegistration ? 'NEW REGISTRATION · ' : ''}{patientId}</Text>
        </View>

        <Stepper steps={[t('capture.steps.capture', '1. CAPTURE'), t('capture.steps.quality', '2. QUALITY GATE'), t('capture.steps.metadata', '3. METADATA & SYNC')]} active={step} />

        {/* ── Image panel ── */}
        <View style={s.imgStrip}>
          {step === 3
            ? <Text style={[s.stripLabel, s.stripActive]}>CAPTURED — {eyeLabel}</Text>
            : (
              <>
                <Text style={[s.stripLabel, !picked && s.stripActive]}>{picked?.source === 'lens' ? 'FUNDUS LENS' : 'IMPORT'}</Text>
                <Text style={[s.stripLabel, !!picked && s.stripActive]}>{t('capture.statusCaptured', 'CAPTURED')}</Text>
              </>
            )}
        </View>
        {imageUri ? (
          <ImageViewer source={{ uri: imageUri }} height={300} />
        ) : (
          <View style={s.placeholder}>
            <Text style={s.placeholderIcon}>◎</Text>
            <Text style={s.placeholderText}>SELECT THE IMAGE FOR THIS PATIENT</Text>
          </View>
        )}

        {step === 1 ? (
          <View style={{ gap: 10, marginTop: 12 }}>
            {!picked ? (
              <>
                <Btn size="lg" icon="🖼" label="IMPORT FROM GALLERY" onPress={importFromGallery} accessibilityHint="Image taken on the dedicated fundus camera" />
                <Btn size="lg" variant="outline" icon="◉" label="CAPTURE WITH FUNDUS LENS" onPress={() => navigation.navigate('LensCamera', { patientId })} />
                {DEMO_TOOLS ? <Btn size="sm" variant="ghost" label={t('capture.loadSample', '✦ LOAD SAMPLE RETINAL SCAN')} onPress={loadSample} /> : null}
              </>
            ) : (
              <View style={s.actions}>
                <Btn variant="outline" label={t('capture.btnRetake', 'RETAKE')} onPress={resetToStep1} disabled={analyzing} style={{ flex: 1 }} />
                <Btn label={analyzing ? t('capture.btnAnalyzing', 'ANALYZING... ✦') : 'RUN QUALITY CHECK →'} loading={analyzing} onPress={runCheck} style={{ flex: 1.6 }} />
              </View>
            )}
            {analyzing ? (
              <View style={s.analyzing}>
                <ActivityIndicator color={theme.c.crimson} />
                <Text style={s.caption}>Checking focus, illumination, field of view, glare, motion and occlusion at full resolution. This can take several seconds.</Text>
              </View>
            ) : null}
            {gateError ? (
              <Notice title="QUALITY CHECK COULD NOT RUN">
                <Text style={s.noticeText}>
                  No quality result exists for this image, so it cannot continue. The image is kept; try again. ({gateError})
                </Text>
              </Notice>
            ) : null}
            <Card title={t('capture.instructionsTitle', 'INSTRUCTIONS')}>
              {instructions.map((line, i) => (
                <View key={line} style={s.instr}>
                  <Text style={s.instrNum}>0{i + 1}</Text>
                  <Text style={s.instrText}>{line}</Text>
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {step === 2 && quality ? (
          <View style={{ marginTop: 12 }}>
            <QualityResultPanel
              result={quality}
              retakeCount={retakesBefore}
              elevatedRisk={elevatedRisk}
              onRetake={onRetake}
              onAccept={onAccept}
              onBestEffort={onBestEffort}
            />
          </View>
        ) : null}

        {step === 3 ? (
          <View style={{ marginTop: 12, gap: 12 }}>
            {bestEffort ? (
              <Notice tone="warning" title="BEST EFFORT — UNGRADABLE">
                This capture failed the quality gate {retakesBefore + 1} times. It will be flagged for mandatory Tier C review.
              </Notice>
            ) : null}
            <CaptureMetadataForm value={meta} onChange={setMeta} lensCapture={picked?.source === 'lens'} showErrors={showMetaErrors} />
            <Btn size="lg" label="SAVE & SYNC TO SERVER →" loading={saving} onPress={save} />
            <Text style={s.caption}>
              The case is saved on this phone first. It uploads now if the central server is reachable, otherwise automatically when it is.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.c.surface },
  scroll: { padding: 16, paddingBottom: 48 },
  titlebar: { marginBottom: 12 },
  h1: { fontFamily: t.fonts.heavy, fontSize: 24, color: t.c.text, letterSpacing: -0.5 },
  patientLine: { fontFamily: t.fonts.monoBold, fontSize: 11, color: t.c.text, marginTop: 4 },
  patientName: { color: t.c.crimson },
  patientId: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.textMuted, marginTop: 2 },
  imgStrip: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginBottom: 6 },
  stripLabel: { fontFamily: t.fonts.monoBold, fontSize: 10, letterSpacing: 1.2, color: t.c.textMuted },
  stripActive: { color: t.c.crimson },
  placeholder: {
    height: 220,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'rgba(196, 43, 43, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: t.c.creamLight,
  },
  placeholderIcon: { fontSize: 42, color: t.c.crimson },
  placeholderText: { fontFamily: t.fonts.mono, fontSize: 11, color: t.c.textMuted, letterSpacing: 0.8 },
  actions: { flexDirection: 'row', gap: 8 },
  analyzing: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  caption: { flex: 1, fontFamily: t.fonts.mono, fontSize: 10, color: t.c.textMuted, lineHeight: 15 },
  noticeText: { fontFamily: t.fonts.body, fontSize: 13, lineHeight: 19, color: t.c.text },
  instr: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  instrNum: { fontFamily: t.fonts.monoBold, fontSize: 12, color: t.c.crimson },
  instrText: { flex: 1, fontFamily: t.fonts.body, fontSize: 13.5, lineHeight: 19, color: t.c.text },
}));
