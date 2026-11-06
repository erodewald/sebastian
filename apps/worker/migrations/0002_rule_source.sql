-- M1 web UI: keep the TypeScript an automation was compiled from, and why it got its locality
-- prediction, next to the compiled rule.
ALTER TABLE rules_managed ADD COLUMN source_text TEXT;
ALTER TABLE rules_managed ADD COLUMN reasons_json TEXT;
