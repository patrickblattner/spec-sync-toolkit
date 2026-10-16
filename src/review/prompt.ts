/**
 * The one built-in review prompt and the result schema (SST-DESIGN-030 §Prompt
 * and result). Both are TS constants because the package ships `dist` only — a
 * template file next to the source would not reach the consuming repo.
 *
 * Placeholders: REPO, MODE, RANGE, AREAS, FILES, DIFF, PRIOR.
 */

export const PROMPT_TEMPLATE = `You are a read-only code and security reviewer for the repository {{REPO}}.
You give a second opinion on one diff. You never edit files, never run commands that change anything, and never propose style changes.

Mode: {{MODE}}
Range: {{RANGE}}
Risk areas touched: {{AREAS}}

Rules:
- Read only. Do not write, format, install or commit anything.
- Report only findings CAUSED by this diff. Code outside the diff counts only where the diff breaks it.
- No style, naming, formatting or taste-of-wording findings. A design choice you would make differently is severity "taste", not a defect.
- Every finding needs evidence from the code: the file, the line and why it fails. An unproven suspicion is not a finding.
- critical and high need a concrete line (line >= 1) and a failure scenario (input or sequence -> wrong result). Without both, use medium.
- area is "code" or "security". severity is one of critical, high, medium, low, taste.
- Use the empty string for a field that has nothing to say, and line 0 when no line applies.
- An empty findings list is a valid and welcome result.
- In mode "recheck", look only at the prior findings listed below: for each, say whether the current code resolves it (recheck entries with the prior id), and return findings as an empty list. In any other mode, return recheck as an empty list.

Prior findings (recheck only):
{{PRIOR}}

Changed files:
{{FILES}}

Diff:
{{DIFF}}

Answer with exactly one JSON object matching the given output schema and nothing else.
`;

export interface PromptValues {
  REPO: string;
  MODE: string;
  RANGE: string;
  AREAS: string;
  FILES: string;
  DIFF: string;
  PRIOR: string;
}

/**
 * Fills the template. Values are inserted in one pass, so a diff that happens
 * to contain `{{PRIOR}}` is never substituted again.
 */
export function renderPrompt(values: PromptValues): string {
  return PROMPT_TEMPLATE.replace(/\{\{([A-Z]+)\}\}/g, (match, key: string) =>
    key in values ? values[key as keyof PromptValues] : match,
  );
}

const STRING = { type: "string" } as const;

/**
 * The result schema passed as `--output-schema`. Object root, every field
 * required, no extra properties — the strict shape structured output demands.
 */
export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "recheck"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "severity", "file", "line", "claim", "scenario", "evidence", "fix"],
        properties: {
          area: { type: "string", enum: ["code", "security"] },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "taste"] },
          file: STRING,
          line: { type: "integer" },
          claim: STRING,
          scenario: STRING,
          evidence: STRING,
          fix: STRING,
        },
      },
    },
    recheck: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "resolved", "note"],
        properties: {
          id: STRING,
          resolved: { type: "boolean" },
          note: STRING,
        },
      },
    },
  },
} as const;
