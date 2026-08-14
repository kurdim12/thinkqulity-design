-- ThinkQuality Studio — seed the singleton brand row.
-- ONLY verified facts go in here. Palette, typography, pillars and voice
-- examples stay empty until real assets and a real export land.
-- Run after 0001_init.sql. Safe to re-run (idempotent on id = 1).

insert into brand (id, facts, voice_examples, palette, typography, audience_notes, status)
values (
  1,
  '[
    {"key":"person","label_en":"Person","label_ar":"الشخص","value":"Ahmad Kahtan","source":"seed-2026-06"},
    {"key":"positioning","label_en":"Positioning line","label_ar":"سطر التموضع","value":"باحث · كاتب · مدرّب في السلوك الإنساني","source":"seed-2026-06"},
    {"key":"personal_ig","label_en":"Personal Instagram","label_ar":"إنستغرام الشخصي","value":"@ahmadkahtan_","source":"seed-2026-06"},
    {"key":"personal_followers","label_en":"Personal followers","label_ar":"متابعو الحساب الشخصي","value":"~84.5K (verified account, as of the 2026-06 scrape)","source":"seed-2026-06"},
    {"key":"academy_ig","label_en":"Academy Instagram","label_ar":"إنستغرام الأكاديمية","value":"@thinkquality_academyy","source":"seed-2026-06"},
    {"key":"academy","label_en":"Academy","label_ar":"الأكاديمية","value":"Personal development + public speaking training, Amman, Jordan","source":"seed-2026-06"},
    {"key":"contact","label_en":"Public contact","label_ar":"وسيلة التواصل","value":"wa.me/962791995030","source":"seed-2026-06"},
    {"key":"anchors","label_en":"Known anchors","label_ar":"المنشورات المرجعية","value":"Two posts at ~13K and ~12K engagement led the 2026-06 ranking","source":"seed-2026-06"}
  ]'::jsonb,
  '[]'::jsonb,
  null,
  null,
  null,
  'seed'
)
on conflict (id) do update set
  facts = excluded.facts,
  updated_at = now();
