
ALTER TABLE ophthalmologist_reviews
  ADD COLUMN IF NOT EXISTS corrected_grade INTEGER
  CHECK (corrected_grade BETWEEN 0 AND 4);

-- Down Migration
ALTER TABLE ophthalmologist_reviews DROP COLUMN IF EXISTS corrected_grade;
