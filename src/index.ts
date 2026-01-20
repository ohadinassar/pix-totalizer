import { createBot } from "./bot.js";
import { getDailySummaryMessage } from "./summary.js";
import { handlePaymentWebhook, validateWebhookSignature } from "./payments.js";
import { resetMonthlyUsage, PLANS } from "./subscription.js";
import { webhookCallback } from "grammy";
import cron from "node-cron";
import http from "http";

// Validate environment variables
const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "ANTHROPIC_API_KEY",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g., https://pix-totalizer-production.up.railway.app

async function main() {
  console.log("Starting PIX Totalizer bot...");

  const bot = await createBot(TELEGRAM_BOT_TOKEN);

  // Schedule daily summary at 23:59 BRT
  cron.schedule(
    "59 23 * * *",
    async () => {
      console.log("Sending daily summary...");
      if (ADMIN_CHAT_ID) {
        try {
          const chatId = parseInt(ADMIN_CHAT_ID, 10);
          const message = await getDailySummaryMessage(chatId);
          await bot.api.sendMessage(chatId, message);
          console.log("Daily summary sent successfully");
        } catch (error) {
          console.error("Failed to send daily summary:", error);
        }
      }
    },
    {
      timezone: "America/Sao_Paulo",
    }
  );

  // Reset monthly usage on 1st of each month at 00:01 BRT
  cron.schedule(
    "1 0 1 * *",
    async () => {
      console.log("Resetting monthly usage...");
      try {
        const count = await resetMonthlyUsage();
        console.log(`Reset usage for ${count} subscriptions`);
      } catch (error) {
        console.error("Failed to reset monthly usage:", error);
      }
    },
    {
      timezone: "America/Sao_Paulo",
    }
  );

  // Create webhook handler for Telegram
  const handleTelegramWebhook = webhookCallback(bot, "http");

  // Create HTTP server
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Telegram webhook
    if (req.method === "POST" && req.url === "/webhook/telegram") {
      try {
        await handleTelegramWebhook(req, res);
      } catch (error) {
        console.error("Telegram webhook error:", error);
        res.writeHead(500);
        res.end("Error");
      }
      return;
    }

    // Mercado Pago webhook
    if (req.method === "POST" && req.url === "/webhook/mercadopago") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          console.log("Webhook received:", data.action, data.data?.id);

          // Validate webhook signature
          const xSignature = req.headers["x-signature"] as string | undefined;
          const xRequestId = req.headers["x-request-id"] as string | undefined;
          const dataId = String(data.data?.id || "");

          if (!validateWebhookSignature(xSignature ?? null, xRequestId ?? null, dataId)) {
            console.error("Invalid webhook signature - rejecting request");
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }

          if (data.action === "payment.updated" || data.action === "payment.created") {
            const paymentId = data.data?.id;
            if (paymentId) {
              const result = await handlePaymentWebhook(String(paymentId));
              if (result.success && result.chatId) {
                const planInfo = PLANS[result.plan!];
                await bot.api.sendMessage(
                  result.chatId,
                  `✅ Pagamento confirmado!\n\n` +
                  `Seu plano *${planInfo.displayName}* foi ativado.\n` +
                  `Limite: ${planInfo.description}\n\n` +
                  `Obrigado por assinar o PIX Totalizer!`,
                  { parse_mode: "Markdown" }
                );
              }
            }
          }

          res.writeHead(200);
          res.end("OK");
        } catch (error) {
          console.error("Webhook error:", error);
          res.writeHead(500);
          res.end("Error");
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);

    // Set up Telegram webhook if URL is configured
    if (WEBHOOK_URL) {
      const webhookUrl = `${WEBHOOK_URL}/webhook/telegram`;
      try {
        await bot.api.setWebhook(webhookUrl);
        console.log(`Telegram webhook set to: ${webhookUrl}`);
      } catch (error) {
        console.error("Failed to set webhook:", error);
      }
    } else {
      console.warn("WEBHOOK_URL not set - Telegram webhook not configured");
      console.warn("Set WEBHOOK_URL env var to enable webhooks");
    }

    const botInfo = await bot.api.getMe();
    console.log(`Bot @${botInfo.username} is running!`);
    console.log("Daily summary scheduled for 23:59 BRT");
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    if (WEBHOOK_URL) {
      await bot.api.deleteWebhook();
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    if (WEBHOOK_URL) {
      await bot.api.deleteWebhook();
    }
    process.exit(0);
  });
}

main().catch(console.error);
