import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import {
  saveTransaction,
  isDuplicate,
  clearTodayTransactions,
  deleteTransactionByIndex,
  updateLastTransactionAmount,
  getTodayTransactions,
} from "./database.js";
import { extractPixAmount, extractFromPdf } from "./vision.js";
import {
  getRunningTotalMessage,
  getDailySummaryMessage,
  getTransactionListMessage,
} from "./summary.js";
import {
  canProcess,
  incrementUsage,
  getPlansMessage,
  getStatusMessage,
  PLANS,
  PlanType,
  activateSubscription,
} from "./subscription.js";
import { supabase } from "./database.js";
import { createPixPayment, getPaymentMessage } from "./payments.js";

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;

// Track pending interactive messages with timestamps for auto-expiry
interface PendingMessage {
  messageId: number;
  createdAt: number;
}
const pendingMessages = new Map<number, PendingMessage>();
const PENDING_MESSAGE_TTL = 2 * 60 * 1000; // 2 minutes

async function clearPendingMessage(bot: Bot, chatId: number): Promise<void> {
  const pending = pendingMessages.get(chatId);
  if (pending) {
    try {
      await bot.api.deleteMessage(chatId, pending.messageId);
    } catch {
      // Message might already be deleted, ignore
    }
    pendingMessages.delete(chatId);
  }
}

function setPendingMessage(chatId: number, messageId: number): void {
  pendingMessages.set(chatId, { messageId, createdAt: Date.now() });
}

// Cleanup expired pending messages periodically
function startPendingMessageCleanup(bot: Bot): void {
  setInterval(async () => {
    const now = Date.now();
    for (const [chatId, pending] of pendingMessages.entries()) {
      if (now - pending.createdAt > PENDING_MESSAGE_TTL) {
        console.log(`[cleanup] Expiring pending message for chat ${chatId}`);
        await clearPendingMessage(bot, chatId);
      }
    }
  }, 30 * 1000); // Check every 30 seconds
}

