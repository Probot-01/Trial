'use strict';



const express = require('express');
const pool = require('../db/pgClient');
const cfg = require('../services/authConfig');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { logAccess } = require('../services/accessLog');
const urgencyInputs = require('../services/urgencyInputs');

const router = express.Router();

router.get('/queue', requireAuth, requireRole('ophthalmologist'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      WITH ranked AS (
        SELECT
          c.case_id,
          p.patient_reference,
          site.name AS phc_name,
          c.captured_at,
          COALESCE(c.eye_laterality_detected, c.eye_laterality_reported) AS eye_laterality,
          g.claimed_by,
          g.claimed_at,
          u.name AS claimed_by_name,
          g.dr_grade_cnn,
          g.dr_grade_rule_engine,
          g.branch_agreement,
          g.confidence_score,
          g.conformal_tier,
          g.urgency_score,
          g.urgency_factor,
          -- Only the provenance sub-object is wanted here, not the whole
          -- urgency_inputs blob: it repeats a model card on every row and the
          -- queue shows none of it. Extracted in SQL so the payload does not
          -- carry what it will not use.
          g.urgency_inputs -> 'provenance' AS urgency_input_provenance,
          ROW_NUMBER() OVER (
            PARTITION BY g.conformal_tier
            ORDER BY
              -- Tier C: (1 - confidence) for EVERY case, never COALESCEd with
              -- uncertainty_score. This used to be
              -- COALESCE(uncertainty_score, 1 - confidence_score), on the
              -- stated reasoning that uncertainty "is NULL until Phase 6
              -- ships" so the substitute gives the "same ordering, different
              -- scale".
              --
              -- That held while EVERY row was NULL. Phase 6 now computes
              -- uncertainty on the MATLAB path, so the column is populated for
              -- some cases and not others, and the COALESCE compared the two
              -- against each other. They are not interchangeable: measured on
              -- this database, one identical case reads 0.3678 as normalised
              -- predictive entropy and 0.1827 as (1 - confidence) -- roughly
              -- double. The 120 cases without a score span 0.0000-0.7118 on
              -- the substitute, so a freshly graded case outranked most of
              -- them for having been graded recently, which is not a clinical
              -- fact about the patient.
              --
              -- One scale for the whole tier is the correct answer while the
              -- column is partly populated. Once every case has a real
              -- uncertainty_score this orders on it DIRECTLY -- not on a
              -- COALESCE, which is what caused this.
              CASE WHEN g.conformal_tier = 'C'
                   THEN (1 - g.confidence_score)
              END DESC NULLS LAST,
              CASE WHEN g.conformal_tier = 'B'
                   THEN g.confidence_score
              END ASC NULLS LAST,
              -- Triage urgency: a TIE-BREAK, deliberately placed AFTER the
              -- calibrated keys above and never instead of them. The score
              -- comes from a forest trained on SYNTHETIC data
              -- (calculateUrgencyScore.m), while uncertainty and confidence
              -- are calibrated on the model's own measured error. Letting the
              -- synthetic signal outrank the calibrated one would be a real
              -- downgrade dressed as a feature. Here it only separates cases
              -- the calibrated keys cannot, which is what a hint should do.
              -- NULLS LAST: "not computed" must not sort as urgent.
              g.urgency_score DESC NULLS LAST,
              c.case_id                              -- deterministic tie-break
          ) AS tier_rank
        FROM cases c
        JOIN      patients        p    ON p.patient_id = c.patient_id
        JOIN      grading_results g    ON g.case_id    = c.case_id
        LEFT JOIN phc_sites       site ON site.phc_id  = c.phc_id
        LEFT JOIN users           u    ON u.user_id    = g.claimed_by
        -- <> 'A' would also drop NULL tiers, but saying so explicitly documents
        -- that an ungraded case has no tier and belongs in neither bucket.
        WHERE g.conformal_tier IS NOT NULL AND g.conformal_tier <> 'A'
          -- A case that has been reviewed is DONE and must leave the queue.
          -- Without this it stayed forever: the queue grew without bound and a
          -- reviewer could not tell outstanding work from finished work. Review
          -- history stays available at GET /cases/:caseId/reviews.
          AND NOT EXISTS (
            SELECT 1 FROM ophthalmologist_reviews r WHERE r.case_id = c.case_id)
      ),
      c_count AS (SELECT COUNT(*) AS n FROM ranked WHERE conformal_tier = 'C')
      SELECT ranked.*,
             claimed_at > now() - make_interval(mins => $1) AS claim_live,
             CASE
               WHEN conformal_tier = 'C' THEN tier_rank
               -- Tier B starts at 101 per the contract. GREATEST guards the
               -- case of more than 100 Tier C rows: without it, B would start
               -- at 101 while C had already reached 150, and the ranks would
               -- interleave -- putting a Tier B case above a Tier C one, which
               -- inverts the entire safety ordering.
               ELSE GREATEST(100, (SELECT n FROM c_count)) + tier_rank
             END AS priority_rank
      FROM ranked
      ORDER BY priority_rank ASC
    `, [cfg.CLAIM_TTL_MINUTES]);

    await logAccess(req.user?.userId, 'view_queue', 'review_queue');

    res.json(rows.map((r) => ({
      caseId: r.case_id,
      patientReference: r.patient_reference ?? null,
      phcName: r.phc_name ?? null,
      capturedAt: r.captured_at ? r.captured_at.toISOString() : null,

      eyeLaterality: r.eye_laterality ?? null,

      urgencyScore: Number.isFinite(r.urgency_score) ? r.urgency_score : null,
      urgencyTopFactor: r.urgency_factor ?? null,
      urgencyBasis: r.urgency_score == null ? null : 'synthetic-model',

      urgencyAssumedInputs: urgencyInputs.assumedInputs(
        r.urgency_input_provenance ? { provenance: r.urgency_input_provenance } : null),
      urgencyLimitation: r.urgency_score == null ? null
        : 'Trained on synthetic data, never validated against patient outcomes. '
        + 'Queue ordering hint only -- not a clinical assessment.',
      claimedBy: r.claim_live
        ? { userId: r.claimed_by, name: r.claimed_by_name ?? null }
        : null,
      claimedAt: r.claim_live ? r.claimed_at.toISOString() : null,
      drGradeCnn: r.dr_grade_cnn ?? null,

      drGradeRuleEngine: r.dr_grade_rule_engine ?? null,
      branchAgreement: r.branch_agreement ?? null,
      confidenceScore: r.confidence_score ?? null,
      conformalTier: r.conformal_tier,
      priorityRank: Number(r.priority_rank),
    })));
  } catch (err) { next(err); }
});

module.exports = router;
