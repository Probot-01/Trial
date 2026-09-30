import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localApi } from '../../api/localApiClient';
import { USE_MOCK_DATA } from '../../config';
import { RetinalWaveCanvas } from '../shared/RetinalWaveCanvas';
import { LoadError } from '../shared/LoadError';
import { saveQuestionnaire } from '../../api/patientSession';
import { BLOOD_PRESSURE } from '../../api/captureOptions';

// Mock mode opens the form pre-filled with a clearly fictional patient for
// rapid testing. Live mode opens it empty — and with consent NOT ticked: a
// technician must record consent for the real person in front of them.
const demo = (value, empty = '') => (USE_MOCK_DATA ? value : empty);

// `dob` stays DD/MM/YYYY everywhere in this component (parsed at line ~172,
// submitted at line ~276) -- <input type="date"> is the only change needed to
// get a native calendar picker, but it speaks ISO (YYYY-MM-DD) to the DOM.
// These convert at that one boundary so nothing downstream has to change.
const ddmmyyyyToIso = (dob) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dob || '');
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};
const isoToDdmmyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
};

/* ── questionnaire options: exactly the API's values (api-contracts.md) ── */
// (The form used to offer "Low (Hypotension)", which the API does not accept.)
// Ids only here -- the module scope has no i18n hook. Labels are looked up by
// id from questionnaire.bpOptions/.symptoms at render time, inside the
// component, with the English text from captureOptions.js as the t() fallback.
const BLOOD_PRESSURE_IDS = BLOOD_PRESSURE.map((o) => o.id);
const BLOOD_PRESSURE_LABELS = Object.fromEntries(BLOOD_PRESSURE.map((o) => [o.id, o.label]));

const EYE_SYMPTOM_IDS = ['blurredVision', 'floaters', 'suddenVisionChange', 'eyePain'];

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh',
  'Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka',
  'Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram',
  'Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana',
  'Tripura','Uttar Pradesh','Uttarakhand','West Bengal',
  'Andaman & Nicobar Islands','Chandigarh','Dadra & Nagar Haveli','Daman & Diu',
  'Delhi','Jammu & Kashmir','Ladakh','Lakshadweep','Puducherry',
];

/* ── Top-level Helper Components (must be outside to preserve DOM input focus) ── */
const SectionHeader = ({ title, label }) => (
  <div className="reg-section-header">
    {label && <span className="reg-section-header__badge">{label}</span>}
    <h2 className="reg-section-header__title">{title}</h2>
    <div className="reg-section-header__line" />
  </div>
);

const Field = ({ label, required, children, span }) => (
  <div className={`reg-field${span ? ` reg-field--span-${span}` : ''}`}>
    <label className="reg-label">{required && <span className="reg-req">*</span>}{label}</label>
    {children}
  </div>
);

const ChipGroup = ({ options, value, onChange, multi = false }) => (
  <div className="reg-chip-group">
    {options.map(opt => {
      const isActive = multi ? value[opt.id] : value === (opt.id || opt.value);
      return (
        <button
          key={opt.id || opt.value}
          type="button"
          className={`reg-chip${isActive ? ' reg-chip--active' : ''}`}
          onClick={() => multi ? onChange(opt.id) : onChange(opt.id || opt.value)}
        >
          {isActive && multi && <span className="reg-chip__check">✓ </span>}
          {opt.label}
        </button>
      );
    })}
  </div>
);

