
import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { makeStyles } from '../theme/ThemeContext';
import { AppHeader } from '../components/AppHeader';
import { RetinalBackdrop } from '../components/RetinalBackdrop';
import { Btn, ChipGroup, Field, Input, MultiChipGroup, Notice, Row, SectionHeader, Toggle } from '../components/ui';
import { SelectField } from '../components/SelectField';
import { DateField } from '../components/DateField';
import { useToast } from '../components/Toast';
import { Demographics, Patient, PatientQuestionnaire, Symptoms } from '../types';
import { EMPTY_QUESTIONNAIRE, pregnancyApplies, questionnaireMissing } from '../lib/questionnaire';
import { ageFromDob, formatDateTime } from '../lib/format';
import { createPatient, findPossibleDuplicates, PatientMatch, searchPatients, updatePatientVisit } from '../db/patients';
import { RootStackParamList } from '../navigation/types';

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman & Nicobar Islands', 'Chandigarh',
  'Dadra & Nagar Haveli', 'Daman & Diu', 'Delhi', 'Jammu & Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

const EMPTY_DEMOGRAPHICS: Demographics = {
  patientType: 'new', abhaId: '', visitNo: '1', title: 'Mr', firstName: '', middleName: '', lastName: '',
  gender: '', dob: '', maritalStatus: '', bloodGroup: 'Unknown', address: '', state: '', pincode: '',
  district: '', occupation: '', altPhone: '',
};

const SYMPTOMS: { value: keyof Symptoms; label: string }[] = [
  { value: 'blurredVision', label: 'BLURRED VISION' },
  { value: 'floaters', label: 'FLOATERS' },
  { value: 'suddenVisionChange', label: 'SUDDEN VISION CHANGE' },
  { value: 'eyePain', label: 'EYE PAIN' },
];

const validPhone = (p: string) => p.replace(/\D/g, '').length >= 10;

