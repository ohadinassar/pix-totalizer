import { supabase, getStartOfTodayISO } from "./database.js";

export type PlanType = "free" | "basico" | "pro" | "ultra";

export interface Subscription {
  id: number;
  chat_id: number;
  plan: PlanType;
  transactions_used: number;
  period_start: string;
  period_end: string | null;
  created_at: string;
}

export interface PlanInfo {
  name: string;
  displayName: string;
  price: number;
  limit: number | null; // null = unlimited
  description: string;
}

// Grace period in days after subscription expires
const GRACE_PERIOD_DAYS = 3;

export const PLANS: Record<PlanType, PlanInfo> = {
  free: {
    name: "free",
    displayName: "Grátis",
    price: 0,
    limit: 5, // per day
    description: "5 comprovantes/dia",
  },
  basico: {
    name: "basico",
    displayName: "Básico",
    price: 197,
    limit: 1000,
    description: "1.000 comprovantes/mês",
  },
  pro: {
    name: "pro",
    displayName: "Pro",
    price: 349,
    limit: 3500,
    description: "3.500 comprovantes/mês",
  },
  ultra: {
    name: "ultra",
    displayName: "Ultra",
    price: 697,
    limit: null,
    description: "Comprovantes ilimitados",
  },
};

export async function getSubscription(chatId: number): Promise<Subscription | null> {
  const { data } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("chat_id", chatId)
    .single();

  return data;
}

export async function getOrCreateSubscription(chatId: number): Promise<Subscription> {
  let sub = await getSubscription(chatId);

  if (!sub) {
    const { data, error } = await supabase
      .from("subscriptions")
      .insert({ chat_id: chatId, plan: "free" })
      .select()
      .single();

    if (error) throw error;
    sub = data;
  }

  return sub!;
}

export interface CanProcessResult {
  allowed: boolean;
  plan: PlanType;
  used: number;
  limit: number | null;
  message?: string;
  expired?: boolean;
  inGracePeriod?: boolean;
  daysUntilExpiry?: number | null;
}

/** Check if subscription has expired (past grace period) */
export function isSubscriptionExpired(sub: Subscription): boolean {
  if (sub.plan === "free" || !sub.period_end) return false;

  const gracePeriodEnd = new Date(sub.period_end);
  gracePeriodEnd.setDate(gracePeriodEnd.getDate() + GRACE_PERIOD_DAYS);

  return new Date() > gracePeriodEnd;
}

/** Check if subscription is in grace period */
export function isInGracePeriod(sub: Subscription): boolean {
  if (sub.plan === "free" || !sub.period_end) return false;

  const now = new Date();
  const periodEnd = new Date(sub.period_end);
  const gracePeriodEnd = new Date(sub.period_end);
  gracePeriodEnd.setDate(gracePeriodEnd.getDate() + GRACE_PERIOD_DAYS);

  return now > periodEnd && now <= gracePeriodEnd;
}

