

const KEY = 'netra_patient_questionnaires';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export function saveQuestionnaire(patientId, questionnaire) {
  try {
    const all = readAll();
    all[patientId] = questionnaire;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage blocked: the capture screen will then ask for the answers again */ }
}

/** The stored answers for THIS patient, or null. Never another patient's. */
export function loadQuestionnaire(patientId) {
  const q = readAll()[patientId];
  return q && typeof q === 'object' ? q : null;
}
