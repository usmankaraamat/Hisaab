/* Gemini call for the enrichment pass.
 *
 * Raw REST rather than an SDK: this is one POST, it has to run unchanged on
 * Deno (Edge Function) and Node (the benchmark), and the Google SDK pulls in a
 * dependency tree that buys nothing for a single endpoint.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * @returns {Promise<{data: unknown, usage: object, model: string, ms: number}>}
 */
export async function callGemini({
  apiKey,
  model,
  system,
  prompt,
  schema,
  thinkingLevel = 'low',
  maxOutputTokens = 32000,
  signal,
}) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      maxOutputTokens,
      // Gemini 3 uses thinkingLevel; older 2.5 models use thinkingBudget and
      // ignore this, which is fine — they are not what we deploy.
      thinkingConfig: { thinkingLevel },
    },
  };

  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });
  const ms = Date.now() - started;

  const text = await res.text();
  if (!res.ok) {
    throw new GeminiError(`Gemini ${res.status}: ${text.slice(0, 400)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new GeminiError('Gemini returned a non-JSON envelope.');
  }

  const candidate = envelope.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && finish !== 'STOP') {
    // MAX_TOKENS here means the batch was too big, not that the model failed.
    throw new GeminiError(`Gemini stopped early: ${finish}`, { retryable: finish === 'MAX_TOKENS' });
  }

  // Skip thought parts; take the first part carrying answer text.
  const answer = (candidate?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!answer) throw new GeminiError('Gemini returned no text part.');

  let data;
  try {
    data = JSON.parse(answer);
  } catch {
    throw new GeminiError(`Gemini returned unparseable JSON: ${answer.slice(0, 200)}`);
  }

  return { data, usage: envelope.usageMetadata ?? {}, model: envelope.modelVersion ?? model, ms };
}
