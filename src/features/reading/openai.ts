import { READING_MODEL } from "./prompts.js";

export function isReadingConfigured() { return !!process.env.OPENAI_API_KEY?.trim(); }

/** Server-only Responses client. No API keys or provider error bodies reach GraphQL. */
export async function requestStructured(instructions: string, input: string, name: string, schema: unknown): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Reading practice needs OPENAI_API_KEY in the server environment.");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: READING_MODEL, reasoning: { effort: "high" }, store: false,
        max_output_tokens: 16000, instructions, input,
        text: { format: { type: "json_schema", name, strict: true, schema } } }),
      signal: AbortSignal.timeout(240000),
    });
  } catch { throw new Error("OpenAI could not be reached. Your work is saved; retry when the connection returns."); }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("The server's OpenAI key cannot access Luna 6. Check the key and model access.");
    if (response.status === 429) {
      let error: { code?: string; type?: string } = {};
      try {
        const body = await response.json() as { error?: typeof error };
        error = body?.error ?? {};
      } catch { /* Never expose provider response bodies. */ }
      if (error.code === "credit_balance_exhausted") throw new Error("OpenAI API credits are exhausted. Add credits in the API billing settings, then retry. Your work is saved.");
      if (["organization_spend_limit_exceeded", "project_spend_limit_exceeded", "billing_hard_limit_reached"].includes(error.code ?? "")) throw new Error("An OpenAI API spending limit has been reached. Check the project and organization limits, then retry. Your work is saved.");
      if (error.code === "organization_usage_limit_exceeded") throw new Error("The OpenAI account's approved API usage limit has been reached. Request a higher limit or contact OpenAI support. Your work is saved.");
      if (error.code === "insufficient_quota" || error.type === "insufficient_quota") throw new Error("OpenAI API quota is unavailable. Check API credits and usage limits before retrying. Your work is saved.");
      throw new Error("OpenAI's temporary rate limit was reached. Your work is saved; try again later.");
    }
    throw new Error("OpenAI could not complete this exercise. Your work is saved; try again.");
  }
  let result: any;
  try { result = await response.json(); }
  catch { throw new Error("OpenAI returned an unreadable answer. Retry the exercise."); }
  if (result.status !== "completed") throw new Error("OpenAI returned an incomplete answer. Your work is saved; retry the exercise.");
  const content = (result.output ?? []).flatMap((item: any) => item.type === "message" ? item.content ?? [] : []);
  if (content.some((item: any) => item.type === "refusal")) throw new Error("OpenAI declined this exercise. Try again with another study session.");
  const output = content.filter((item: any) => item.type === "output_text").map((item: any) => item.text).join("");
  try { return JSON.parse(output); }
  catch { throw new Error("OpenAI returned an unreadable answer. Retry the exercise."); }
}
