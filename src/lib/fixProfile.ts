import { mapFilePathToComponent } from "./componentMapper.js";
import { getPathQuality } from "./pathQuality.js";
import type {
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  PatchHunk,
  PullRequestCommit,
  PullRequestFile,
} from "./types.js";

type FixProfileInput = {
  pullRequest: GitHubPullRequest;
  files: PullRequestFile[];
  commits?: PullRequestCommit[];
  reviews?: GitHubPullRequestReview[];
  reviewComments?: GitHubPullRequestReviewComment[];
  patchHunks?: PatchHunk[];
};

export type SemanticFixProfile = {
  title: string;
  fixIntent: string;
  changedBehavior: string;
  primaryFiles: string[];
  primaryAreas: string[];
  components: string[];
  touchedSymbols: string[];
  testsChanged: string[];
  configFiles: string[];
  reviewSignals: string[];
  patchSummary: string;
};

const SYMBOL_REGEX =
  /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Service|Controller|Provider|Contribution|Widget|View|Pane|Editor|Model|Session|Tool|Action|Renderer|Part)\b/g;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactList(values: string[], limit: number): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean)),
  ).slice(0, limit);
}

function impactAreaForFile(filePath: string): string {
  const parts = filePath.split("/");

  if (parts.length <= 2) {
    return parts[0] || filePath;
  }

  if (filePath.startsWith("src/vs/workbench/contrib/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 7)).join("/");
  }

  if (filePath.startsWith("src/vs/platform/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 6)).join("/");
  }

  if (filePath.startsWith("src/vs/editor/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 6)).join("/");
  }

  if (filePath.startsWith("src/vs/sessions/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 6)).join("/");
  }

  if (filePath.startsWith("extensions/") && parts.length >= 4) {
    return parts.slice(0, Math.min(parts.length - 1, 5)).join("/");
  }

  return parts.slice(0, Math.min(parts.length - 1, 4)).join("/") || filePath;
}

function scoreFile(file: PullRequestFile): number {
  const quality = getPathQuality(file.filename);
  let score = quality.score * 100;

  if (quality.includeInFocusedEvaluation) {
    score += 25;
  }

  if (file.status === "modified") {
    score += 10;
  }

  if (file.status === "added") {
    score -= 8;
  }

  score += Math.min(file.changes || 0, 80) / 10;

  return score;
}

function extractChangedBehavior(input: FixProfileInput): string {
  const text = [
    input.pullRequest.body || "",
    ...(input.commits || []).map((commit) => commit.commit.message),
  ].join("\n");
  const usefulLines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(
      (line) =>
        line.length > 0 &&
        line.length < 240 &&
        /\b(fix|add|remove|update|change|support|prevent|avoid|handle|enable|disable|correct)\b/i.test(
          line,
        ),
    );

  return normalizeWhitespace(usefulLines.slice(0, 5).join(" "));
}

export function buildSemanticFixProfile(
  input: FixProfileInput,
): SemanticFixProfile {
  const primaryFiles = [...input.files]
    .sort((left, right) => scoreFile(right) - scoreFile(left))
    .map((file) => file.filename)
    .slice(0, 12);
  const primaryAreas = compactList(primaryFiles.map(impactAreaForFile), 10);
  const components = compactList(primaryFiles.map(mapFilePathToComponent), 8);
  const testsChanged = input.files
    .map((file) => file.filename)
    .filter((filePath) => getPathQuality(filePath).category === "test")
    .slice(0, 10);
  const configFiles = input.files
    .map((file) => file.filename)
    .filter((filePath) => getPathQuality(filePath).category === "config")
    .slice(0, 10);
  const patchText = (input.patchHunks || [])
    .slice(0, 30)
    .map((hunk) => hunk.patchText)
    .join("\n");
  const touchedSymbols = compactList(patchText.match(SYMBOL_REGEX) || [], 20);
  const reviewSignals = compactList(
    [
      ...(input.reviews || []).map((review) => review.body || ""),
      ...(input.reviewComments || []).map((comment) => comment.body || ""),
    ]
      .join("\n")
      .split(/\r?\n/)
      .filter((line) =>
        /\b(component|area|file|bug|fix|regression|test|behavior|should|expected)\b/i.test(
          line,
        ),
      ),
    10,
  );
  const changedBehavior = extractChangedBehavior(input);
  const patchSummary = normalizeWhitespace(
    [
      `Changed ${input.files.length} files`,
      primaryAreas.length > 0 ? `areas ${primaryAreas.join(", ")}` : "",
      components.length > 0 ? `components ${components.join(", ")}` : "",
      testsChanged.length > 0 ? `tests ${testsChanged.length}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );

  return {
    title: input.pullRequest.title,
    fixIntent: normalizeWhitespace(
      [input.pullRequest.title, changedBehavior].filter(Boolean).join(" "),
    ),
    changedBehavior,
    primaryFiles,
    primaryAreas,
    components,
    touchedSymbols,
    testsChanged,
    configFiles,
    reviewSignals,
    patchSummary,
  };
}

function field(name: string, value: string | string[]): string {
  const rendered = Array.isArray(value) ? value.join("; ") : value;
  return `${name}: ${rendered || "unknown"}`;
}

export function formatSemanticFixProfile(profile: SemanticFixProfile): string {
  return [
    field("Fix Intent", profile.fixIntent),
    field("Changed Behavior", profile.changedBehavior),
    field("Primary Files", profile.primaryFiles),
    field("Primary Areas", profile.primaryAreas),
    field("Components", profile.components),
    field("Touched Symbols", profile.touchedSymbols),
    field("Tests Changed", profile.testsChanged),
    field("Config Files", profile.configFiles),
    field("Review Signals", profile.reviewSignals),
    field("Patch Summary", profile.patchSummary),
  ].join("\n");
}

export { impactAreaForFile };
