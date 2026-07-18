-- 019: Tag cleanup + Seasonal tag group.
-- (Requested as "017" but 017/018 are taken — this is 019.)
--
-- Schema: tags gain tag_group (NULL = ungrouped) + sort_order (order within a
-- group). Data: delete 6 retired tags (asin_tags rows cascade — 196 associations,
-- accepted); merge/rename the seasonal tags; assign the 'Seasonal' group in
-- display order. Ungrouped tags keep tag_group NULL.

-- 1. Schema ------------------------------------------------------------------
ALTER TABLE tags ADD COLUMN IF NOT EXISTS tag_group VARCHAR(50);  -- NULL = ungrouped
ALTER TABLE tags ADD COLUMN IF NOT EXISTS sort_order INTEGER;     -- order within a group

-- 2a. Delete the 6 retired tags (cascade drops their asin_tags rows).
DELETE FROM tags WHERE name IN (
  'Coffee K-Cups',      -- 7 uses
  'Need a Giftcard',    -- 1
  'Not profitable',     -- 93
  'Pickup',             -- 4
  'Tanked below BE',    -- 6
  'Tracking in Keepa'   -- 85
);

-- 2b. Valentine merge: 'St. Valentine''s' (id 08586877) has 0 uses — delete it;
--     rename the EXISTING 'Valentine''s Day' (id cfcf70d6, 2 uses) in place so its
--     2 associations are preserved (avoids the tags_name_key collision).
DELETE FROM tags WHERE name = 'St. Valentine''s';
UPDATE tags SET name = 'St. Valentine''s Day' WHERE name = 'Valentine''s Day';

-- 2c. Capitalization renames (same rows/ids; associations preserved).
UPDATE tags SET name = 'St. Patrick''s Day' WHERE name = 'St. Patrick''s day';  -- id 471e4b66
UPDATE tags SET name = 'Back to School'     WHERE name = 'Back to school';      -- id 8e54af66

-- 2d. Seasonal group + sort_order (exact display order).
UPDATE tags SET tag_group = 'Seasonal', sort_order = 1 WHERE name = 'Fall/Q4';
UPDATE tags SET tag_group = 'Seasonal', sort_order = 2 WHERE name = 'St. Valentine''s Day';
UPDATE tags SET tag_group = 'Seasonal', sort_order = 3 WHERE name = 'St. Patrick''s Day';
UPDATE tags SET tag_group = 'Seasonal', sort_order = 4 WHERE name = 'Spring';
UPDATE tags SET tag_group = 'Seasonal', sort_order = 5 WHERE name = 'Easter';
UPDATE tags SET tag_group = 'Seasonal', sort_order = 6 WHERE name = 'Summer';
UPDATE tags SET tag_group = 'Seasonal', sort_order = 7 WHERE name = 'Back to School';
