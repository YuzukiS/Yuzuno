// Core's result validator. One request per line on stdin, {id, spec}, or
// {id, op:"briefSection", section, previousBody?} for a Project Brief; one
// answer per line on stdout, in order. Stateless: Core may stop it at any
// time and start another. result-validator.mjs bundles this with the
// contract and zod into runtimes/result-validator/validator.mjs, which
// imports nothing at run time but Node's own modules.
// previousBody is trusted Core context for block edits only, never an
// Agent-supplied field of brief_update or the section.
import { createInterface } from "node:readline";
import { checkResultSpec, ResultError, SCHEMA_VERSION } from "../src/intelligent-ui/contract.ts";
import { clarificationMessage, clarificationSchema } from "../src/intelligent-ui/clarification.ts";
import { BRIEF_SCHEMA_VERSION, BriefError, checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";

/** One `put` envelope, without its op: normalized, or the problems an Agent fixes. */
function briefSection(id, section, previousBody) {
  try {
    return { id, ok: true, schemaVersion: BRIEF_SCHEMA_VERSION, normalized: checkBriefSection(section, previousBody) };
  } catch (error) {
    if (error instanceof BriefError) return { id, ok: false, schemaVersion: BRIEF_SCHEMA_VERSION, problems: error.problems };
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

function answer(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return { id: null, error: "unreadable request" };
  }
  const id = request?.id ?? null;
  if (request?.op === "briefSection") return briefSection(id, request.section, request.previousBody);
  if (request?.op !== undefined) return { id, error: "unknown op" };
  try {
    const { spec, defaults } = checkResultSpec(request?.spec);
    if (request.clarification) {
      const answer = request.clarification;
      const node = Object.values(spec.elements).find((node) => node.type === "Clarification" && node.props.id === answer.formId);
      if (!node || typeof answer.resultId !== "string" || answer.resultId.length > 100)
        throw new ResultError("invalid_form", "The original form is missing.");
      const form = clarificationSchema.parse(node.props);
      try {
        return { id, ok: true, schemaVersion: SCHEMA_VERSION, text: clarificationMessage(answer.resultId, form, answer.answers) };
      } catch (error) {
        throw new ResultError("invalid_answers", error instanceof Error ? error.message : String(error));
      }
    }
    return { id, ok: true, schemaVersion: SCHEMA_VERSION, spec, defaults };
  } catch (error) {
    if (error instanceof ResultError) return { id, ok: false, schemaVersion: SCHEMA_VERSION, problems: error.problems };
    // A fault of the validator, never the Agent's: Core does not count it.
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line) process.stdout.write(`${JSON.stringify(answer(line))}\n`);
}