export async function createBot(token: string): Promise<Bot> {
  const bot = new Bot(token);

  // Global error handler - prevents crashes
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`, err.error);
    ctx.reply("❌ Ocorreu um erro. Tente novamente.").catch(() => {});
  });

  // Start periodic cleanup of expired pending messages
  startPendingMessageCleanup(bot);

  // Middleware: Clear pending messages on any new message (except callback queries)
  bot.use(async (ctx, next) => {
    if (ctx.message && ctx.chat) {
      const text = ctx.message.text || "";
      // Don't clear if it's the /apagar command itself
      if (!text.startsWith("/apagar")) {
        await clearPendingMessage(bot, ctx.chat.id);
      }
    }
    await next();
  });

  // Register commands in Telegram menu
  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar o bot" },
    { command: "assinar", description: "Ver planos e assinar" },
    { command: "plano", description: "Ver seu plano e uso" },
    { command: "total", description: "Ver total do dia" },
    { command: "hoje", description: "Listar transações de hoje" },
    { command: "apagar", description: "Apagar transação (ex: /apagar 1)" },
    { command: "editar", description: "Editar última transação" },
    { command: "limpar", description: "Limpar todas transações de hoje" },
  ]);

  // Handle /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "🏦 PIX Totalizer\n\n" +
        "Encaminhe comprovantes PIX (imagens ou PDFs) para registrar.\n\n" +
        "Comandos:\n" +
        "/total - Ver total do dia\n" +
        "/hoje - Listar transações\n" +
        "/apagar - Apagar transação (/apagar 1)\n" +
        "/editar 150.00 - Editar valor\n" +
        "/limpar - Zerar tudo de hoje"
    );
  });

  // Handle /total command
  bot.command("total", async (ctx) => {
    const chatId = ctx.chat.id;
    const message = await getDailySummaryMessage(chatId);
    await ctx.reply(message);
  });

  // Handle /hoje command
  bot.command("hoje", async (ctx) => {
    const chatId = ctx.chat.id;
    const message = await getTransactionListMessage(chatId);
    await ctx.reply(message);
  });

  // Handle /apagar command - show transactions with delete buttons
  bot.command("apagar", async (ctx) => {
    const chatId = ctx.chat.id;
    const transactions = await getTodayTransactions(chatId);

    if (transactions.length === 0) {
      await ctx.reply("Nenhuma transação para apagar hoje.");
      return;
    }

    const keyboard = new InlineKeyboard();
    transactions.forEach((t, i) => {
      const time = new Date(t.created_at!).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const amount = t.amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      keyboard.text(`${i + 1}. ${time} - ${amount}`, `apagar:${i + 1}`).row();
    });
    keyboard.text("❌ Cancelar", "apagar:cancelar");

    // Clear any previous pending message
    await clearPendingMessage(bot, chatId);

    const sent = await ctx.reply("🗑️ Qual transação deseja apagar?", { reply_markup: keyboard });
    setPendingMessage(chatId, sent.message_id);
  });

  // Handle delete transaction callback
  bot.callbackQuery(/^apagar:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const chatId = ctx.chat!.id;
    console.log(`[apagar callback] action=${action}, chatId=${chatId}`);

    // Clear from pending map
    pendingMessages.delete(chatId);

    if (action === "cancelar") {
      await ctx.answerCallbackQuery({ text: "Cancelado" });
      await ctx.deleteMessage();
      return;
    }

    const index = parseInt(action, 10);
    if (isNaN(index)) {
      console.log(`[apagar callback] invalid index: ${action}`);
      await ctx.answerCallbackQuery({ text: "Erro" });
      return;
    }

    console.log(`[apagar callback] deleting index ${index}`);
    const deleted = await deleteTransactionByIndex(chatId, index);
    console.log(`[apagar callback] deleted:`, deleted);

    if (deleted) {
      const amount = deleted.amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      await ctx.answerCallbackQuery({ text: `Apagada: ${amount}` });
      await ctx.deleteMessage();
      const message = await getDailySummaryMessage(chatId);
      await ctx.reply(`🗑️ Transação #${index} apagada: ${amount}\n\n${message}`);
    } else {
      console.log(`[apagar callback] transaction not found`);
      await ctx.answerCallbackQuery({ text: "Transação não encontrada" });
      await ctx.deleteMessage();
    }
  });

  // Handle /editar command - correct last transaction amount
  bot.command("editar", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.message?.text?.split(" ").slice(1).join(" ");

    if (!args) {
      await ctx.reply("Use: /editar 150.00\n\nExemplo: /editar 1500,50");
      return;
    }

    // Parse amount (accept both . and , as decimal separator)
    const cleanAmount = args.replace(",", ".").replace(/[^\d.]/g, "");
    const newAmount = parseFloat(cleanAmount);

    if (isNaN(newAmount) || newAmount <= 0) {
      await ctx.reply("❌ Valor inválido. Use: /editar 150.00");
      return;
    }

    const updated = await updateLastTransactionAmount(chatId, newAmount);

    if (updated) {
      const amountStr = newAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const message = await getDailySummaryMessage(chatId);
      await ctx.reply(`✏️ Última transação editada para: ${amountStr}\n\n${message}`);
    } else {
      await ctx.reply("Nenhuma transação para editar hoje.");
    }
  });

  // Handle /limpar command - clear all today's transactions
  bot.command("limpar", async (ctx) => {
    const chatId = ctx.chat.id;
    const count = await clearTodayTransactions(chatId);

    if (count > 0) {
      await ctx.reply(`🧹 ${count} transação(ões) apagada(s). Total zerado.`);
    } else {
      await ctx.reply("Nenhuma transação para limpar hoje.");
    }
  });

  // Handle /plano command - show current plan and usage
  bot.command("plano", async (ctx) => {
    const chatId = ctx.chat.id;
    const message = await getStatusMessage(chatId);
    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  // Handle /assinar command - show plans with buttons
  bot.command("assinar", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text("💼 Básico - R$197", "assinar:basico")
      .row()
      .text("🚀 Pro - R$349", "assinar:pro")
      .row()
      .text("⚡ Ultra - R$697", "assinar:ultra");

    await ctx.reply(
      `📋 *Escolha seu plano:*\n\n` +
      `🆓 *Grátis* - 5 comprovantes/dia - R$0 _(atual)_\n\n` +
      `💼 *Básico* - 1.000 comprovantes/mês - R$197\n` +
      `🚀 *Pro* - 3.500 comprovantes/mês - R$349\n` +
      `⚡ *Ultra* - Comprovantes ilimitados - R$697`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  // Handle plan subscription button clicks
  bot.callbackQuery(/^assinar:(.+)$/, async (ctx) => {
    const plan = ctx.match[1] as PlanType;
    const chatId = ctx.chat!.id;

    if (!PLANS[plan] || plan === "free") {
      await ctx.answerCallbackQuery({ text: "Plano inválido" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Gerando PIX..." });

    const planInfo = PLANS[plan];
    await ctx.reply(`⏳ Gerando PIX para plano ${planInfo.displayName}...`);

    const result = await createPixPayment(chatId, plan);

    if (!result.success) {
      await ctx.reply(`❌ Erro ao gerar PIX: ${result.error}`);
      return;
    }

    // Send QR code as image
    if (result.qrCodeBase64) {
      const imageBuffer = Buffer.from(result.qrCodeBase64, "base64");
      await ctx.replyWithPhoto(new InputFile(imageBuffer, "qrcode.png"));
    }

    // Send payment message with copy-paste code
    const message = getPaymentMessage(plan, result.qrCode!, planInfo.price);
    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  // Admin command: /grant <chat_id> - give lifetime ultra access
  bot.command("grant", async (ctx) => {
    const chatId = ctx.chat.id;

    // Only admin can use this command
    if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
      return; // Silently ignore for non-admins
    }

    const args = ctx.message?.text?.split(" ").slice(1);
    if (!args || args.length === 0) {
      await ctx.reply("Uso: /grant <chat_id>\n\nExemplo: /grant 123456789");
      return;
    }

    const targetChatId = parseInt(args[0], 10);
    if (isNaN(targetChatId)) {
      await ctx.reply("❌ Chat ID inválido");
      return;
    }

    // Grant lifetime ultra access (year 2099)
    const periodEnd = new Date("2099-12-31T23:59:59Z");

    const { error } = await supabase
      .from("subscriptions")
      .upsert(
        {
          chat_id: targetChatId,
          plan: "ultra",
          transactions_used: 0,
          period_start: new Date().toISOString(),
          period_end: periodEnd.toISOString(),
        },
        { onConflict: "chat_id" }
      );

    if (error) {
      await ctx.reply(`❌ Erro: ${error.message}`);
      return;
    }

    await ctx.reply(`✅ Acesso lifetime Ultra concedido para chat ${targetChatId}`);
  });

  // Admin command: /stats - show usage statistics
  bot.command("stats", async (ctx) => {
    const chatId = ctx.chat.id;

    // Only admin can use this command
    if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
      return;
    }

    // Get total users
    const { count: totalUsers } = await supabase
      .from("subscriptions")
      .select("*", { count: "exact", head: true });

    // Get users by plan
    const { data: planStats } = await supabase
      .from("subscriptions")
      .select("plan");

    const planCounts: Record<string, number> = { free: 0, basico: 0, pro: 0, ultra: 0 };
    planStats?.forEach((s) => {
      planCounts[s.plan] = (planCounts[s.plan] || 0) + 1;
    });

    // Get today's transactions
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: todayTx } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today.toISOString());

    // Get total transactions
    const { count: totalTx } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true });

    await ctx.reply(
      `📊 *Estatísticas*\n\n` +
      `👥 *Usuários:* ${totalUsers || 0}\n` +
      `├ 🆓 Grátis: ${planCounts.free}\n` +
      `├ 💼 Básico: ${planCounts.basico}\n` +
      `├ 🚀 Pro: ${planCounts.pro}\n` +
      `└ ⚡ Ultra: ${planCounts.ultra}\n\n` +
      `📄 *Transações:*\n` +
      `├ Hoje: ${todayTx || 0}\n` +
      `└ Total: ${totalTx || 0}`,
      { parse_mode: "Markdown" }
    );
  });

  // Admin command: /exportar - export today's transactions as CSV
  bot.command("exportar", async (ctx) => {
    const chatId = ctx.chat.id;

    // Get today's transactions for this user (or all if admin)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let query = supabase
      .from("transactions")
      .select("*")
      .gte("created_at", today.toISOString())
      .order("created_at", { ascending: true });

    // If not admin, only show user's own transactions
    if (!ADMIN_CHAT_ID || chatId !== ADMIN_CHAT_ID) {
      query = query.eq("chat_id", chatId);
    }

    const { data: transactions, error } = await query;

    if (error || !transactions || transactions.length === 0) {
      await ctx.reply("Nenhuma transação para exportar hoje.");
      return;
    }

    // Create CSV
    const headers = "Data,Valor,Banco,Cliente\n";
    const rows = transactions.map((t) => {
      const date = new Date(t.created_at).toLocaleString("pt-BR");
      const amount = t.amount.toFixed(2).replace(".", ",");
      const bank = t.bank || "";
      const client = t.client_name || "";
      return `"${date}","R$${amount}","${bank}","${client}"`;
    }).join("\n");

    const csv = headers + rows;
    const buffer = Buffer.from(csv, "utf-8");

    await ctx.replyWithDocument(
      new InputFile(buffer, `transacoes_${today.toISOString().split("T")[0]}.csv`),
      { caption: `📊 ${transactions.length} transações exportadas` }
    );
  });

  // Handle photo messages
  bot.on("message:photo", async (ctx) => {
    // Clear any pending interactive message (like /apagar buttons)
    await clearPendingMessage(bot, ctx.chat.id);
    await processImage(ctx);
  });

  // Handle document messages (PDFs and images sent as files)
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type || "";

    if (
      mimeType.startsWith("image/") ||
      mimeType === "application/pdf"
    ) {
      // Clear any pending interactive message (like /apagar buttons)
      await clearPendingMessage(bot, ctx.chat.id);
      await processDocument(ctx, mimeType);
    } else {
      await ctx.reply("⚠️ Envie apenas imagens ou PDFs de comprovantes PIX.");
    }
  });

  return bot;
}

