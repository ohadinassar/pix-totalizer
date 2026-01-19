-- Run this in your Supabase SQL Editor to create the transactions table

CREATE TABLE transactions (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  bank_detected TEXT,
  client_name TEXT,
  telegram_file_id TEXT NOT NULL,
  raw_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster daily queries per user
CREATE INDEX idx_transactions_chat_created ON transactions (chat_id, created_at);

-- Index for duplicate detection
CREATE INDEX idx_transactions_chat_file ON transactions (chat_id, telegram_file_id);

-- Index for client name searches
CREATE INDEX idx_transactions_client_name ON transactions (client_name);
