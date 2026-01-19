import { getTodayStats, getTodayTransactions } from "./database.js";

export function formatCurrency(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("pt-BR");
}

export async function getRunningTotalMessage(
  chatId: number,
  justAddedAmount: number,
  bank?: string | null,
  clientName?: string | null
): Promise<string> {
  const { total, count } = await getTodayStats(chatId);

  const amountStr = formatCurrency(justAddedAmount);
  const totalStr = formatCurrency(total);
  const vendas = count === 1 ? "venda" : "vendas";

  let details = "";
  if (clientName) details += `👤 ${clientName}`;
  if (bank) details += details ? ` | 🏦 ${bank}` : `🏦 ${bank}`;
  if (details) details = `\n${details}`;

  return `✓ ${amountStr}${details}\n📊 Total hoje: ${totalStr} (${count} ${vendas})`;
}

export async function getDailySummaryMessage(chatId: number): Promise<string> {
  const { total, count } = await getTodayStats(chatId);
  const today = new Date();

  const totalStr = formatCurrency(total);
  const dateStr = formatDate(today);

  return `📅 PIX ${dateStr}\n💰 Total: ${totalStr}\n🧾 ${count} transações`;
}

export async function getTransactionListMessage(chatId: number): Promise<string> {
  const transactions = await getTodayTransactions(chatId);

  if (transactions.length === 0) {
    return "Nenhuma transação registrada hoje.";
  }

  // Calculate total from already-fetched transactions (avoids extra DB query)
  const total = transactions.reduce((sum, t) => sum + t.amount, 0);
  const lines = transactions.map((t, i) => {
    const time = new Date(t.created_at!).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const amount = formatCurrency(t.amount);
    const details: string[] = [];
    if (t.client_name) details.push(t.client_name);
    if (t.bank_detected) details.push(t.bank_detected);
    const detailStr = details.length > 0 ? ` (${details.join(" - ")})` : "";
    return `${i + 1}. ${time} - ${amount}${detailStr}`;
  });

  const header = `📋 Transações de hoje (${transactions.length}):\n\n`;
  const footer = `\n\n💰 Total: ${formatCurrency(total)}`;

  return header + lines.join("\n") + footer;
}
