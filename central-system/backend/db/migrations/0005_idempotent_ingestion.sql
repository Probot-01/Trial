
WITH ranked AS (
  SELECT case_id, capture_id_ref,
         ROW_NUMBER() OVER (PARTITION BY capture_id_ref
                            ORDER BY received_at DESC, case_id) AS rn
  FROM cases
  WHERE capture_id_ref IS NOT NULL
)
UPDATE cases c
SET capture_id_ref = r.capture_id_ref || '~dup-' || (r.rn - 1)
FROM ranked r
WHERE c.case_id = r.case_id AND r.rn > 1;

ALTER TABLE cases ADD CONSTRAINT cases_capture_id_ref_unique UNIQUE (capture_id_ref);

ALTER TABLE cases ALTER COLUMN image_path DROP NOT NULL;
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_status_check
  CHECK (status IN ('awaiting_image', 'processing', 'graded', 'error'));
ALTER TABLE cases ADD CONSTRAINT cases_image_required_unless_awaiting
  CHECK (status = 'awaiting_image' OR image_path IS NOT NULL);


ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_image_required_unless_awaiting;
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_status_check
  CHECK (status IN ('processing', 'graded', 'error'));
ALTER TABLE cases ALTER COLUMN image_path SET NOT NULL;
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_capture_id_ref_unique;
