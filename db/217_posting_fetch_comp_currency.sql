-- desk_posting_fetch.comp_currency (2026-09-29): the currency the numbers are in.
--
-- db/216 stored comp_min_k and comp_max_k and not the currency they count, which
-- is only safe while every posting is American. compShort() in src/lib/data.ts
-- falls back to a dollar sign when a range carries no currency, so a €211K
-- Ashby posting would have rendered "$211K" -- a wrong number stated
-- confidently, in the field a person compares offers on. Every platform that
-- gives structured pay also gives its currency (Ashby currencyCode, Lever
-- salaryRange.currency, Workable salary_currency, Rippling currency,
-- schema.org baseSalary.currency), so the value was there to be kept.
--
-- ISO 4217, three letters, upper case, and only alongside a range: a currency
-- with nothing to count is noise, and a range without one is the defect above.
ALTER TABLE desk_posting_fetch
  ADD COLUMN IF NOT EXISTS comp_currency text CHECK (comp_currency ~ '^[A-Z]{3}$');

ALTER TABLE desk_posting_fetch
  DROP CONSTRAINT IF EXISTS desk_posting_fetch_comp_currency_check2;
ALTER TABLE desk_posting_fetch
  ADD CONSTRAINT desk_posting_fetch_comp_currency_check2
  CHECK (comp_currency IS NULL OR comp_min_k IS NOT NULL);
