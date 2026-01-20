import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);

/** Returns ISO string for start of today (00:00:00) in local timezone */
export function getStartOfTodayISO(): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString();
}

export interface Transaction {
  id?: number;
  chat_id: number;
  amount: number;
  bank_detected: string | null;
  client_name: string | null;
  telegram_file_id: string;
  raw_response: string;
  created_at?: string;
}

export async function saveTransaction(
  chatId: number,
  amount: number,
  bankDetected: string | null,
  clientName: string | null,
  telegramFileId: string,
  rawResponse: string
): Promise<Transaction> {
  const { data, error } = await supabase
    .from("transactions")
    .insert({
      chat_id: chatId,
      amount,
      bank_detected: bankDetected,
      client_name: clientName,
      telegram_file_id: telegramFileId,
      raw_response: rawResponse,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function isDuplicate(chatId: number, telegramFileId: string): Promise<boolean> {
  const { data } = await supabase
    .from("transactions")
    .select("id")
    .eq("chat_id", chatId)
    .eq("telegram_file_id", telegramFileId)
    .limit(1);

  return (data?.length ?? 0) > 0;
}

export async function getTodayStats(chatId: number): Promise<{ total: number; count: number }> {
  const todayISO = getStartOfTodayISO();

  const { data, error } = await supabase
    .from("transactions")
    .select("amount")
    .eq("chat_id", chatId)
    .gte("created_at", todayISO);

  if (error) throw error;

  const total = data?.reduce((sum, t) => sum + t.amount, 0) ?? 0;
  const count = data?.length ?? 0;

  return { total, count };
}

export async function getTodayTransactions(chatId: number): Promise<Transaction[]> {
  const todayISO = getStartOfTodayISO();

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("chat_id", chatId)
    .gte("created_at", todayISO)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function clearTodayTransactions(chatId: number): Promise<number> {
  const todayISO = getStartOfTodayISO();

  const { data, error } = await supabase
    .from("transactions")
    .delete()
    .eq("chat_id", chatId)
    .gte("created_at", todayISO)
    .select();

  if (error) throw error;
  return data?.length ?? 0;
}

export async function deleteTransactionByIndex(chatId: number, index?: number): Promise<Transaction | null> {
  const todayISO = getStartOfTodayISO();

  // Get all today's transactions ordered by time (ascending, like /hoje shows)
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*")
    .eq("chat_id", chatId)
    .gte("created_at", todayISO)
    .order("created_at", { ascending: true });

  if (!transactions || transactions.length === 0) return null;

  // If no index provided, delete the last one (most recent)
  // If index provided, it's 1-based (matching /hoje display)
  const targetIndex = index === undefined ? transactions.length - 1 : index - 1;

  if (targetIndex < 0 || targetIndex >= transactions.length) return null;

  const targetTx = transactions[targetIndex];

  // Delete it
  await supabase
    .from("transactions")
    .delete()
    .eq("id", targetTx.id);

  return targetTx;
}

export async function updateLastTransactionAmount(chatId: number, newAmount: number): Promise<Transaction | null> {
  const todayISO = getStartOfTodayISO();

  // Get the last transaction
  const { data: lastTx } = await supabase
    .from("transactions")
    .select("*")
    .eq("chat_id", chatId)
    .gte("created_at", todayISO)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!lastTx) return null;

  // Update it
  const { data, error } = await supabase
    .from("transactions")
    .update({ amount: newAmount })
    .eq("id", lastTx.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
