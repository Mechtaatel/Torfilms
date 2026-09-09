-- Run as the Torfilms table owner, after enabling Neon Data API WITHOUT broad grants.
BEGIN;
CREATE SCHEMA IF NOT EXISTS catalog;
REVOKE ALL ON SCHEMA catalog FROM PUBLIC, anonymous, authenticated;
GRANT USAGE ON SCHEMA catalog TO anonymous, authenticated;
REVOKE ALL ON TABLE public.torfilms_catalog FROM PUBLIC, anonymous, authenticated;
ALTER TABLE public.torfilms_catalog ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF to_regclass('public.torfilms_accounts') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.torfilms_accounts FROM PUBLIC, anonymous, authenticated';
    EXECUTE 'ALTER TABLE public.torfilms_accounts ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
-- Applies to future tables created by the role executing this migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anonymous, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog REVOKE ALL ON TABLES FROM PUBLIC, anonymous, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anonymous, authenticated;

-- Deliberately owner-rights: callers cannot SELECT the underlying payload.
-- The explicit allowlists (including nested objects) are the disclosure boundary.
CREATE OR REPLACE VIEW catalog.movies WITH (security_barrier = true) AS
SELECT c.id, jsonb_build_object(
  'id', c.payload->'id',
  'title', c.payload->'title',
  'year', c.payload->'year',
  'kind', c.payload->'kind',
  'genre', c.payload->'genre',
  'description', c.payload->'description',
  'poster', c.payload->'poster',
  'kinopoiskId', c.payload->'kinopoiskId',
  'ageRating', c.payload->'ageRating',
  'tags', c.payload->'tags',
  'isSeries', c.payload->'isSeries',
  'completed', c.payload->'completed',
  'endDate', c.payload->'endDate',
  'seasons', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'number', s->'number', 'title', s->'title', 'poster', s->'poster'
  )) FROM jsonb_array_elements(COALESCE(c.payload->'seasons','[]'::jsonb)) s), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', s->'id', 'label', s->'label', 'season', s->'season', 'fileIndex', s->'fileIndex',
    'episodes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'index', e->'index', 'title', e->'title', 'season', e->'season', 'excluded', e->'excluded'
    )) FROM jsonb_array_elements(COALESCE(s->'episodes','[]'::jsonb)) e), '[]'::jsonb)
  )) FROM jsonb_array_elements(COALESCE(c.payload->'sources','[]'::jsonb)) s), '[]'::jsonb)
) AS movie
FROM public.torfilms_catalog c;
REVOKE ALL ON catalog.movies FROM PUBLIC, anonymous, authenticated;
GRANT SELECT ON catalog.movies TO anonymous, authenticated;
COMMIT;
