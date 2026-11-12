// Which model writes the red-team cases. Two providers:
//  - anthropic: claude-haiku-5-5 through claudeJson(), so every call is checked against and
//    recorded in the shared dollar budget (NEAR_LLM_BUDGET_FILE / NEAR_LLM_BUDGET_USD).
//  - openai-compatible: any /chat/completions endpoint (OpenRouter, NVIDIA NIM, ...), chosen with
//    REDTEAM_BASE_URL + REDTEAM_API_KEY + REDTEAM_MODEL. Attacks written by a different model
//    family than the Claude judge make the held-out eval more independent. These calls are not
//    billed to the Claude budget, so they have their own hard call cap (REDTEAM_MAX_CALLS, default 80).
import { claudeJson, JUDGE_MODEL } from "../llm/judge.ts";

export interface GenResult {
  json: unknown;
  /** Dollars charged to the Claude budget (0 for other providers). */
  usd: number;
}

export interface GenProvider {
  /** "anthropic:claude-haiku-5-5" or "openai-compat:<model>". Recorded in every cached case. */
  id: string;
  complete(system: string, prompt: string, schema: object, maxTokens: number): Promise<GenResult>;
}

export class CallCapExceeded extends Error {
  name = "CallCapExceeded";
}

export function anthropicProvider(): GenProvider {
  return {
    id: `anthropic:${JUDGE_MODEL}`,
    async complete(system, prompt, schema, maxTokens) {
      const r = await claudeJson(system, prompt, schema, maxTokens);
      return { json: r.json, usd: r.usd };
    },
  };
}

/** Pulls the first JSON object out of a chat reply (free endpoints often wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Reply text from a chat completion, streamed (server-sent events) or plain JSON. */
export async function readContent(res: Response): Promise<string> {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }
  let out = "";
  for (const line of (await res.text()).split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    try {
      out += (JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta?.content ?? "";
    } catch {
      /* keep-alive or partial line */
    }
  }
  return out;
}

export function openAICompatProvider(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxCalls?: number;
  fetchImpl?: typeof fetch;
  /** Retries on 429 / 5xx / network errors, with exponential backoff from backoffMs. */
  retries?: number;
  backoffMs?: number;
}): GenProvider {
  let calls = 0;
  const maxCalls = opts.maxCalls ?? 80;
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 5;
  const backoff = opts.backoffMs ?? 3000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    id: `openai-compat:${opts.model}`,
    async complete(system, prompt, schema, maxTokens) {
      const post = () =>
        f(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: maxTokens,
            // Streamed so headers arrive at once: reasoning models on free endpoints can take longer
            // than fetch's 300 s header timeout to finish a large batch.
            stream: true,
            messages: [
              { role: "system", content: `${system}\n\nReply with one JSON object only, matching this JSON schema:\n${JSON.stringify(schema)}` },
              { role: "user", content: prompt },
            ],
          }),
        });
      let res: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        // Every HTTP request counts toward the cap, retries included.
        if (calls >= maxCalls) throw new CallCapExceeded(`red-team generator call cap ${maxCalls} reached`);
        calls++;
        try {
          res = await post();
        } catch (e) {
          if (attempt >= retries) throw e;
          await sleep(backoff * 2 ** attempt);
          continue;
        }
        if (res.ok || !(res.status === 429 || res.status >= 500) || attempt >= retries) break;
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff * 2 ** attempt);
      }
      if (!res!.ok) throw new Error(`generator endpoint returned ${res!.status}`);
      return { json: extractJson(await readContent(res!)), usd: 0 };
    },
  };
}

/** Provider from the environment: REDTEAM_BASE_URL selects an OpenAI-compatible endpoint, else Claude. */
export function providerFromEnv(env = process.env): GenProvider | undefined {
  if (env.REDTEAM_BASE_URL) {
    if (!env.REDTEAM_API_KEY || !env.REDTEAM_MODEL) throw new Error("REDTEAM_BASE_URL needs REDTEAM_API_KEY and REDTEAM_MODEL");
    return openAICompatProvider({ baseUrl: env.REDTEAM_BASE_URL, apiKey: env.REDTEAM_API_KEY, model: env.REDTEAM_MODEL, maxCalls: Number(env.REDTEAM_MAX_CALLS ?? 80) });
  }
  if (env.ANTHROPIC_API_KEY) return anthropicProvider();
  return undefined;
}