/** Get days until subscription expires (negative if already expired) */
export function getDaysUntilExpiry(sub: Subscription): number | null {
  if (sub.plan === "free" || !sub.period_end) return null;

  const now = new Date();
  const periodEnd = new Date(sub.period_end);
  const diffMs = periodEnd.getTime() - now.getTime();

  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export async function canProcess(chatId: number): Promise<CanProcessResult> {
  const sub = await getOrCreateSubscription(chatId);
  const plan = sub.plan as PlanType;
  const planInfo = PLANS[plan];
  const daysUntilExpiry = getDaysUntilExpiry(sub);

  // Check expiration for paid plans
  if (plan !== "free") {
    // Fully expired (past grace period) - downgrade to free
    if (isSubscriptionExpired(sub)) {
      await downgradeToFree(chatId);
      const todayCount = await getTodayTransactionCount(chatId);
      const freeLimit = PLANS.free.limit!;

      return {
        allowed: todayCount < freeLimit,
        plan: "free",
        used: todayCount,
        limit: freeLimit,
        expired: true,
        message: `Sua assinatura ${planInfo.displayName} expirou. Plano rebaixado para Grátis.`,
      };
    }

    // In grace period - warn but allow
    if (isInGracePeriod(sub)) {
      const graceDaysLeft = GRACE_PERIOD_DAYS + (daysUntilExpiry ?? 0);

      // Ultra plan - unlimited
      if (plan === "ultra") {
        return {
          allowed: true,
          plan,
          used: sub.transactions_used,
          limit: null,
          inGracePeriod: true,
          daysUntilExpiry,
          message: `⚠️ Assinatura vencida! Renove em ${graceDaysLeft} dias para manter acesso.`,
        };
      }

      // Paid plans with limits
      const monthlyLimit = planInfo.limit!;
      return {
        allowed: sub.transactions_used < monthlyLimit,
        plan,
        used: sub.transactions_used,
        limit: monthlyLimit,
        inGracePeriod: true,
        daysUntilExpiry,
        message: `⚠️ Assinatura vencida! Renove em ${graceDaysLeft} dias para manter acesso.`,
      };
    }
  }

  // Ultra plan - unlimited
  if (plan === "ultra") {
    return {
      allowed: true,
      plan,
      used: sub.transactions_used,
      limit: null,
      daysUntilExpiry,
    };
  }

  // Free plan - check daily limit
  if (plan === "free") {
    const todayCount = await getTodayTransactionCount(chatId);
    const dailyLimit = planInfo.limit!;

    if (todayCount >= dailyLimit) {
      return {
        allowed: false,
        plan,
        used: todayCount,
        limit: dailyLimit,
        message: `Limite diário atingido (${todayCount}/${dailyLimit})`,
      };
    }

    return {
      allowed: true,
      plan,
      used: todayCount,
      limit: dailyLimit,
    };
  }

  // Paid plans - check monthly limit
  const monthlyLimit = planInfo.limit!;
  if (sub.transactions_used >= monthlyLimit) {
    return {
      allowed: false,
      plan,
      used: sub.transactions_used,
      limit: monthlyLimit,
      daysUntilExpiry,
      message: `Limite mensal atingido (${sub.transactions_used}/${monthlyLimit})`,
    };
  }

  return {
    allowed: true,
    plan,
    used: sub.transactions_used,
    limit: monthlyLimit,
    daysUntilExpiry,
  };
}

/** Downgrade expired subscription to free plan */
export async function downgradeToFree(chatId: number): Promise<void> {
  await supabase
    .from("subscriptions")
    .update({
      plan: "free",
      transactions_used: 0,
      period_end: null,
    })
    .eq("chat_id", chatId);
}

async function getTodayTransactionCount(chatId: number): Promise<number> {
  const todayISO = getStartOfTodayISO();

  const { count } = await supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .gte("created_at", todayISO);

  return count ?? 0;
}

export async function incrementUsage(chatId: number): Promise<void> {
  const sub = await getOrCreateSubscription(chatId);

  // Only increment for paid plans (free uses daily count from transactions)
  if (sub.plan !== "free") {
    await supabase
      .from("subscriptions")
      .update({ transactions_used: sub.transactions_used + 1 })
      .eq("chat_id", chatId);
  }
}

export async function activateSubscription(
  chatId: number,
  plan: PlanType
): Promise<Subscription> {
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const { data, error } = await supabase
    .from("subscriptions")
    .upsert({
      chat_id: chatId,
      plan,
      transactions_used: 0,
      period_start: new Date().toISOString(),
      period_end: periodEnd.toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function resetMonthlyUsage(): Promise<number> {
  const { data, error } = await supabase
    .from("subscriptions")
    .update({
      transactions_used: 0,
      period_start: new Date().toISOString(),
    })
    .neq("plan", "free")
    .select();

  if (error) throw error;
  return data?.length ?? 0;
}

export function getPlansMessage(): string {
  return `📋 *Planos PIX Totalizer*

🆓 *Grátis*
• 5 comprovantes/dia
• R$0

💼 *Básico* - R$197/mês
• 1.000 comprovantes/mês
• Suporte prioritário

🚀 *Pro* - R$349/mês
• 3.500 comprovantes/mês
• Suporte prioritário

⚡ *Ultra* - R$697/mês
• Comprovantes ilimitados
• Suporte VIP

Use /assinar <plano> para assinar
Exemplo: /assinar basico`;
}

export async function getStatusMessage(chatId: number): Promise<string> {
  const sub = await getOrCreateSubscription(chatId);
  const plan = sub.plan as PlanType;
  const planInfo = PLANS[plan];

  let usage = "";
  if (plan === "free") {
    const todayCount = await getTodayTransactionCount(chatId);
    usage = `${todayCount}/${planInfo.limit} hoje`;
  } else if (plan === "ultra") {
    usage = `${sub.transactions_used} este mês (ilimitado)`;
  } else {
    usage = `${sub.transactions_used}/${planInfo.limit} este mês`;
  }

  const periodEnd = sub.period_end
    ? new Date(sub.period_end).toLocaleDateString("pt-BR")
    : "N/A";

  // Check expiry status for paid plans
  let expiryStatus = "";
  if (plan !== "free") {
    const daysUntil = getDaysUntilExpiry(sub);
    if (isSubscriptionExpired(sub)) {
      expiryStatus = "\n⚠️ *Assinatura expirada!* Use /assinar para renovar";
    } else if (isInGracePeriod(sub)) {
      const graceDaysLeft = GRACE_PERIOD_DAYS + (daysUntil ?? 0);
      expiryStatus = `\n⚠️ *Período de carência:* ${graceDaysLeft} dias restantes`;
    } else if (daysUntil !== null && daysUntil <= 7) {
      expiryStatus = `\n⏰ *Expira em ${daysUntil} dias*`;
    }
  }

  return `📊 *Seu Plano*

Plano: ${planInfo.displayName}
Uso: ${usage}
${plan !== "free" ? `Válido até: ${periodEnd}` : ""}${expiryStatus}

${plan === "free" ? "Use /assinar para fazer upgrade" : ""}`;
}
