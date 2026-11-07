// runtimes/result-validator/contract.json's text form (YN-22). A string of
// several lines is written as {"$lines": [...]}, one line per element, so
// that two changes to different lines of a guide merge as text instead of
// rewriting one long line; Core joins them back (results::contract_value).
// No other object in the contract has a single "$lines" key.

/** The committed text of a contract: two-space JSON with a final newline. */
export const stringifyContract = (contract) =>
  `${JSON.stringify(contract, (_key, value) => (typeof value === "string" && value.includes("\n") ? { $lines: value.split("\n") } : value), 2)}\n`;

const isLines = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
  Array.isArray(value.$lines) && value.$lines.every((line) => typeof line === "string");

/** The contract as describeContract() and describeBrief() return it. */
export const parseContract = (text) => JSON.parse(text, (_key, value) => (isLines(value) ? value.$lines.join("\n") : value));