export const PatientRegistrationForm = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [submitError, setSubmitError] = useState(null);

  /* ── patient-info (mock mode: prefilled fictional patient, see demo()) ── */
  const [patientType, setPatientType] = useState('new');
  const [abhaId, setAbhaId] = useState(demo('91827364501928'));
  const [visitNo, setVisitNo] = useState(demo('1'));
  const [title, setTitle] = useState(demo('Mrs', 'Mr'));
  const [firstName, setFirstName] = useState(demo('Sunita'));
  const [middleName, setMiddleName] = useState(demo('K.'));
  const [lastName, setLastName] = useState(demo('Devi'));
  const [gender, setGender] = useState(demo('female'));
  const [dob, setDob] = useState(demo('12/03/1972'));
  const [age, setAge] = useState(demo('54'));
  const [maritalStatus, setMaritalStatus] = useState(demo('married'));
  const [bloodGroup, setBloodGroup] = useState(demo('B+', 'Unknown'));

  /* ── address ──────────────────────────────────────────── */
  const [address, setAddress] = useState(demo('Plot No. 24, Near Gram Panchayat, Village Rampur'));
  const [state, setState] = useState(demo('Maharashtra'));
  const [pincode, setPincode] = useState(demo('413102'));
  const [district, setDistrict] = useState(demo('Solapur'));
  const [occupation, setOccupation] = useState(demo('homemaker'));
  const [contactNumber, setContactNumber] = useState(demo('+919876543210'));
  const [altPhone, setAltPhone] = useState(demo('+919811223344'));

  /* ── duplicate check (design doc SS10.3, backend plan SSB.1) ──────────────
     The same person registered twice becomes two patient records with two
     separate screening histories and nothing pointing between them. The
     search endpoint has existed since B.1 and nothing called it. */
  const [dupes, setDupes] = useState([]);
  const [dupeChecked, setDupeChecked] = useState(false);

  // Debounced, and only once there is enough to search on -- the server
  // refuses a search on age alone because it would return most of the
  // register. Failures are swallowed on purpose: this is an ADVISORY check,
  // and a search that errors must never block a registration.
  useEffect(() => {
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ').trim();
    const hasName = fullName.length >= 3;
    const hasPhone = String(contactNumber || '').replace(/\D/g, '').length >= 4;
    if (!hasName && !hasPhone) { setDupes([]); setDupeChecked(false); return undefined; }

    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const found = await localApi.searchPatients({
          name: fullName, phone: contactNumber, age,
        });
        if (!cancelled) { setDupes(found || []); setDupeChecked(true); }
      } catch {
        if (!cancelled) { setDupes([]); setDupeChecked(false); }
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [firstName, middleName, lastName, contactNumber, age]);

  /* ── questionnaire ────────────────────────────────────── */
  // Live mode starts with NOTHING answered (null / ''): "no skip" means every
  // question needs an answer the technician gave. A pre-selected 'moderate',
  // 'normal' or 'not applicable' would be an answer nobody gave.
  const [knownDiabetic, setKnownDiabetic] = useState(demo(true, null));
  const [yearsSinceDx, setYearsSinceDx] = useState(demo('5to10', ''));
  const [glycemicControl, setGlycemicControl] = useState(demo('moderate', ''));
  const [bloodPressure, setBloodPressure] = useState(demo('high', ''));
  const [pregnancy, setPregnancy] = useState(demo('not_applicable', ''));
  const [eyeSymptoms, setEyeSymptoms] = useState({
    blurredVision: demo(true, false), floaters: false, suddenVisionChange: false, eyePain: false,
  });
  // Symptoms are yes/no each, so "none of these" must be tapped -- an untouched
  // symptom list is not the same as "the patient has no symptoms".
  const [noSymptoms, setNoSymptoms] = useState(false);

  /* ── consent ──────────────────────────────────────────── */
  const [consentObtained, setConsentObtained] = useState(demo(true, false));
  const [consentGivenAt, setConsentGivenAt] = useState(() => (USE_MOCK_DATA ? new Date().toISOString() : null));

  /* derived */
  const parsedAge = parseInt(age, 10);
  const couldBePregnant = !age || isNaN(parsedAge) || parsedAge < 55;
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');

  // Every question answered? (Years since diagnosis is only asked of known
  // diabetics; pregnancy only where it could apply.)
  const symptomsAnswered = noSymptoms || Object.values(eyeSymptoms).some(Boolean);
  const questionnaireMissing = [
    knownDiabetic === null && t('registration.missing.knownDiabetic', 'known diabetic?'),
    knownDiabetic === true && !yearsSinceDx && t('registration.missing.yearsSinceDiagnosis', 'years since diagnosis'),
    !glycemicControl && t('registration.missing.glycemicControl', 'glycemic control'),
    !bloodPressure && t('registration.missing.bloodPressure', 'blood pressure'),
    couldBePregnant && !pregnancy && t('registration.missing.pregnancy', 'pregnancy'),
    !symptomsAnswered && t('registration.missing.eyeSymptoms', 'eye symptoms (or "none of these")'),
  ].filter(Boolean);

  /* auto-compute age from DOB */
  useEffect(() => {
    if (!dob) return;
    const [d, m, y] = dob.split('/').map(Number);
    if (!y || y < 1900) return;
    const birth = new Date(y, (m || 1) - 1, d || 1);
    const diff = Date.now() - birth.getTime();
    const computed = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
    if (computed > 0 && computed < 120) setAge(String(computed));
  }, [dob]);

  const toggleSymptom = (id) => {
    setNoSymptoms(false);
    setEyeSymptoms(prev => ({ ...prev, [id]: !prev[id] }));
  };
  const chooseNoSymptoms = () => {
    setNoSymptoms(true);
    setEyeSymptoms({ blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false });
  };

  const handleConsentChange = (e) => {
    const checked = e.target.checked;
    setConsentObtained(checked);
    setConsentGivenAt(checked ? new Date().toISOString() : null);
  };

  const handleClearAll = () => {
    setPatientType('new'); setAbhaId(''); setVisitNo('');
    setTitle('Mr'); setFirstName(''); setMiddleName(''); setLastName('');
    setGender(''); setDob(''); setAge(''); setMaritalStatus(''); setBloodGroup('Unknown');
    setAddress(''); setState(''); setPincode(''); setDistrict('');
    setOccupation(''); setContactNumber(''); setAltPhone('');
    setKnownDiabetic(null); setYearsSinceDx(''); setGlycemicControl('');
    setBloodPressure(''); setPregnancy(''); setNoSymptoms(false);
    setEyeSymptoms({ blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false });
    setConsentObtained(false); setConsentGivenAt(null);
  };

  // Shared between a fresh registration and "USE THIS PATIENT" on a confirmed
  // duplicate: the same today's-visit answers, either way.
  const buildQuestionnaire = () => ({
    knownDiabetic,
    // The API has no "not diabetic" value for this question and requires
    // one of the four buckets. For a patient who is not a known diabetic
    // it is recorded as '< 1 yr' -- and the form says so on screen; it is
    // never quietly a leftover default.
    yearsSinceDiagnosis: knownDiabetic ? yearsSinceDx : 'lt1',
    glycemicControl, bloodPressure,
    // Not asked (and sent as null) where pregnancy cannot apply.
    pregnancy: couldBePregnant ? pregnancy : 'not_applicable',
    ...eyeSymptoms,
  });

  // §10.3: the technician confirms a search hit IS this same person. Reuse
  // their existing id -- a second registration would start a second, unlinked
  // screening history for one patient -- rather than creating a new record.
  // Today's questionnaire is still recorded (risk factors and symptoms change
  // between visits) and cached on this station the same way a fresh
  // registration's is; the existing patient's own demographic record on the
  // server is left untouched.
  const [usingExistingId, setUsingExistingId] = useState(null);
  const handleUseExisting = async (existing) => {
    if (!consentObtained) {
      alert(t('registration.consent.alertRequired', 'Informed verbal consent is required before initiating screening.'));
      return;
    }
    if (!USE_MOCK_DATA && questionnaireMissing.length) {
      setSubmitError({ message: t('registration.answerAllPrefix', 'Answer every question before capture: ') + questionnaireMissing.join(', ') + '.' });
      return;
    }
    setSubmitError(null);
    setUsingExistingId(existing.patientId);
    try {
      saveQuestionnaire(existing.patientId, buildQuestionnaire());
      const query = new URLSearchParams({
        patientId: existing.patientId,
        name: existing.name || fullName,
        age: String(existing.age ?? age ?? ''),
        contact: contactNumber || '',
      }).toString();
      navigate(`/capture?${query}`);
    } finally {
      setUsingExistingId(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!consentObtained) {
      alert(t('registration.consent.alertRequired', 'Informed verbal consent is required before initiating screening.'));
      return;
    }
    if (!USE_MOCK_DATA && questionnaireMissing.length) {
      setSubmitError({ message: t('registration.answerAllPrefix', 'Answer every question before capture: ') + questionnaireMissing.join(', ') + '.' });
      return;
    }
    setLoading(true);
    setSubmitError(null);
    try {
      const payload = {
        name: fullName || firstName,
        age,
        contactNumber,
        abhaId,
        visitNo,
        title,
        firstName, middleName, lastName,
        gender, dob, maritalStatus, bloodGroup,
        address, state, pincode, district, occupation, altPhone,
        questionnaire: buildQuestionnaire(),
        consentGivenAt: consentGivenAt || new Date().toISOString(),
      };
      const newPatient = await localApi.registerPatient(payload);
      // Kept PER PATIENT for the capture screen to attach to each capture.
      saveQuestionnaire(newPatient.patientId, payload.questionnaire);
      try {
        localStorage.setItem('netra_latest_patient', JSON.stringify({ ...newPatient, ...payload }));
        const existing = JSON.parse(localStorage.getItem('netra_registered_patients') || '[]');
        localStorage.setItem('netra_registered_patients', JSON.stringify([{ ...newPatient, ...payload }, ...existing]));
      } catch (err) { console.warn('Storage sync failed:', err); }
      const query = new URLSearchParams({
        patientId: newPatient.patientId,
        name: payload.name,
        age: payload.age || '',
        contact: payload.contactNumber || '',
      }).toString();
      navigate(`/capture?${query}`);
    } catch (err) {
      // Not registered: stay on the form with everything the technician typed.
      console.error(err);
      setSubmitError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="reg-screen">
      <RetinalWaveCanvas />

      <form className="reg-form" onSubmit={handleSubmit} noValidate>

        {/* ── 1. PATIENT INFORMATION ─────────────────────── */}
        <SectionHeader title={t('registration.sectionPatientInfo', 'Patient Information')} label="01" />

        <div className="reg-grid">
          <Field label={t('registration.patientType', 'Patient Type')}>
            <select className="select reg-select" value={patientType} onChange={e => setPatientType(e.target.value)}>
              <option value="new">{t('registration.patientTypeOptions.new', 'New Patient')}</option>
              <option value="revisit">{t('registration.patientTypeOptions.revisit', 'Revisit')}</option>
              <option value="referral">{t('registration.patientTypeOptions.referral', 'Referral')}</option>
            </select>
          </Field>

          <Field label={t('registration.patientId', 'Patient ID')}>
            <input className="input" placeholder={t('registration.patientIdPlaceholder', 'auto-generated')} readOnly />
          </Field>

          <Field label={t('registration.abhaId', 'ABHA ID (optional)')}>
            <input className="input" placeholder={t('registration.abhaIdPlaceholder', '14-digit ABHA number')} value={abhaId}
              onChange={e => setAbhaId(e.target.value)} maxLength={14} />
          </Field>

          <Field label={t('registration.visitNo', 'Visit No.')}>
            <input className="input" placeholder={t('registration.visitNoPlaceholder', 'e.g. 1')} value={visitNo}
              onChange={e => setVisitNo(e.target.value)} />
          </Field>
        </div>

        <div className="reg-grid">
          <Field label={t('registration.titleField', 'Title')}>
            {/* Salutations kept as the standard Latin abbreviations across
                languages, same as printed Indian govt forms -- not translated. */}
            <select className="select reg-select" value={title} onChange={e => setTitle(e.target.value)}>
              {['Mr', 'Mrs', 'Ms', 'Dr', 'Prof'].map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </Field>

          <Field label={t('registration.firstName', 'First Name')} required>
            <input className="input" placeholder={t('registration.firstNamePlaceholder', 'e.g. Sunita')} value={firstName}
              onChange={e => setFirstName(e.target.value)} required />
          </Field>

          <Field label={t('registration.middleName', 'Middle Name')}>
            <input className="input" placeholder={t('registration.middleNamePlaceholder', 'Optional')} value={middleName}
              onChange={e => setMiddleName(e.target.value)} />
          </Field>

          <Field label={t('registration.lastName', 'Last Name')} required>
            <input className="input" placeholder={t('registration.lastNamePlaceholder', 'e.g. Devi')} value={lastName}
              onChange={e => setLastName(e.target.value)} required />
          </Field>
        </div>

        <div className="reg-grid">
          <Field label={t('registration.gender', 'Gender')} required>
            <select className="select reg-select" value={gender} onChange={e => setGender(e.target.value)} required>
              <option value="">{t('registration.genderOptions.select', 'Select')}</option>
              <option value="female">{t('registration.genderOptions.female', 'Female')}</option>
              <option value="male">{t('registration.genderOptions.male', 'Male')}</option>
              <option value="other">{t('registration.genderOptions.other', 'Other')}</option>
            </select>
          </Field>

          <Field label={t('registration.dob', 'Date of Birth')} required>
            <input className="input" type="date" max={new Date().toISOString().slice(0, 10)}
              value={ddmmyyyyToIso(dob)}
              onChange={e => setDob(isoToDdmmyyyy(e.target.value))} />
          </Field>

          <Field label={t('registration.ageField', 'Age')} required>
            <input className="input" type="number" placeholder={t('registration.ageFieldPlaceholder', 'e.g. 54')} value={age}
              onChange={e => setAge(e.target.value)} min="0" max="120" required />
          </Field>

          <Field label={t('registration.maritalStatus', 'Marital Status')}>
            <select className="select reg-select" value={maritalStatus} onChange={e => setMaritalStatus(e.target.value)}>
              <option value="">{t('registration.maritalStatusOptions.select', 'Select')}</option>
              <option value="single">{t('registration.maritalStatusOptions.single', 'Single')}</option>
              <option value="married">{t('registration.maritalStatusOptions.married', 'Married')}</option>
              <option value="widowed">{t('registration.maritalStatusOptions.widowed', 'Widowed')}</option>
              <option value="divorced">{t('registration.maritalStatusOptions.divorced', 'Divorced')}</option>
            </select>
          </Field>

          {/* Blood group letters (A+, O- ...) are a universal medical notation, not translated. */}
          <Field label={t('registration.bloodGroup', 'Blood Group')}>
            <select className="select reg-select" value={bloodGroup} onChange={e => setBloodGroup(e.target.value)}>
              {['Unknown','A+','A-','B+','B-','AB+','AB-','O+','O-'].map(bg => (
                <option key={bg} value={bg}>{bg === 'Unknown' ? t('common.unknown', 'Unknown') : bg}</option>
              ))}
            </select>
          </Field>
        </div>

        {/* ── 2. ADDRESS ───────────────────────────────────── */}
        <SectionHeader title={t('registration.sectionAddress', 'Address')} label="02" />

        <div className="reg-grid">
          <Field label={t('registration.addressField', 'Address')} required span={2}>
            <textarea className="input reg-textarea" placeholder={t('registration.addressPlaceholder', 'Full address')} value={address}
              onChange={e => setAddress(e.target.value)} required rows={3} />
          </Field>

          <Field label={t('registration.state', 'State')} required>
            {/* value stays the canonical English state name -- that's what's
                persisted; only the displayed option text is translated. */}
            <select className="select reg-select" value={state} onChange={e => setState(e.target.value)} required>
              <option value="">{t('registration.stateSelect', 'Select')}</option>
              {INDIAN_STATES.map(s => <option key={s} value={s}>{t(`registration.states.${s}`, s)}</option>)}
            </select>
          </Field>

          <Field label={t('registration.pincode', 'Pincode')}>
            <input className="input" placeholder={t('registration.pincodePlaceholder', '6-digit PIN')} value={pincode}
              onChange={e => setPincode(e.target.value)} maxLength={6} />
          </Field>
        </div>

        <div className="reg-grid">
          <Field label={t('registration.district', 'District')} required>
            <input className="input" placeholder={t('registration.districtPlaceholder', 'e.g. Pune')} value={district}
              onChange={e => setDistrict(e.target.value)} required />
          </Field>

          <Field label={t('registration.occupation', 'Occupation')}>
            <select className="select reg-select" value={occupation} onChange={e => setOccupation(e.target.value)}>
              <option value="">{t('registration.occupationOptions.select', 'Select')}</option>
              <option value="farmer">{t('registration.occupationOptions.farmer', 'Farmer')}</option>
              <option value="labourer">{t('registration.occupationOptions.labourer', 'Daily Labourer')}</option>
              <option value="homemaker">{t('registration.occupationOptions.homemaker', 'Homemaker')}</option>
              <option value="govt_employee">{t('registration.occupationOptions.govt_employee', 'Govt. Employee')}</option>
              <option value="business">{t('registration.occupationOptions.business', 'Business')}</option>
              <option value="student">{t('registration.occupationOptions.student', 'Student')}</option>
              <option value="other">{t('registration.occupationOptions.other', 'Other')}</option>
            </select>
          </Field>

          <Field label={t('registration.contactNumber', 'Contact Number')} required>
            <input className="input" type="tel" placeholder={t('registration.contactNumberPlaceholder', '+91...')} value={contactNumber}
              onChange={e => setContactNumber(e.target.value)} required
              title={t('registration.contactNumberTitle', 'Required — only channel for delayed/offline result delivery')} />
          </Field>

          <Field label={t('registration.altPhone', 'Alternate Phone')}>
            <input className="input" type="tel" placeholder={t('registration.altPhonePlaceholder', 'Optional')} value={altPhone}
              onChange={e => setAltPhone(e.target.value)} />
          </Field>
        </div>

        {/* ── 3. CLINICAL SYMPTOM & RISK QUESTIONNAIRE ─────── */}
        <SectionHeader title={t('questionnaire.sectionTitle', 'Clinical Symptom & Risk Questionnaire')} label="03" />

        <div className="reg-questionnaire-card">

          {/* Known Diabetic -- an explicit YES / NO, not a toggle that starts on an answer */}
          <div className="reg-q-row">
            <span className="meta-label">{t('questionnaire.knownDiabetic', 'Known Diabetic?')} <span className="reg-req">*</span></span>
            <div className="reg-chip-group">
              {[{ v: true, label: t('common.yes', 'Yes') }, { v: false, label: t('common.no', 'No') }].map((o) => (
                <button key={String(o.v)} type="button"
                  className={`reg-chip${knownDiabetic === o.v ? ' reg-chip--active' : ''}`}
                  onClick={() => setKnownDiabetic(o.v)}
                >{o.label}</button>
              ))}
            </div>
            {knownDiabetic === false && (
              <div className="t-mono" style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
                {t('registration.notDiabeticNote', 'The record has no "not diabetic" value for years since diagnosis; it will be stored as "< 1 yr".')}
              </div>
            )}
          </div>

          {/* Years Since Diagnosis (conditional) */}
          {knownDiabetic && (
            <div className="reg-q-row">
              <span className="meta-label">{t('questionnaire.yearsSince', 'Years Since Diagnosis')} <span className="reg-req">*</span></span>
              <div className="reg-chip-group">
                {[
                  { id: 'lt1',   label: t('questionnaire.yearsOptions.lt1', '< 1 yr') },
                  { id: '1to5',  label: t('questionnaire.yearsOptions.oneToFive', '1–5 yrs') },
                  { id: '5to10', label: t('questionnaire.yearsOptions.fiveToTen', '5–10 yrs') },
                  { id: 'gt10',  label: t('questionnaire.yearsOptions.gt10', '> 10 yrs') },
                ].map(opt => (
                  <button key={opt.id} type="button"
                    className={`reg-chip${yearsSinceDx === opt.id ? ' reg-chip--active' : ''}`}
                    onClick={() => setYearsSinceDx(opt.id)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* Glycemic Control */}
          <div className="reg-q-row">
            <span className="meta-label">{t('questionnaire.glycemicControl', 'Glycemic Control (Blood Sugar)')} <span className="reg-req">*</span></span>
            <div className="reg-chip-group">
              {[
                { id: 'good',     label: t('questionnaire.glycemicOptions.good', 'Good') },
                { id: 'moderate', label: t('questionnaire.glycemicOptions.moderate', 'Moderate') },
                { id: 'poor',     label: t('questionnaire.glycemicOptions.poor', 'Poor') },
              ].map(opt => (
                <button key={opt.id} type="button"
                  className={`reg-chip${glycemicControl === opt.id ? ' reg-chip--active' : ''}`}
                  onClick={() => setGlycemicControl(opt.id)}
                >{opt.label}</button>
              ))}
            </div>
          </div>

          {/* Blood Pressure */}
          <div className="reg-q-row">
            <span className="meta-label">{t('questionnaire.bpHistory', 'Blood Pressure Status')} <span className="reg-req">*</span></span>
            <select className="select meta-select"
              value={bloodPressure}
              onChange={e => setBloodPressure(e.target.value)}>
              <option value="" disabled>{t('questionnaire.selectPlaceholder', 'Select…')}</option>
              {BLOOD_PRESSURE_IDS.map(id => (
                <option key={id} value={id}>{t(`questionnaire.bpOptions.${id}`, BLOOD_PRESSURE_LABELS[id])}</option>
              ))}
            </select>
          </div>

          {/* Pregnancy */}
          {couldBePregnant && (
            <div className="reg-q-row">
              <span className="meta-label">{t('questionnaire.pregnancy', 'Currently Pregnant?')} <span className="reg-req">*</span></span>
              <div className="reg-chip-group">
                {[
                  { id: 'yes',            label: t('common.yes', 'Yes') },
                  { id: 'no',             label: t('common.no', 'No') },
                  { id: 'not_applicable', label: t('common.notApplicable', 'N / A') },
                ].map(opt => (
                  <button key={opt.id} type="button"
                    className={`reg-chip${pregnancy === opt.id ? ' reg-chip--active' : ''}`}
                    onClick={() => setPregnancy(opt.id)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* Eye Symptoms */}
          <div className="reg-q-row">
            <span className="meta-label">{t('questionnaire.eyeSymptoms', 'Current Eye Symptoms (select all that apply)')} <span className="reg-req">*</span></span>
            <div className="reg-chip-group reg-chip-group--grid">
              {EYE_SYMPTOM_IDS.map(id => (
                <button key={id} type="button"
                  className={`reg-chip${eyeSymptoms[id] ? ' reg-chip--active' : ''}`}
                  onClick={() => toggleSymptom(id)}
                >
                  {eyeSymptoms[id] && <span className="reg-chip__check">✓ </span>}
                  {t(`questionnaire.symptoms.${id}`)}
                </button>
              ))}
              <button type="button"
                className={`reg-chip${noSymptoms ? ' reg-chip--active' : ''}`}
                onClick={chooseNoSymptoms}
              >
                {noSymptoms && <span className="reg-chip__check">✓ </span>}
                {t('questionnaire.symptoms.none', 'None of these')}
              </button>
            </div>
          </div>
        </div>

        {/* ── 4. INFORMED VERBAL CONSENT ──────────────────── */}
        <div className="reg-consent-block">
          <label className="reg-consent-label">
            <input
              type="checkbox"
              className="reg-consent-checkbox"
              checked={consentObtained}
              onChange={handleConsentChange}
              required
            />
            <div className="reg-consent-text">
              <span className="reg-consent-title">{t('registration.consent.title', 'Informed Verbal Consent (DPDP Act Sec 9.7)')}</span>
              <span className="reg-consent-body">
                {t('registration.consent.body', 'I confirm that informed verbal consent has been obtained from the patient for retinal image capture, clinical risk assessment, and tele-ophthalmology review.')}
              </span>
            </div>
          </label>
        </div>

        {/* ── 5. FOOTER ACTIONS ───────────────────────────── */}
        {!USE_MOCK_DATA && questionnaireMissing.length > 0 && (
          <div className="t-mono" data-testid="questionnaire-missing"
            style={{ fontSize: 12, color: 'var(--c-crimson, #C42B2B)', margin: '8px 0' }}>
            {t('registration.missingPrefix', 'Still to answer before capture: ')}{questionnaireMissing.join(' · ')}
          </div>
        )}
        {/* ── POSSIBLE DUPLICATE ────────────────────────────────────────
            Advisory, never blocking. The worker is in front of the patient
            and knows things this check cannot -- two sisters at one address
            share a surname and a phone. So it shows what matched and lets
            them decide, rather than refusing the registration.

            matchedOn is shown because WHICH field matched is the whole
            signal: a shared name is weak evidence, a shared phone number is
            strong, and collapsing them into one score would hide that. */}
        {dupeChecked && dupes.length > 0 && (
          <div
            className="meta-card"
            data-testid="duplicate-warning"
            style={{ borderLeft: '3px solid var(--c-amber, #d29922)' }}
          >
            <div className="meta-card__header">
              <h3 className="meta-card__title">
                {t('registration.duplicate.heading', 'Possible duplicate — {{count}} existing patient', { count: dupes.length })}
              </h3>
            </div>
            <div className="meta-card__body">
              <p style={{ fontSize: '12px', opacity: 0.75, marginTop: 0 }}>
                {t('registration.duplicate.body', 'Someone matching these details is already registered. Registering again creates a second record with a separate screening history. Check before continuing — you can still register if this is a different person.')}
              </p>
              {dupes.slice(0, 5).map((d) => (
                <div
                  key={d.patientId}
                  className="u-flex u-items-center u-gap-2"
                  style={{ padding: '6px 0', borderTop: 'var(--border)' }}
                >
                  <span style={{ fontWeight: 700 }}>{d.name}</span>
                  <span className="t-mono" style={{ fontSize: '11px', opacity: 0.7 }}>
                    {d.patientReference || d.patientId}
                  </span>
                  {d.age != null && (
                    <span style={{ fontSize: '11px', opacity: 0.7 }}>{t('registration.duplicate.age', 'age {{age}}', { age: d.age })}</span>
                  )}
                  {Array.isArray(d.matchedOn) && d.matchedOn.length > 0 && (
                    <span className="badge badge--neutral" style={{ fontSize: '10px' }}>
                      {/* matchedOn is one of a fixed 3-value backend enum
                          (routes/patients.js: 'name'/'phone'/'age') -- map
                          each to a translated word rather than showing the
                          raw English field identifier. */}
                      {t('registration.duplicate.matchedOn', 'matched on {{fields}}', {
                        fields: d.matchedOn.map((f) => t(`registration.duplicate.matchField.${f}`, f)).join(' + '),
                      })}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    style={{ marginLeft: 'auto', fontSize: '11px', padding: '4px 10px' }}
                    disabled={usingExistingId === d.patientId}
                    onClick={() => handleUseExisting(d)}
                    data-testid="use-existing-patient"
                  >
                    {usingExistingId === d.patientId ? t('registration.duplicate.opening', 'Opening…') : t('registration.duplicate.useThisPatient', 'Use this patient →')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {submitError && <LoadError error={submitError} title={t('registration.submitErrorTitle', 'PATIENT NOT REGISTERED')} compact />}
        <div className="reg-footer">
          <button type="button" className="btn btn--outline" onClick={handleClearAll}>
            <span>{t('registration.btnClearAll', 'CLEAR ALL')}</span>
          </button>
          <button
            type="submit"
            className="btn btn--lg"
            disabled={loading || !consentObtained || !firstName || !contactNumber
              || (!USE_MOCK_DATA && questionnaireMissing.length > 0)}
            title={!USE_MOCK_DATA && questionnaireMissing.length
              ? t('registration.missingPrefix', 'Still to answer before capture: ') + questionnaireMissing.join(', ') : undefined}
          >
            <span>{loading ? t('registration.btnRegistering', 'REGISTERING...') : t('registration.btnInitiate', 'INITIATE CAPTURE →')}</span>
          </button>
        </div>

      </form>
    </div>
  );
};