export default function RegistrationScreen() {
  const s = useStyles();
  const { t } = useTranslation();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [d, setD] = useState<Demographics>(EMPTY_DEMOGRAPHICS);
  const [age, setAge] = useState('');
  const [contact, setContact] = useState('');
  const [q, setQ] = useState<PatientQuestionnaire>(EMPTY_QUESTIONNAIRE);
  const [consentAt, setConsentAt] = useState<string | null>(null);
  const [existing, setExisting] = useState<Patient | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<PatientMatch[] | null>(null);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Patient[]>([]);

  useEffect(() => {
    let cancelled = false;
    searchPatients(search).then((r) => { if (!cancelled) setResults(r); }).catch(() => { });
    return () => { cancelled = true; };
  }, [search]);

  const setDemo = <K extends keyof Demographics>(k: K, v: Demographics[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const setQn = <K extends keyof PatientQuestionnaire>(k: K, v: PatientQuestionnaire[K]) => setQ((prev) => ({ ...prev, [k]: v }));

  const onDob = (v: string) => {
    setDemo('dob', v);
    const a = ageFromDob(v);
    if (a !== null) setAge(String(a));
  };

  const parsedAge = age.trim() === '' ? null : Number(age);
  const fullName = [d.firstName, d.middleName, d.lastName].map((x) => x.trim()).filter(Boolean).join(' ');
  const showPregnancy = pregnancyApplies(existing ? existing.age : parsedAge, existing?.demographics?.gender ?? d.gender);

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!existing) {
      if (!d.firstName.trim()) e.firstName = 'Required';
      if (!d.lastName.trim()) e.lastName = 'Required';
      if (!d.gender) e.gender = 'Required';
      if (parsedAge === null || !Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 130) e.age = 'Enter age in years (0–130)';
      if (!d.address.trim()) e.address = 'Required';
      if (!d.state) e.state = 'Required';
      if (!d.district.trim()) e.district = 'Required';
    }
    if (!validPhone(contact)) e.contact = 'A reachable 10-digit number is required — it is the only channel for results';
    for (const m of questionnaireMissing(q)) e[m] = 'Answer required';
    if (q.hba1c.trim() !== '' && !(Number(q.hba1c) >= 4 && Number(q.hba1c) <= 20)) e.hba1c = 'HbA1c must be 4–20 %, or leave blank';
    if (!consentAt) e.consent = 'Verbal consent must be confirmed before capture';
    return e;
  }, [d, parsedAge, contact, q, consentAt, existing, showPregnancy]);

  const err = (k: string) => (showErrors ? errors[k] ?? null : null);

  const clearAll = () => {
    setD(EMPTY_DEMOGRAPHICS); setAge(''); setContact(''); setQ(EMPTY_QUESTIONNAIRE);
    setConsentAt(null); setExisting(null); setShowErrors(false); setSearch('');
  };

  const selectExisting = (p: Patient) => {
    setExisting(p);
    setContact(p.contactNumber);
    if (p.questionnaire) setQ({ ...p.questionnaire, symptoms: { ...EMPTY_QUESTIONNAIRE.symptoms } });
    setSearch('');
    setMatches(null);
  };

  const proceed = async (asExisting: Patient | null) => {
    setBusy(true);
    try {
      const consent = consentAt ?? new Date().toISOString();
      const questionnaire = { ...q, pregnancy: showPregnancy ? q.pregnancy : 'not_applicable' as const };
      const patient = asExisting
        ? await updatePatientVisit(asExisting.patientId, questionnaire, consent, contact.trim())
        : await createPatient({
          name: fullName, age: parsedAge as number, contactNumber: contact.trim(), consentGivenAt: consent,
          demographics: d, questionnaire,
        });
      navigation.navigate('Capture', { patientId: patient.patientId, newRegistration: !asExisting });
      clearAll();
    } catch (e) {
      toast(`Could not save the patient on this device: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) {
      toast(`Complete the highlighted fields (${Object.keys(errors).length}).`);
      return;
    }
    if (existing) return proceed(existing);
    const found = await findPossibleDuplicates(fullName, parsedAge, contact).catch(() => []);
    if (found.length) { setMatches(found); return; }
    return proceed(null);
  };

  const consentLabel = consentAt ? formatDateTime(consentAt) : null;

  return (
    <View style={s.root}>
      <AppHeader />
      <View style={{ flex: 1 }}>
        <RetinalBackdrop />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
            <Text style={s.h1}>{t('registration.title', 'REGISTER PATIENT')}</Text>

            {/* ── Find existing patient (§4.1 lookup) ── */}
            {!existing ? (
              <Field label={t('mobile.findExisting', 'FIND EXISTING PATIENT (REVISIT)')} hint="Search by name, phone or patient ID on this device.">
                <Input value={search} onChangeText={setSearch} placeholder="Name / phone / ID" autoCorrect={false} />
                {results.length ? (
                  <View style={s.results}>
                    {results.map((p) => (
                      <Pressable key={p.patientId} style={s.result} onPress={() => selectExisting(p)} accessibilityRole="button">
                        <Text style={s.resultName}>{p.name} · {p.age}Y</Text>
                        <Text style={s.resultMeta}>{p.patientId} · {p.contactNumber}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </Field>
            ) : (
              <Notice title="REVISIT — EXISTING PATIENT" tone="success">
                <Text style={s.resultName}>{existing.name} · {existing.age}Y</Text>
                <Text style={s.resultMeta}>{existing.patientId} · registered {formatDateTime(existing.registeredAt)}</Text>
                <Btn size="sm" variant="outline" label="REGISTER A DIFFERENT PATIENT" onPress={clearAll} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
              </Notice>
            )}

            {!existing ? (
              <>
                {/* ── 01 PATIENT INFORMATION ── */}
                <SectionHeader badge="01" title="PATIENT INFORMATION" />
                <Row>
                  <Field label="PATIENT TYPE">
                    <SelectField title="PATIENT TYPE" value={d.patientType} onChange={(v) => setDemo('patientType', v as Demographics['patientType'])}
                      options={[{ value: 'new', label: 'New Patient' }, { value: 'revisit', label: 'Revisit' }, { value: 'referral', label: 'Referral' }]} />
                  </Field>
                  <Field label="PATIENT ID">
                    <Input editable={false} placeholder="auto-generated" />
                  </Field>
                </Row>
                <Row>
                  <Field label="ABHA ID (OPTIONAL)">
                    <Input value={d.abhaId} onChangeText={(v) => setDemo('abhaId', v.replace(/\D/g, ''))} maxLength={14} keyboardType="number-pad" placeholder="14 digits" />
                  </Field>
                  <Field label="VISIT NO.">
                    <Input value={d.visitNo} onChangeText={(v) => setDemo('visitNo', v)} keyboardType="number-pad" />
                  </Field>
                </Row>
                <Row>
                  <Field label="TITLE">
                    <SelectField title="TITLE" value={d.title} onChange={(v) => setDemo('title', v)} options={opts(['Mr', 'Mrs', 'Ms', 'Dr', 'Prof'])} />
                  </Field>
                  <Field label="FIRST NAME" required error={err('firstName')}>
                    <Input value={d.firstName} onChangeText={(v) => setDemo('firstName', v)} invalid={!!err('firstName')} autoCapitalize="words" />
                  </Field>
                </Row>
                <Row>
                  <Field label="MIDDLE NAME">
                    <Input value={d.middleName} onChangeText={(v) => setDemo('middleName', v)} autoCapitalize="words" placeholder="Optional" />
                  </Field>
                  <Field label="LAST NAME" required error={err('lastName')}>
                    <Input value={d.lastName} onChangeText={(v) => setDemo('lastName', v)} invalid={!!err('lastName')} autoCapitalize="words" />
                  </Field>
                </Row>
                <Row>
                  <Field label="GENDER" required error={err('gender')}>
                    <SelectField title="GENDER" value={d.gender} invalid={!!err('gender')} onChange={(v) => setDemo('gender', v as Demographics['gender'])}
                      options={[{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'other', label: 'Other' }]} />
                  </Field>
                  <Field label="DATE OF BIRTH">
                    <DateField value={d.dob} onChange={onDob} />
                  </Field>
                </Row>
                <Row>
                  <Field label="AGE" required error={err('age')}>
                    <Input value={age} onChangeText={(v) => setAge(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={3} invalid={!!err('age')} />
                  </Field>
                  <Field label="MARITAL STATUS">
                    <SelectField title="MARITAL STATUS" value={d.maritalStatus} onChange={(v) => setDemo('maritalStatus', v)}
                      options={[{ value: 'single', label: 'Single' }, { value: 'married', label: 'Married' }, { value: 'widowed', label: 'Widowed' }, { value: 'divorced', label: 'Divorced' }]} />
                  </Field>
                </Row>
                <Field label="BLOOD GROUP">
                  <SelectField title="BLOOD GROUP" value={d.bloodGroup} onChange={(v) => setDemo('bloodGroup', v)} options={opts(['Unknown', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])} />
                </Field>

                {/* ── 02 ADDRESS ── */}
                <SectionHeader badge="02" title="ADDRESS" />
                <Field label="ADDRESS" required error={err('address')}>
                  <Input value={d.address} onChangeText={(v) => setDemo('address', v)} multiline placeholder="Full address" invalid={!!err('address')} />
                </Field>
                <Row>
                  <Field label="STATE" required error={err('state')}>
                    <SelectField title="STATE" value={d.state} invalid={!!err('state')} onChange={(v) => setDemo('state', v)} options={opts(INDIAN_STATES)} />
                  </Field>
                  <Field label="PINCODE">
                    <Input value={d.pincode} onChangeText={(v) => setDemo('pincode', v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={6} />
                  </Field>
                </Row>
                <Row>
                  <Field label="DISTRICT" required error={err('district')}>
                    <Input value={d.district} onChangeText={(v) => setDemo('district', v)} invalid={!!err('district')} autoCapitalize="words" />
                  </Field>
                  <Field label="OCCUPATION">
                    <SelectField title="OCCUPATION" value={d.occupation} onChange={(v) => setDemo('occupation', v)}
                      options={[{ value: 'farmer', label: 'Farmer' }, { value: 'labourer', label: 'Daily Labourer' }, { value: 'homemaker', label: 'Homemaker' },
                      { value: 'govt_employee', label: 'Govt. Employee' }, { value: 'business', label: 'Business' }, { value: 'student', label: 'Student' }, { value: 'other', label: 'Other' }]} />
                  </Field>
                </Row>
              </>
            ) : (
              <SectionHeader badge="02" title="CONTACT" />
            )}

            <Row>
              <Field label="CONTACT NUMBER" required error={err('contact')}>
                <Input value={contact} onChangeText={setContact} keyboardType="phone-pad" placeholder="+91…" invalid={!!err('contact')} />
              </Field>
              {!existing ? (
                <Field label="ALTERNATE PHONE">
                  <Input value={d.altPhone} onChangeText={(v) => setDemo('altPhone', v)} keyboardType="phone-pad" placeholder="Optional" />
                </Field>
              ) : <View />}
            </Row>

            {/* ── 03 CLINICAL SYMPTOM & RISK QUESTIONNAIRE (§9.1) ── */}
            <SectionHeader badge="03" title="CLINICAL SYMPTOM & RISK QUESTIONNAIRE" />
            <View style={s.qCard}>
              <Toggle label="KNOWN DIABETIC?" value={q.knownDiabetic} onChange={(v) => setQn('knownDiabetic', v)} />
              {q.knownDiabetic ? (
                <>
                  <Field label="YEARS SINCE DIAGNOSIS" required error={err('yearsSinceDiagnosis')}>
                    <ChipGroup columns={4} value={q.yearsSinceDiagnosis} onChange={(v) => setQn('yearsSinceDiagnosis', v)}
                      options={[{ value: 'lt1', label: '< 1 YR' }, { value: '1to5', label: '1–5 YRS' }, { value: '5to10', label: '5–10 YRS' }, { value: 'gt10', label: '> 10 YRS' }]} />
                  </Field>
                  <Field label="HbA1c % (IF TESTED)" error={err('hba1c')} hint='Leave blank if not tested. Blank is recorded as "not measured"; it is never guessed.'>
                    <Input value={q.hba1c} onChangeText={(v) => setQn('hba1c', v.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder="e.g. 8.2" maxLength={4} />
                  </Field>
                </>
              ) : null}
              <Field label="GLYCEMIC CONTROL (BLOOD SUGAR)" required error={err('glycemicControl')}>
                <ChipGroup columns={3} value={q.glycemicControl} onChange={(v) => setQn('glycemicControl', v)}
                  options={[{ value: 'good', label: 'GOOD' }, { value: 'moderate', label: 'MODERATE' }, { value: 'poor', label: 'POOR' }]} />
              </Field>
              <Field label="BLOOD PRESSURE STATUS" required error={err('bloodPressure')}>
                <ChipGroup columns={3} value={q.bloodPressure} onChange={(v) => setQn('bloodPressure', v)}
                  options={[{ value: 'normal', label: 'NORMAL' }, { value: 'high', label: 'HIGH (HTN)' }, { value: 'unknown', label: 'UNKNOWN' }]} />
              </Field>
              {showPregnancy ? (
                <Field label="CURRENTLY PREGNANT?" required>
                  <ChipGroup columns={3} value={q.pregnancy} onChange={(v) => setQn('pregnancy', v)}
                    options={[{ value: 'yes', label: 'YES' }, { value: 'no', label: 'NO' }, { value: 'not_applicable', label: 'N / A' }]} />
                </Field>
              ) : null}
              <Field label="CURRENT EYE SYMPTOMS (SELECT ALL THAT APPLY)" style={{ marginBottom: 0 }}>
                <MultiChipGroup
                  columns={2}
                  values={SYMPTOMS.filter((x) => q.symptoms[x.value]).map((x) => x.value)}
                  onToggle={(k) => setQn('symptoms', { ...q.symptoms, [k]: !q.symptoms[k] })}
                  options={SYMPTOMS}
                />
              </Field>
            </View>

            {/* ── 04 INFORMED VERBAL CONSENT (§9.7) ── */}
            <Pressable
              style={[s.consent, !!err('consent') && s.consentError]}
              onPress={() => setConsentAt(consentAt ? null : new Date().toISOString())}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !!consentAt }}
            >
              <View style={[s.checkbox, !!consentAt && s.checkboxOn]}>{consentAt ? <Text style={s.check}>✓</Text> : null}</View>
              <View style={{ flex: 1 }}>
                <Text style={s.consentTitle}>INFORMED VERBAL CONSENT (DPDP ACT)</Text>
                <Text style={s.consentBody}>
                  I confirm that informed verbal consent has been obtained from the patient for retinal image capture,
                  clinical risk assessment, and tele-ophthalmology review.
                </Text>
                {consentLabel ? <Text style={s.consentAt}>CONFIRMED {consentLabel}</Text> : null}
                {err('consent') ? <Text style={s.consentErrText}>{err('consent')}</Text> : null}
              </View>
            </Pressable>

            <View style={s.footer}>
              <Btn variant="outline" label="CLEAR ALL" onPress={clearAll} style={{ flex: 1 }} />
              <Btn size="lg" label={busy ? t('registration.btnRegistering', 'REGISTERING...') : 'INITIATE CAPTURE →'} loading={busy} onPress={submit} style={{ flex: 1.6 }} />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>

      <Modal visible={!!matches} transparent animationType="fade" onRequestClose={() => setMatches(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>POSSIBLE EXISTING PATIENT</Text>
            <Text style={s.modalBody}>
              This registration looks like a patient already on this device. Using the existing record keeps one patient history.
            </Text>
            <ScrollView style={{ maxHeight: 260 }}>
              {(matches ?? []).map((m) => (
                <View key={m.patient.patientId} style={s.match}>
                  <Text style={s.resultName}>{m.patient.name} · {m.patient.age}Y</Text>
                  <Text style={s.resultMeta}>{m.patient.patientId} · {m.patient.contactNumber}</Text>
                  <Text style={s.resultMeta}>MATCHED ON: {m.matchedOn.join(', ').toUpperCase()}</Text>
                  <Btn size="sm" label="USE THIS PATIENT" onPress={() => { const p = m.patient; setMatches(null); selectExisting(p); proceed(p); }} style={{ marginTop: 8 }} />
                </View>
              ))}
            </ScrollView>
            <Btn variant="outline" label="NOT THE SAME — CREATE NEW" onPress={() => { setMatches(null); proceed(null); }} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.c.surface },
  scroll: { padding: 16, paddingBottom: 48 },
  h1: { fontFamily: t.fonts.heavy, fontSize: 24, color: t.c.text, letterSpacing: -0.5, marginBottom: 12 },
  results: { borderWidth: 1, borderColor: t.c.border, marginTop: 6, backgroundColor: t.c.creamLight },
  result: { padding: 12, borderBottomWidth: 1, borderBottomColor: t.c.grid, minHeight: 48 },
  resultName: { fontFamily: t.fonts.bold, fontSize: 15, color: t.c.text },
  resultMeta: { fontFamily: t.fonts.mono, fontSize: 10.5, color: t.c.textMuted, marginTop: 2 },
  qCard: { backgroundColor: t.c.creamLight, borderWidth: 1, borderColor: t.c.border, padding: 14, gap: 2 },
  consent: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
    padding: 14,
    backgroundColor: 'rgba(245, 237, 224, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(196, 43, 43, 0.2)',
    borderLeftWidth: 3,
    borderLeftColor: t.c.crimson,
  },
  consentError: { borderColor: t.c.danger },
  checkbox: { width: 24, height: 24, borderWidth: 2, borderColor: t.c.crimson, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkboxOn: { backgroundColor: t.c.crimson },
  check: { color: '#FFFFFF', fontFamily: t.fonts.monoBold, fontSize: 14 },
  consentTitle: { fontFamily: t.fonts.monoBold, fontSize: 10.5, letterSpacing: 1, color: t.c.crimson, marginBottom: 4 },
  consentBody: { fontFamily: t.fonts.body, fontSize: 13, lineHeight: 19, color: t.c.text },
  consentAt: { fontFamily: t.fonts.mono, fontSize: 10, color: t.c.success, marginTop: 6 },
  consentErrText: { fontFamily: t.fonts.medium, fontSize: 12, color: t.c.danger, marginTop: 6 },
  footer: { flexDirection: 'row', gap: 10, marginTop: 24 },
  modalBackdrop: { flex: 1, backgroundColor: t.c.overlay, justifyContent: 'center', padding: 20 },
  modal: { backgroundColor: t.c.surface, borderWidth: 2, borderColor: t.c.crimson, padding: 16 },
  modalTitle: { fontFamily: t.fonts.monoBold, fontSize: 12, letterSpacing: 1.4, color: t.c.crimson, marginBottom: 8 },
  modalBody: { fontFamily: t.fonts.body, fontSize: 13, lineHeight: 19, color: t.c.text, marginBottom: 12 },
  match: { borderWidth: 1, borderColor: t.c.border, padding: 12, marginBottom: 8 },
}));
