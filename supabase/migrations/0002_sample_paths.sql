-- Malakai Stories — support several voice takes per order
-- Run in the Supabase dashboard: SQL Editor → paste → Run.
--
-- Parents now record three short passages instead of one. ElevenLabs builds a
-- better clone from varied material, so we keep every take.
--
-- sample_path (the existing column) still holds the FIRST take, so anything
-- that already reads it keeps working. sample_paths holds all of them.

alter table public.orders
  add column if not exists sample_paths text[];

-- Backfill existing orders so they have a one-element array.
update public.orders
   set sample_paths = array[sample_path]
 where sample_paths is null
   and sample_path is not null;
