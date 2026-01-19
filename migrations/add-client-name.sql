-- Run this in your Supabase SQL Editor to add client_name column

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_name TEXT;

-- Add index for client name searches
CREATE INDEX IF NOT EXISTS idx_transactions_client_name ON transactions (client_name);
