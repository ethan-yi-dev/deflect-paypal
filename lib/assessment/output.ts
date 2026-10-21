import { AssessmentError } from "./config";
import type { AssessmentAction, AssessmentSource, CaseAssessment } from "./types";

type JsonSchema = Record<string, unknown>;
const text: JsonSchema = { type: "string", minLength: 1, maxLength: 4000 };
const strings: JsonSchema = { type: "array", items: text, maxItems: 20 };
const sourceIds: JsonSchema = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 };
function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const statement = object({ text, sourceIds });
const statements: JsonSchema = { type: "array", items: statement, maxItems: 20 };

export function assessmentSchema(allowedActions: AssessmentAction[]) {
  return object({
    summary: statement, buyerClaim: statement, supportedFacts: statements, supportingEvidence: statements,
    conflictingEvidence: statements, applicablePolicies: statements,
    missingEvidence: { type: "array", maxItems: 20, items: object({ item: text, why: text, priority: { type: "string", enum: ["high", "medium", "low"] }, sourceIds }) },
    uncertainties: strings,
    recommendation: object({ action: { type: "string", enum: allowedActions }, title: text,
      rationale: { ...statements, minItems: 1 }, responseDraft: statements, reconsiderWhen: strings }),
  });
}

// Validate the provider payload independently of its schema guarantee, including references
// and case-specific actions. A real citation ID does not itself establish factual entailment.
export function validateAssessment(value: unknown, sources: AssessmentSource[], allowedActions: AssessmentAction[]): CaseAssessment {
  const known = new Map(sources.map((source) => [source.id, source]));
  function fail(): never { throw new AssessmentError("INVALID_ASSESSMENT_RESPONSE", "The assessment contained invalid fields, citations, or an unavailable action. Run the assessment again.", 502); }
  function record(input: unknown, keys: string[]): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) fail();
    return input as Record<string, unknown>;
  }
  function string(input: unknown): asserts input is string { if (typeof input !== "string" || !input.trim() || input.length > 4000) fail(); }
  function refs(input: unknown): asserts input is string[] {
    if (!Array.isArray(input) || !input.length || input.length > 20 || input.some((id) => typeof id !== "string" || !known.has(id)) || new Set(input).size !== input.length) fail();
  }
  function cited(input: unknown) {
    const item = record(input, ["text", "sourceIds"]);
    string(item.text); refs(item.sourceIds);
  }
  function array(input: unknown): unknown[] { if (!Array.isArray(input) || input.length > 20) fail(); return input; }
  const result = record(value, ["summary", "buyerClaim", "supportedFacts", "supportingEvidence", "conflictingEvidence", "applicablePolicies", "missingEvidence", "uncertainties", "recommendation"]);
  cited(result.summary); cited(result.buyerClaim);
  for (const key of ["supportedFacts", "supportingEvidence", "conflictingEvidence", "applicablePolicies"]) array(result[key]).forEach(cited);
  for (const policy of result.applicablePolicies as { sourceIds: string[] }[]) {
    if (!policy.sourceIds.some((id) => known.get(id)?.kind === "policy")) fail();
  }
  array(result.missingEvidence).forEach((input) => {
    const item = record(input, ["item", "why", "priority", "sourceIds"]);
    string(item.item); string(item.why); refs(item.sourceIds);
    if (!["high", "medium", "low"].includes(String(item.priority))) fail();
  });
  array(result.uncertainties).forEach(string);
  const recommendation = record(result.recommendation, ["action", "title", "rationale", "responseDraft", "reconsiderWhen"]);
  if (!allowedActions.includes(recommendation.action as AssessmentAction)) fail();
  string(recommendation.title);
  const rationale = array(recommendation.rationale);
  if (!rationale.length) fail();
  rationale.forEach(cited);
  array(recommendation.responseDraft).forEach(cited);
  array(recommendation.reconsiderWhen).forEach(string);
  return value as CaseAssessment;
}
