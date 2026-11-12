-- Supplier claims, commit 4 (SPEC §26 "Carrier status — EasyPost", claims patch §3.9 / §4.7): carrier status per
-- tracking row. EasyPost tracks the number (POST /trackers, tracker.updated webhooks, a daily re-read of silent
-- trackers); AF stores what it says. `po_tracking.status` stays AF's workflow (unmatched / matched / pushed …).
--   carrier_status            EasyPost's tracker status (pre_transit, in_transit, out_for_delivery, delivered,
--                             available_for_pickup, return_to_sender, failure, cancelled, error, unknown)
--   est_delivery_at           est_delivery_date
--   last_scan_at              the latest tracking_details datetime
--   delivered_at              the delivery scan's datetime once status = delivered (never cleared)
--   carrier_checked_at        when AF last heard from EasyPost about this row (POST, webhook or sweep)
--   easypost_tracker_id       trk_…; the same number on several rows (split rows, two POs) shares one tracker
--   easypost_registered_at    when AF created the tracker — the sweep stops 60 days after it (Maria 2026-11-12)
--   velocity_tracking_status  Velocity's per-tracking tracking_status, recorded by the push pass — the fallback the
--                             readers show when EasyPost has nothing (GLS and other carriers it cannot track)
ALTER TABLE po_tracking
  ADD COLUMN carrier_status text,
  ADD COLUMN est_delivery_at timestamptz,
  ADD COLUMN last_scan_at timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN carrier_checked_at timestamptz,
  ADD COLUMN easypost_tracker_id text,
  ADD COLUMN easypost_registered_at timestamptz,
  ADD COLUMN velocity_tracking_status text;
CREATE INDEX po_tracking_easypost_tracker_idx ON po_tracking (easypost_tracker_id) WHERE easypost_tracker_id IS NOT NULL;
-- The registration / sweep candidates: real numbers not yet delivered.
CREATE INDEX po_tracking_carrier_open_idx ON po_tracking (carrier_checked_at) WHERE delivered_at IS NULL AND tracking_number NOT LIKE 'email:%';
