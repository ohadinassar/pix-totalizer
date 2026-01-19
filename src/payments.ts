import crypto from "crypto";
import { supabase } from "./database.js";
import { PlanType, PLANS, activateSubscription } from "./subscription.js";

const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
const MP_API_URL = "https://api.mercadopago.com";

/**
 * Validate Mercado Pago webhook signature
 * @see https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 */
export function validateWebhookSignature(
  xSignature: string | null,
  xRequestId: string | null,
  dataId: string
): boolean {
  if (!MP_WEBHOOK_SECRET) {
    console.warn("MERCADO_PAGO_WEBHOOK_SECRET not configured - skipping signature validation");
    return true; // Allow if not configured (for backwards compatibility)
  }

  if (!xSignature || !xRequestId) {
    console.error("Missing x-signature or x-request-id headers");
    return false;
  }

  // Parse x-signature header: "ts=xxx,v1=xxx"
  const parts = xSignature.split(",");
  const signatureParts: Record<string, string> = {};
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key && value) {
      signatureParts[key] = value;
    }
  }

  const ts = signatureParts["ts"];
  const v1 = signatureParts["v1"];

  if (!ts || !v1) {
    console.error("Invalid x-signature format");
    return false;
  }

  // Build the manifest string
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  // Generate HMAC-SHA256
  const hmac = crypto.createHmac("sha256", MP_WEBHOOK_SECRET);
  hmac.update(manifest);
  const expectedSignature = hmac.digest("hex");

  // Constant-time comparison to prevent timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(v1),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    console.error("Webhook signature validation failed");
  }

  return isValid;
}

export interface Payment {
  id: number;
  chat_id: number;
  plan: string;
  amount: number;
  mp_payment_id: string | null;
  mp_status: string | null;
  pix_qr_code: string | null;
  pix_qr_code_base64: string | null;
  created_at: string;
}

export interface CreatePixResult {
  success: boolean;
  paymentId?: string;
  qrCode?: string;
  qrCodeBase64?: string;
  error?: string;
}

export async function createPixPayment(
  chatId: number,
  plan: PlanType
): Promise<CreatePixResult> {
  if (!MP_ACCESS_TOKEN) {
    return { success: false, error: "Mercado Pago não configurado" };
  }

  const planInfo = PLANS[plan];
  if (planInfo.price === 0) {
    return { success: false, error: "Plano gratuito não requer pagamento" };
  }

  try {
    const response = await fetch(`${MP_API_URL}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "X-Idempotency-Key": `${chatId}-${plan}-${Date.now()}`,
      },
      body: JSON.stringify({
        transaction_amount: planInfo.price,
        payment_method_id: "pix",
        payer: {
          email: `telegram_${chatId}@pixtotalizer.com`,
        },
        description: `PIX Totalizer - Plano ${planInfo.displayName}`,
        external_reference: `${chatId}:${plan}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Mercado Pago error:", data);
      return { success: false, error: data.message || "Erro ao criar pagamento" };
    }

    const qrCode = data.point_of_interaction?.transaction_data?.qr_code;
    const qrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64;
    const paymentId = String(data.id);

    // Save payment record
    await supabase.from("payments").insert({
      chat_id: chatId,
      plan,
      amount: planInfo.price,
      mp_payment_id: paymentId,
      mp_status: data.status,
      pix_qr_code: qrCode,
      pix_qr_code_base64: qrCodeBase64,
    });

    return {
      success: true,
      paymentId,
      qrCode,
      qrCodeBase64,
    };
  } catch (error) {
    console.error("Error creating PIX payment:", error);
    return { success: false, error: "Erro ao conectar com Mercado Pago" };
  }
}

export async function handlePaymentWebhook(paymentId: string): Promise<{
  success: boolean;
  chatId?: number;
  plan?: PlanType;
}> {
  if (!MP_ACCESS_TOKEN) {
    return { success: false };
  }

  try {
    // Get payment details from Mercado Pago
    const response = await fetch(`${MP_API_URL}/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      },
    });

    const payment = await response.json();

    if (payment.status !== "approved") {
      // Update payment status in database
      await supabase
        .from("payments")
        .update({ mp_status: payment.status })
        .eq("mp_payment_id", paymentId);

      return { success: false };
    }

    // Parse external_reference to get chatId and plan
    const [chatIdStr, plan] = (payment.external_reference || "").split(":");
    const chatId = parseInt(chatIdStr, 10);

    if (!chatId || !plan) {
      console.error("Invalid external_reference:", payment.external_reference);
      return { success: false };
    }

    // Update payment status
    await supabase
      .from("payments")
      .update({ mp_status: "approved" })
      .eq("mp_payment_id", paymentId);

    // Activate subscription
    await activateSubscription(chatId, plan as PlanType);

    return { success: true, chatId, plan: plan as PlanType };
  } catch (error) {
    console.error("Error handling payment webhook:", error);
    return { success: false };
  }
}

export async function getPaymentByMpId(mpPaymentId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from("payments")
    .select("*")
    .eq("mp_payment_id", mpPaymentId)
    .single();

  return data;
}

export function getPaymentMessage(
  plan: PlanType,
  qrCode: string,
  price: number
): string {
  const planInfo = PLANS[plan];

  return `💳 *Pagamento PIX - ${planInfo.displayName}*

Valor: R$${price.toFixed(2).replace(".", ",")}

📱 *Como pagar:*
1. Abra o app do seu banco
2. Escolha pagar com PIX
3. Escaneie o QR Code ou copie o código abaixo

\`\`\`
${qrCode}
\`\`\`

⏰ O PIX expira em 30 minutos.
Após o pagamento, seu plano será ativado automaticamente.`;
}