async function processImage(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;

  const chatId = ctx.chat!.id;

  // Check subscription limit
  const check = await canProcess(chatId);
  if (!check.allowed) {
    const renewMsg = check.expired
      ? `\n\n💳 Use /assinar para renovar`
      : `\n\nUse /assinar para fazer upgrade`;
    await ctx.reply(
      `⚠️ ${check.message}\n\n` +
      `📊 Seu plano: ${PLANS[check.plan].displayName}` +
      renewMsg
    );
    return;
  }

  // Warn about grace period
  if (check.inGracePeriod && check.message) {
    await ctx.reply(check.message + `\n\n💳 Use /assinar ${check.plan} para renovar`);
  }

  // Get the largest photo
  const photo = photos[photos.length - 1];
  const fileId = photo.file_id;

  // Check for duplicate
  if (await isDuplicate(chatId, fileId)) {
    await ctx.reply("⚠️ Este comprovante já foi registrado.");
    return;
  }

  await ctx.reply("🔍 Processando comprovante...");

  try {
    // Download the file
    const file = await ctx.api.getFile(fileId);
    const filePath = file.file_path!;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    // Determine media type
    const mediaType = filePath.endsWith(".png") ? "image/png" : "image/jpeg";

    // Extract amount using Claude Vision
    const result = await extractPixAmount(base64, mediaType);

    if (result.amount === null) {
      await ctx.reply(
        `❌ Não consegui identificar o valor.\n${result.error || "Tente enviar uma imagem mais clara."}`
      );
      return;
    }

    // Save transaction
    await saveTransaction(chatId, result.amount, result.bank, result.clientName, fileId, result.rawResponse);

    // Increment usage for paid plans
    await incrementUsage(chatId);

    // Send running total
    const message = await getRunningTotalMessage(chatId, result.amount, result.bank, result.clientName);
    await ctx.reply(message);
  } catch (error) {
    console.error("Error processing image:", error);
    await ctx.reply("❌ Erro ao processar o comprovante. Tente novamente.");
  }
}

