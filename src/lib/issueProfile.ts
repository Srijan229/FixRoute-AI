import type { GitHubIssue } from "./types.js";
import {
  classifyIssueResolution,
  type ImplementationScope,
  type ResolutionType,
  type WorkSurface,
} from "./resolutionType.js";

type IssueProfileInput = {
  title: string;
  body?: string | null;
  labels?: string[];
  comments?: Array<string | null | undefined>;
};

export type SemanticIssueProfile = {
  title: string;
  resolution_type: ResolutionType;
  requires_new_files: boolean;
  requires_existing_file_edits: boolean;
  likely_surface: WorkSurface[];
  implementation_scope: ImplementationScope;
  missing_capability: boolean;
  existing_behavior_broken: boolean;
  area_hints: string[];
  requested_behavior: string;
  reasoning: string;
  confidence: number;
  evidence_terms: string[];
  new_file_probability: number;
  existing_file_edit_probability: number;
  non_code_probability: number;
  problem: string;
  userAction: string;
  expectedBehavior: string;
  actualBehavior: string;
  errorMessages: string[];
  uiArea: string;
  mentionedFiles: string[];
  symbols: string[];
  componentHints: string[];
  environment: string[];
  semanticSummary: string;
};

const FILE_PATH_REGEX =
  /\b(?:src|extensions|build|test|scripts|resources|out)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;
const SYMBOL_REGEX =
  /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Service|Controller|Provider|Contribution|Widget|View|Pane|Editor|Model|Session|Tool|Action|Renderer|Part)\b/g;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\(([^)]+)\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^[>*-]\s+/gm, "")
    .replace(/\r/g, "");
}

function compactList(values: string[], limit: number): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean)),
  ).slice(0, limit);
}

function splitUsefulLines(text: string): string[] {
  return cleanMarkdown(text)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0 && line.length < 500);
}

function sectionAfterHeading(lines: string[], names: string[]): string {
  const loweredNames = names.map((name) => name.toLowerCase());
  const startIndex = lines.findIndex((line) => {
    const normalized = line.toLowerCase().replace(/:$/, "");
    return loweredNames.some((name) => normalized.includes(name));
  });

  if (startIndex === -1) {
    return "";
  }

  const selected: string[] = [];

  for (const line of lines.slice(startIndex + 1)) {
    if (/^(actual|expected|steps|repro|environment|error|logs?)\b/i.test(line)) {
      break;
    }

    selected.push(line);

    if (selected.length >= 4) {
      break;
    }
  }

  return normalizeWhitespace(selected.join(" "));
}

function extractErrorMessages(lines: string[]): string[] {
  return compactList(
    lines.filter((line) =>
      /\b(error|exception|failed|failure|crash|cannot|can't|unable|traceback|stack|e_[a-z0-9_]+)\b/i.test(
        line,
      ),
    ),
    8,
  );
}

function extractEnvironment(lines: string[]): string[] {
  return compactList(
    lines.filter((line) =>
      /\b(version|commit|os|platform|browser|electron|node|npm|insiders|stable|linux|macos|windows)\b/i.test(
        line,
      ),
    ),
    8,
  );
}

function inferUiArea(text: string, labels: string[]): string {
  const combined = `${text}\n${labels.join(" ")}`.toLowerCase();
  const areas: Array<[string, string[]]> = [
    ["Chat", ["chat", "copilot", "agent", "model picker", "prompt"]],
    ["Terminal", ["terminal", "shell", "pty", "task output"]],
    ["Editor", ["editor", "selection", "cursor", "snippet", "diff editor"]],
    ["Sessions", ["session", "account menu", "aquarium", "remote agent"]],
    ["Settings", ["setting", "configuration", "preference", "byok", "provider"]],
    ["Authentication", ["auth", "authentication", "sign in", "login", "token"]],
    ["Extensions", ["extension", "marketplace", "builtin extension"]],
    ["WorkbenchLayout", ["title bar", "activity bar", "sidebar", "panel", "layout"]],
    ["Search", ["search", "ripgrep", "find in files"]],
    ["Notebook", ["notebook", "cell", "jupyter"]],
    ["Debug", ["debug", "breakpoint", "debugger"]],
  ];

  const match = areas.find(([, tokens]) =>
    tokens.some((token) => combined.includes(token)),
  );

  return match?.[0] || "Unknown";
}

function extractComponentHints(labels: string[], uiArea: string): string[] {
  return compactList(
    [
      uiArea !== "Unknown" ? uiArea : "",
      ...labels.filter((label) =>
        /\b(chat|terminal|editor|session|setting|auth|extension|workbench|debug|search|notebook|bug|feature)\b/i.test(
          label,
        ),
      ),
    ],
    12,
  );
}

function extractMentionedFiles(text: string): string[] {
  return compactList(text.match(FILE_PATH_REGEX) || [], 20);
}

function extractSymbols(text: string): string[] {
  return compactList(text.match(SYMBOL_REGEX) || [], 20);
}

function firstUsefulText(title: string, lines: string[]): string {
  const titleText = normalizeWhitespace(title);
  const bodyText = normalizeWhitespace(
    lines
      .filter(
        (line) =>
          !/^(actual|expected|steps|repro|environment|error|logs?)\b/i.test(
            line,
          ),
      )
      .slice(0, 5)
      .join(" "),
  );

  return normalizeWhitespace([titleText, bodyText].filter(Boolean).join(" "));
}

