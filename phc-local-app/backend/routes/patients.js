'use strict';


const express = require('express');

const db = require('../db/localDb');
const { generateLocalId } = require('../services/ids');

const router = express.Router();


function toPatientResponse(row) {
  return {
    patientId: row.patient_id,
    name: row.name,
    age: row.age,
    contactNumber: row.contact_number,
    registeredAt: row.registered_at,
    consentGivenAt: row.consent_given_at ?? null,
  };
}

// ── POST /patients ───────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, age, contactNumber, consentGivenAt } = req.body || {};


  if (!contactNumber) {
    return res.status(400).json({
      error: 'contact_number_required',
      message: 'contactNumber is required — it is the only channel for delayed results.',
    });
  }
  if (!name) {
    return res.status(400).json({
      error: 'name_required',
      message: 'name is required.',
    });
  }

  const parsedAge = Number(age);
  if (!Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 130) {
    return res.status(400).json({
      error: 'invalid_age',
      message: 'age must be an integer between 0 and 130.',
    });
  }

  let consent = null;
  if (consentGivenAt !== undefined && consentGivenAt !== null && consentGivenAt !== '') {
    const t = new Date(consentGivenAt);
    if (Number.isNaN(t.getTime())) {
      return res.status(400).json({
        error: 'invalid_field', message: 'consentGivenAt must be an ISO-8601 timestamp.',
      });
    }
    consent = t.toISOString();
  }

  const row = {
    patient_id: generateLocalId(),
    name: String(name),
    age: parsedAge,
    contact_number: String(contactNumber),
    registered_at: new Date().toISOString(),
    consent_given_at: consent,
  };

  db.prepare(`
    INSERT INTO patients (patient_id, name, age, contact_number, registered_at, consent_given_at)
    VALUES (@patient_id, @name, @age, @contact_number, @registered_at, @consent_given_at)
  `).run(row);

  res.status(201).json(toPatientResponse(row));
});


router.get('/search', (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
  const phone = typeof req.query.phone === 'string' ? req.query.phone.replace(/\D/g, '') : '';
  const ageRaw = req.query.age;
  const age = ageRaw === undefined || ageRaw === '' ? null : Number(ageRaw);

  if (!name && !phone) {
    return res.status(400).json({
      error: 'invalid_field', message: 'Give at least a name or a phone number to search on.',
    });
  }
  if (age !== null && !(Number.isInteger(age) && age >= 0 && age <= 130)) {
    return res.status(400).json({ error: 'invalid_field', message: 'age must be an integer 0-130.' });
  }
  if (phone && phone.length < 4) {
    return res.status(400).json({
      error: 'invalid_field', message: 'phone needs at least 4 digits to search on.',
    });
  }

  const words = name.split(/\s+/).filter((w) => w.length >= 3);
  const phone10 = phone.slice(-10);
  const digits = (s) => String(s || '').replace(/\D/g, '');

  // One PHC's register is small enough to score in JS, which keeps the
  // matching rules readable and identical to central's without SQLite regex.
  const results = db.prepare('SELECT * FROM patients').all()
    .map((r) => {
      const n = r.name.toLowerCase();
      const nameFull = !!name && n.includes(name);
      const nameWord = !nameFull && words.some((w) => n.includes(w));
      const phoneHit = !!phone10 && digits(r.contact_number).endsWith(phone10);
      const ageHit = age !== null && Math.abs(r.age - age) <= 1;
      const matchedOn = [];
      if (nameFull || nameWord) matchedOn.push('name');
      if (phoneHit) matchedOn.push('phone');
      if (ageHit) matchedOn.push('age');
      return {
        row: r, matchedOn,
        score: (nameFull ? 3 : nameWord ? 2 : 0) + (phoneHit ? 3 : 0) + (ageHit ? 1 : 0),
        candidate: nameFull || nameWord || phoneHit,
      };
    })
    .filter((x) => x.candidate)
    .sort((a, b) => b.score - a.score
      || String(b.row.registered_at).localeCompare(String(a.row.registered_at)))
    .slice(0, 20);

  res.json(results.map(({ row, matchedOn, score }) => ({
    ...toPatientResponse(row), matchedOn, score,
  })));
});

// ── GET /patients/:patientId ─────────────────────────────────────────────────
router.get('/:patientId', (req, res) => {
  const row = db
    .prepare('SELECT * FROM patients WHERE patient_id = ?')
    .get(req.params.patientId);

  if (!row) {
    return res.status(404).json({
      error: 'patient_not_found',
      message: `No patient with id ${req.params.patientId}`,
    });
  }

  res.json(toPatientResponse(row));
});


router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM patients ORDER BY registered_at DESC LIMIT 200')
    .all();
  res.json(rows.map(toPatientResponse));
});

module.exports = router;
