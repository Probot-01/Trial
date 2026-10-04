
CREATE TABLE IF NOT EXISTS dataset_labels (
  label_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  review_id         UUID NOT NULL REFERENCES ophthalmologist_reviews(review_id) ON DELETE CASCADE,

  -- The label itself: what a human says this image is.
  label_grade       INTEGER NOT NULL CHECK (label_grade BETWEEN 0 AND 4),
  -- 'confirm' -> the reviewer accepted model_grade; 'override' -> they replaced it.
  label_source      TEXT NOT NULL CHECK (label_source IN ('confirm', 'override')),

  -- Snapshots, per the note above.
  model_grade       INTEGER CHECK (model_grade BETWEEN 0 AND 4),
  conformal_tier    TEXT,
  image_path        TEXT,
  image_sha256      TEXT,
  eye_laterality    TEXT,
  consent_given_at  TIMESTAMPTZ,

  reviewer_id       TEXT,
  labelled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Set when this label is exported, so a corpus handed to a training run can
  -- be reproduced later. NULL means "not yet used".
  exported_at       TIMESTAMPTZ,
  export_batch      TEXT,

  -- One label per review. A retry of the same review must not double-count a
  -- training example.
  UNIQUE (review_id)
);

CREATE INDEX IF NOT EXISTS dataset_labels_case_idx   ON dataset_labels (case_id, labelled_at DESC);
CREATE INDEX IF NOT EXISTS dataset_labels_export_idx ON dataset_labels (exported_at);
CREATE INDEX IF NOT EXISTS dataset_labels_sha_idx    ON dataset_labels (image_sha256);

-- Down Migration
DROP INDEX IF EXISTS dataset_labels_sha_idx;
DROP INDEX IF EXISTS dataset_labels_export_idx;
DROP INDEX IF EXISTS dataset_labels_case_idx;
DROP TABLE IF EXISTS dataset_labels;
