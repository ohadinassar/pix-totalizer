import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "application/pdf";

// Model configuration: try cheaper model first, fallback to more capable model
const HAIKU_MODEL = "claude-3-5-haiku-20241022";
const SONNET_MODEL = "claude-sonnet-4-20250514";

export interface ExtractionResult {
  amount: number | null;
  bank: string | null;
  clientName: string | null;
  rawResponse: string;
  error?: string;
}

const EXTRACTION_PROMPT = `This is a Brazilian PIX payment confirmation. Extract the transaction details.

Respond in this exact JSON format:
{"amount": 150.00, "bank": "Nubank", "clientName": "João Silva"}

Rules:
- amount: The value in BRL as a number (e.g., 1500.50 for R$1.500,50)
- bank: The bank/institution name if visible (e.g., "Nubank", "Itaú", "Banco do Brasil"), or null
- clientName: The payer's name (who sent the PIX), or null if not visible
- If you cannot find an amount, respond: {"amount": null, "bank": null, "clientName": null, "error": "reason"}

Only respond with the JSON, nothing else.`;

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

function parseExtractionResponse(responseText: string): ExtractionResult {
  try {
    const parsed = JSON.parse(responseText);
    return {
      amount: parsed.amount,
      bank: parsed.bank || null,
      clientName: parsed.clientName || null,
      rawResponse: responseText,
      error: parsed.error,
    };
  } catch {
    return {
      amount: null,
      bank: null,
      clientName: null,
      rawResponse: responseText,
      error: "Failed to parse response",
    };
  }
}

/** Extract PIX data using a specific model */
async function extractWithModel(
  base64Data: string,
  mediaType: MediaType,
  model: string
): Promise<ExtractionResult> {
  const isPdf = mediaType === "application/pdf";

  const message = await withRetry(() =>
    anthropic.messages.create({
      model,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            isPdf
              ? {
                  type: "document" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "application/pdf" as const,
                    data: base64Data,
                  },
                }
              : {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                    data: base64Data,
                  },
                },
            {
              type: "text",
              text: EXTRACTION_PROMPT,
            },
          ],
        },
      ],
    })
  );

  const responseText = message.content[0].type === "text" ? message.content[0].text : "";
  return parseExtractionResponse(responseText);
}

/** Extract PIX amount from image or PDF (tries Haiku first for images, Sonnet for PDFs) */
export async function extractPixData(
  base64Data: string,
  mediaType: MediaType
): Promise<ExtractionResult> {
  try {
    const isPdf = mediaType === "application/pdf";

    // PDFs require Sonnet - Haiku doesn't support document processing
    if (isPdf) {
      return await extractWithModel(base64Data, mediaType, SONNET_MODEL);
    }

    // For images: try Haiku first (cheaper ~10x)
    const haikusResult = await extractWithModel(base64Data, mediaType, HAIKU_MODEL);

    // If Haiku successfully extracted an amount, use it
    if (haikusResult.amount !== null) {
      return haikusResult;
    }

    // Fallback to Sonnet for difficult images
    console.log("Haiku failed to extract amount, trying Sonnet...");
    const sonnetResult = await extractWithModel(base64Data, mediaType, SONNET_MODEL);
    return sonnetResult;
  } catch (error) {
    console.error("Vision API error:", error);
    return {
      amount: null,
      bank: null,
      clientName: null,
      rawResponse: String(error),
      error: "API call failed",
    };
  }
}

/** @deprecated Use extractPixData instead */
export async function extractPixAmount(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "application/pdf"
): Promise<ExtractionResult> {
  return extractPixData(imageBase64, mediaType);
}

/** @deprecated Use extractPixData instead */
export async function extractFromPdf(pdfBase64: string): Promise<ExtractionResult> {
  return extractPixData(pdfBase64, "application/pdf");
}