export function buildSemanticIssueProfile(
  input: IssueProfileInput,
): SemanticIssueProfile {
  const title = normalizeWhitespace(input.title);
  const labels = input.labels || [];
  const body = input.body || "";
  const comments = (input.comments || []).filter(Boolean).join("\n");
  const fullText = [title, body, comments].filter(Boolean).join("\n\n");
  const lines = splitUsefulLines(fullText);
  const problem = firstUsefulText(title, lines);
  const userAction =
    sectionAfterHeading(lines, ["steps to reproduce", "repro", "steps"]) ||
    normalizeWhitespace(
      lines
        .filter((line) =>
          /\b(when|after|click|open|run|type|select|press|try|use)\b/i.test(
            line,
          ),
        )
        .slice(0, 4)
        .join(" "),
    );
  const expectedBehavior = sectionAfterHeading(lines, [
    "expected",
    "expected behavior",
  ]);
  const actualBehavior =
    sectionAfterHeading(lines, ["actual", "actual behavior"]) ||
    normalizeWhitespace(lines.slice(0, 4).join(" "));
  const errorMessages = extractErrorMessages(lines);
  const environment = extractEnvironment(lines);
  const mentionedFiles = extractMentionedFiles(fullText);
  const symbols = extractSymbols(fullText);
  const uiArea = inferUiArea(fullText, labels);
  const componentHints = extractComponentHints(labels, uiArea);
  const resolution = classifyIssueResolution({
    title,
    body,
    labels,
  });
  const semanticSummary = normalizeWhitespace(
    [
      `Problem: ${problem}`,
      userAction ? `Action: ${userAction}` : "",
      actualBehavior ? `Actual: ${actualBehavior}` : "",
      expectedBehavior ? `Expected: ${expectedBehavior}` : "",
      errorMessages.length > 0 ? `Errors: ${errorMessages.join(" | ")}` : "",
      uiArea !== "Unknown" ? `Area: ${uiArea}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  return {
    title,
    resolution_type: resolution.resolution_type,
    requires_new_files: resolution.requires_new_files,
    requires_existing_file_edits: resolution.requires_existing_file_edits,
    likely_surface: resolution.likely_surface,
    implementation_scope: resolution.implementation_scope,
    missing_capability: resolution.missing_capability,
    existing_behavior_broken: resolution.existing_behavior_broken,
    area_hints: uiArea !== "Unknown" ? [uiArea] : [],
    requested_behavior: expectedBehavior || userAction,
    reasoning: resolution.reasoning,
    confidence: resolution.confidence,
    evidence_terms: resolution.evidence_terms,
    new_file_probability: resolution.new_file_probability,
    existing_file_edit_probability: resolution.existing_file_edit_probability,
    non_code_probability: resolution.non_code_probability,
    problem,
    userAction,
    expectedBehavior,
    actualBehavior,
    errorMessages,
    uiArea,
    mentionedFiles,
    symbols,
    componentHints,
    environment,
    semanticSummary,
  };
}

export function buildSemanticIssueProfileFromIssue(
  issue: GitHubIssue,
  comments: Array<string | null | undefined> = [],
): SemanticIssueProfile {
  return buildSemanticIssueProfile({
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((label) => label.name),
    comments,
  });
}

function field(name: string, value: string | string[]): string {
  const rendered = Array.isArray(value) ? value.join("; ") : value;
  return `${name}: ${rendered || "unknown"}`;
}

export function formatSemanticIssueProfile(profile: SemanticIssueProfile): string {
  return [
    field("Title", profile.title),
    field("Resolution Type", profile.resolution_type),
    field("Requires New Files", String(profile.requires_new_files)),
    field(
      "Requires Existing File Edits",
      String(profile.requires_existing_file_edits),
    ),
    field("Likely Surface", profile.likely_surface),
    field("Implementation Scope", profile.implementation_scope),
    field("Missing Capability", String(profile.missing_capability)),
    field("Existing Behavior Broken", String(profile.existing_behavior_broken)),
    field("Area Hints", profile.area_hints),
    field("Requested Behavior", profile.requested_behavior),
    field("Resolution Reasoning", profile.reasoning),
    field("Resolution Evidence Terms", profile.evidence_terms),
    field("Resolution Confidence", String(profile.confidence)),
    field("Problem/Symptom", profile.problem),
    field("User Action", profile.userAction),
    field("Expected Behavior", profile.expectedBehavior),
    field("Actual Behavior", profile.actualBehavior),
    field("Error Messages", profile.errorMessages),
    field("UI Area", profile.uiArea),
    field("Mentioned Files", profile.mentionedFiles),
    field("Mentioned Symbols", profile.symbols),
    field("Component Hints", profile.componentHints),
    field("Environment", profile.environment),
    field("Semantic Summary", profile.semanticSummary),
  ].join("\n");
}

export function buildCanonicalIssueText(input: IssueProfileInput): string {
  return formatSemanticIssueProfile(buildSemanticIssueProfile(input));
}
