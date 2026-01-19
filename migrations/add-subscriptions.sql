-- Run this in Supabase SQL Editor to add subscription tables

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  transactions_used INTEGER DEFAULT 0,
  period_start TIMESTAMPTZ DEFAULT NOW(),
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payment history
CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  plan TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  mp_payment_id TEXT,
  mp_status TEXT,
  pix_qr_code TEXT,
  pix_qr_code_base64 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_chat_id ON subscriptions (chat_id);
CREATE INDEX IF NOT EXISTS idx_payments_chat_id ON payments (chat_id);
CREATE INDEX IF NOT EXISTS idx_payments_mp_payment_id ON payments (mp_payment_id);