async function processDocument(ctx: Context, mimeType: string): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;

  const chatId = ctx.chat!.id;
  const fileId = doc.file_id;

  // Check subscription limit
  const check = await canProcess(chatId);
  if (!check.allowed) {
    const renewMsg = check.expired
      ? `\n\n💳 Use /assinar para renovar`
      : `\n\nUse /assinar para fazer upgrade`;
    await ctx.reply(
      `⚠️ ${check.message}\n\n` +
      `📊 Seu plano: ${PLANS[check.plan].displayName}` +
      renewMsg
    );
    return;
  }

  // Warn about grace period
  if (check.inGracePeriod && check.message) {
    await ctx.reply(check.message + `\n\n💳 Use /assinar ${check.plan} para renovar`);
  }

  // Check for duplicate
  if (await isDuplicate(chatId, fileId)) {
    await ctx.reply("⚠️ Este comprovante já foi registrado.");
    return;
  }

  await ctx.reply("🔍 Processando comprovante...");

  try {
    // Download the file
    const file = await ctx.api.getFile(fileId);
    const filePath = file.file_path!;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    let result;
    if (mimeType === "application/pdf") {
      result = await extractFromPdf(base64);
    } else {
      const mediaType = mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      result = await extractPixAmount(base64, mediaType);
    }

    if (result.amount === null) {
      await ctx.reply(
        `❌ Não consegui identificar o valor.\n${result.error || "Tente enviar um arquivo mais claro."}`
      );
      return;
    }

    // Save transaction
    await saveTransaction(chatId, result.amount, result.bank, result.clientName, fileId, result.rawResponse);

    // Increment usage for paid plans
    await incrementUsage(chatId);

    // Send running total
    const message = await getRunningTotalMessage(chatId, result.amount, result.bank, result.clientName);
    await ctx.reply(message);
  } catch (error) {
    console.error("Error processing document:", error);
    await ctx.reply("❌ Erro ao processar o comprovante. Tente novamente.");
  }
}
