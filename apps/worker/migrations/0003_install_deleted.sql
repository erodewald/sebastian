-- When the user removed the app in SmartThings (verified DELETE lifecycle event).
ALTER TABLE installs ADD COLUMN deleted_at INTEGER;
