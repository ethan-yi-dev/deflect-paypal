export class AssessmentError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message);
    this.name = "AssessmentError";
  }
}

export function getAssessmentConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === "anyword") throw new AssessmentError("OPENAI_NOT_CONFIGURED", "Set OPENAI_API_KEY in .env.local, then restart the server to run Deflect assessment.", 503);
  const model = env.OPENAI_ASSESSMENT_MODEL?.trim() || "gpt-5.4-mini";
  const timeoutMs = Number(env.OPENAI_ASSESSMENT_TIMEOUT_MS || 120000);
  const topK = Number(env.ASSESSMENT_TOP_K || 6);
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000
      || !Number.isInteger(topK) || topK < 1 || topK > 20) {
    throw new AssessmentError("INVALID_ASSESSMENT_CONFIG", "Set a vision/Structured Outputs model, ASSESSMENT_TOP_K from 1 to 20, and an assessment timeout from 1000 to 300000 ms.", 503);
  }
  return { apiKey, model, timeoutMs, topK };
}
export type AssessmentConfig = ReturnType<typeof getAssessmentConfig>;
