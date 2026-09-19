-- 203_render_usage.sql
--
-- Real per-draft token usage on generated_render, so a later feature can show a
-- person what a draft actually cost on their own key. Until now a render row
-- recorded WHICH provider and model it used (provider, model) but never HOW MUCH
-- that call spent: the two wire adapters (src/lib/generation-providers.ts) read
-- the response's own `usage` block and then threw it away. These three columns
-- are where that measured usage now lands, captured at the moment a draft
-- settles (completeDraft, src/lib/generated-render-store.ts).
--
-- ALL THREE NULLABLE, ON PURPOSE. A token count is a MEASUREMENT, not a default,
-- and the honest value for "not measured" is NULL, never 0. Three cases carry no
-- measurement and must stay null rather than read as a real zero:
--   (1) a pending row that has not rendered yet: nothing has been spent.
--   (2) a deterministic (no-key) 'fallback' render: the built-in writer made the
--       document with no provider call at all, so there are no tokens to record.
--   (3) an older row written before this migration.
-- A generative call that genuinely came back with no `usage` field is the one
-- case where 0 is honest, and that 0 is produced by the accumulator upstream,
-- never by this column's default (there is none).
--
--   input_tokens   prompt/input tokens the provider billed for the draft's call
--                  (anthropic usage.input_tokens, openai-style usage.prompt_tokens).
--   output_tokens  completion/output tokens (anthropic usage.output_tokens,
--                  openai-style usage.completion_tokens).
--   render_ms      wall-clock milliseconds the render took, measured at the call
--                  site as (now - started_at) only when that start is known.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS), the same posture db/202
-- and the migrations before it take, so a re-run is safe and no backfill is
-- needed: every existing row reads NULL, which is exactly "not measured".

ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS output_tokens integer;
ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS render_ms integer;
