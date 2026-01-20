import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import {
  saveTransaction,
  isDuplicate,
  clearTodayTransactions,
  deleteLastTransaction,
  updateLastTransactionAmount,
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
} from "./subscription.js";
import { createPixPayment, getPaymentMessage } from "./payments.js";

export async function createBot(token: string): Promise<Bot> {
  const bot = new Bot(token);

  // Register commands in Telegram menu
  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar o bot" },
    { command: "assinar", description: "Ver planos e assinar" },
    { command: "plano", description: "Ver seu plano e uso" },
    { command: "total", description: "Ver total do dia" },
    { command: "hoje", description: "Listar transações de hoje" },
    { command: "apagar", description: "Apagar última transação" },
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
        "/apagar - Apagar última transação\n" +
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

  // Handle /apagar command - delete last transaction
  bot.command("apagar", async (ctx) => {
    const chatId = ctx.chat.id;
    const deleted = await deleteLastTransaction(chatId);

    if (deleted) {
      const amount = deleted.amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const message = await getDailySummaryMessage(chatId);
      await ctx.reply(`🗑️ Transação apagada: ${amount}\n\n${message}`);
    } else {
      await ctx.reply("Nenhuma transação para apagar hoje.");
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

  // Handle photo messages
  bot.on("message:photo", async (ctx) => {
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
