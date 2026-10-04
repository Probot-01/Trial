

INSERT INTO model_versions
  (version_id, trained_at, validation_sensitivity, validation_specificity,
   validation_kappa, promoted, promoted_at)
VALUES
  ('branchA_v2a', '2026-09-21T02:16:00Z', 0.900735, 0.938202, 0.873440, false, NULL),
  ('branchA_v2b', '2026-09-22T21:22:00Z', 0.849265, 0.946629, 0.884888, false, NULL),
  ('branchA_v2c', '2026-09-21T19:38:00Z', 0.926471, 0.924157, 0.883875, true,
   '2026-09-23T00:00:00Z')
ON CONFLICT (version_id) DO NOTHING;

-- Down Migration
DELETE FROM model_versions
 WHERE version_id IN ('branchA_v2a', 'branchA_v2b', 'branchA_v2c');
