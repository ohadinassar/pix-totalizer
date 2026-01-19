# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PIX Totalizer is a Telegram bot that analyzes PIX payment receipts using Claude Vision API, extracts transaction amounts, and tracks daily totals. Built for Brazilian users with Portuguese UI and BRL currency.

## Development Commands

```bash
npm run dev     # Run bot in development with tsx (hot reload)
npm run build   # Compile TypeScript to dist/
npm start       # Run compiled bot from dist/
```

No test or lint scripts are currently configured.

## Architecture

**Tech Stack:** TypeScript, Grammy (Telegram), Supabase (PostgreSQL), Claude Vision API (Sonnet 4), Mercado Pago (payments), node-cron

**Module Structure:**
- `src/index.ts` - Entry point: bot init, cron jobs, webhook server
- `src/bot.ts` - Telegram command handlers and message processors
- `src/vision.ts` - Claude Vision integration for receipt OCR (images + PDFs)
- `src/database.ts` - Supabase CRUD operations for transactions
- `src/payments.ts` - Mercado Pago PIX payment creation and webhooks
- `src/subscription.ts` - Plan management and usage tracking
- `src/summary.ts` - Message formatting utilities

**Data Flow:**
```
Image/PDF → Duplicate check → Subscription limit check → Claude Vision OCR
→ JSON parse → Save to Supabase → Increment usage → Send running total
```

**Subscription Plans:** free (5/day), basico (1000/month), pro (3500/month), ultra (unlimited)

**Scheduled Tasks (BRT timezone):**
- Daily 23:59: Send summary to admin
- Monthly 1st 00:01: Reset paid plan usage counters

**Webhook Endpoint:** POST `/webhook/mercadopago` handles payment confirmations

## Key Patterns

- Vision API uses structured JSON extraction with 3 retries and exponential backoff
- All database queries scoped to current day using ISO timestamps
- Duplicate detection via telegram_file_id
- Environment config via .env (see .env.example)
- All user messages in Portuguese (pt-BR locale)

## Required Environment Variables

TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY, MERCADO_PAGO_ACCESS_TOKEN, ADMIN_CHAT_ID
