import { getDb, nowIso } from './database';
import { Demographics, Patient, PatientQuestionnaire } from '../types';
import { generateLocalId } from '../lib/ids';
import { scoreMatch, normalizePhone, normalizeName } from '../lib/fuzzy';

interface PatientRow {
  patient_id: string;
  name: string;
  age: number;
  contact_number: string;
  consent_given_at: string | null;
  duplicate_of: string | null;
  registered_at: string;
  demographics_json: string | null;
  questionnaire_json: string | null;
}

function fromRow(r: PatientRow): Patient {
  return {
    patientId: r.patient_id,
    name: r.name,
    age: r.age,
    contactNumber: r.contact_number,
    consentGivenAt: r.consent_given_at,
    duplicateOf: r.duplicate_of,
    registeredAt: r.registered_at,
    demographics: r.demographics_json ? JSON.parse(r.demographics_json) : null,
    questionnaire: r.questionnaire_json ? JSON.parse(r.questionnaire_json) : null,
  };
}

export interface NewPatient {
  name: string;
  age: number;
  contactNumber: string;
  consentGivenAt: string;
  demographics: Demographics;
  questionnaire: PatientQuestionnaire;
}

/** Registers a patient with a collision-safe local ID (design doc §10.6). */
export async function createPatient(p: NewPatient): Promise<Patient> {
  const db = await getDb();
  const patient: Patient = {
    patientId: generateLocalId(),
    name: p.name,
    age: p.age,
    contactNumber: p.contactNumber,
    consentGivenAt: p.consentGivenAt,
    duplicateOf: null,
    registeredAt: nowIso(),
    demographics: p.demographics,
    questionnaire: p.questionnaire,
  };
  await db.runAsync(
    `INSERT INTO patients (patient_id, name, age, contact_number, consent_given_at, duplicate_of,
                           registered_at, demographics_json, questionnaire_json, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [patient.patientId, patient.name, patient.age, patient.contactNumber, patient.consentGivenAt,
    patient.registeredAt, JSON.stringify(p.demographics), JSON.stringify(p.questionnaire), patient.registeredAt]);
  return patient;
}


export async function updatePatientVisit(patientId: string, q: PatientQuestionnaire, consentGivenAt: string, contactNumber: string): Promise<Patient> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE patients
     SET questionnaire_json = ?, consent_given_at = COALESCE(consent_given_at, ?), contact_number = ?, updated_at = ?
     WHERE patient_id = ?`,
    [JSON.stringify(q), consentGivenAt, contactNumber, nowIso(), patientId]);
  const p = await getPatient(patientId);
  if (!p) throw new Error(`Patient ${patientId} disappeared`);
  return p;
}

export async function getPatient(patientId: string): Promise<Patient | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<PatientRow>('SELECT * FROM patients WHERE patient_id = ?', [patientId]);
  return r ? fromRow(r) : null;
}

export interface PatientMatch { patient: Patient; score: number; matchedOn: string[] }


export async function findPossibleDuplicates(name: string, age: number | null, phone: string): Promise<PatientMatch[]> {
  const db = await getDb();
  const phoneTail = normalizePhone(phone).slice(-6);
  const firstToken = normalizeName(name).split(' ')[0] ?? '';
  if (!phoneTail && firstToken.length < 2) return [];
  const rows = await db.getAllAsync<PatientRow>(
    `SELECT * FROM patients
     WHERE (? <> '' AND replace(replace(contact_number, ' ', ''), '-', '') LIKE ?)
        OR (? <> '' AND lower(name) LIKE ?)
     ORDER BY registered_at DESC
     LIMIT 200`,
    [phoneTail, `%${phoneTail}`, firstToken, `%${firstToken.slice(0, 3)}%`]);
  return rows
    .map(fromRow)
    .map((patient) => ({ patient, ...scoreMatch({ name, age, phone }, patient) }))
    .filter((m) => m.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/** Free-text lookup for the "find existing patient" field. */
export async function searchPatients(query: string): Promise<Patient[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const db = await getDb();
  const digits = q.replace(/\D/g, '');
  const rows = await db.getAllAsync<PatientRow>(
    `SELECT * FROM patients
     WHERE lower(name) LIKE ? OR patient_id LIKE ? OR (? <> '' AND contact_number LIKE ?)
     ORDER BY registered_at DESC LIMIT 20`,
    [`%${q.toLowerCase()}%`, `%${q}%`, digits, `%${digits}%`]);
  return rows.map(fromRow);
}
