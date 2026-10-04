'use strict';



const express = require('express');
const pool = require('../db/pgClient');
const { requirePhcApiKey } = require('../middleware/requirePhcApiKey');

const router = express.Router();

const MAX_RESULTS = 20;

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 4 ? `******${d.slice(-4)}` : null;
}

router.get('/search', requirePhcApiKey, async (req, res, next) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
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


  const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const words = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).map(likeEscape);
  const phone10 = phone.slice(-10);

  try {
    const { rows } = await pool.query(`
      WITH scored AS (
        SELECT p.patient_id, p.patient_reference, p.name, p.age, p.contact_number,
               p.registered_at,
               ($1 <> '' AND lower(p.name) LIKE '%' || $1 || '%')              AS name_full,
               (cardinality($2::text[]) > 0 AND EXISTS (
                  SELECT 1 FROM unnest($2::text[]) w
                  WHERE lower(p.name) LIKE '%' || w || '%'))                  AS name_word,
               ($3 <> '' AND right(regexp_replace(p.contact_number, '\\D', '', 'g'),
                                   length($3)) = $3)                           AS phone_hit,
               ($4::int IS NOT NULL AND abs(p.age - $4::int) <= 1)             AS age_hit
        FROM patients p
      )
      SELECT * FROM scored
      WHERE name_full OR name_word OR phone_hit
      ORDER BY (CASE WHEN name_full THEN 3 WHEN name_word THEN 2 ELSE 0 END
              + CASE WHEN phone_hit THEN 3 ELSE 0 END
              + CASE WHEN age_hit   THEN 1 ELSE 0 END) DESC,
               registered_at DESC
      LIMIT ${MAX_RESULTS}
    `, [likeEscape(name.toLowerCase()), words, phone10, age]);

    res.json(rows.map((r) => {
      const matchedOn = [];
      if (r.name_full || r.name_word) matchedOn.push('name');
      if (r.phone_hit) matchedOn.push('phone');
      if (r.age_hit) matchedOn.push('age');
      return {
        patientId: r.patient_id,
        patientReference: r.patient_reference ?? null,
        name: r.name,
        age: r.age,
        contactNumberMasked: maskPhone(r.contact_number),
        registeredAt: r.registered_at.toISOString(),
        matchedOn,
        score: (r.name_full ? 3 : r.name_word ? 2 : 0) + (r.phone_hit ? 3 : 0) + (r.age_hit ? 1 : 0),
      };
    }));
  } catch (err) { next(err); }
});

module.exports = router;
