
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (status IN ('referred', 'manual_follow_up', 'contacted', 'attended', 'lost'));

-- Down Migration
UPDATE referrals SET status = 'referred' WHERE status = 'manual_follow_up';
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (status IN ('referred', 'contacted', 'attended', 'lost'));
