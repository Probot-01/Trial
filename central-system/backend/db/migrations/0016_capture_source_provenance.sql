

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS source_format      TEXT,
  ADD COLUMN IF NOT EXISTS dicom_device_model TEXT;

COMMENT ON COLUMN cases.source_format IS
  'Container the capture arrived in, as readFundusImage saw it: jpg, png, dicom, ... NULL for rows graded before migration 0016.';

COMMENT ON COLUMN cases.dicom_device_model IS
  'Device model named by the DICOM file itself (evidence), as opposed to cases.camera_device_id which is the worker''s dropdown selection. NULL when the capture is not DICOM or carries no device tag.';

-- Down Migration
ALTER TABLE cases
  DROP COLUMN IF EXISTS source_format,
  DROP COLUMN IF EXISTS dicom_device_model;
