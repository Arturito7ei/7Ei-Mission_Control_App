-- 0002_onboarding_columns.sql
ALTER TABLE organisations ADD COLUMN mission TEXT;
ALTER TABLE organisations ADD COLUMN culture TEXT;
ALTER TABLE organisations ADD COLUMN deploy_mode TEXT;
ALTER TABLE organisations ADD COLUMN cloud_provider TEXT;
ALTER TABLE organisations ADD COLUMN preferred_llm TEXT;
ALTER TABLE organisations ADD COLUMN deploy_config TEXT DEFAULT '{}';
