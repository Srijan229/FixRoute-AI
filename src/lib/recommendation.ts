import {
  createEmbeddingProvider,
  cosineSimilarity,
  loadCodeSemanticIndex,
  loadEmbeddingIndex,
  loadRichSemanticIndex,
} from "./embeddings.js";
import { fetchIssueEvidence } from "./graphQueries.js";
import { mapFilePathToComponent } from "./componentMapper.js";
import { getPathQuality } from "./pathQuality.js";
import {
  buildCanonicalIssueText,
  buildSemanticIssueProfile,
} from "./issueProfile.js";
import { bm25Search, reciprocalRankFusion } from "./bm25.js";
import type {
  QueryIssueResult,
  RecommendationResult,
  RichSemanticRecord,
} from "./types.js";

type RankedCandidate = {
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
};

type SimilarTicketCandidate = {
  candidate: RankedCandidate;
  similarityScore: number;
};

type RichSemanticMatch = {
  record: RichSemanticRecord;
  score: number;
};

type CodeSemanticMatch = {
  record: RichSemanticRecord;
  score: number;
};

type RecommendationMode =
  | "bug_localization"
  | "feature_planning"
  | "enhancement_planning"
  | "specialized_routing"
  | "general_triage";

export type RecommendationInput = {
  title: string;
  description?: string;
  topK?: number;
};

function inferTicketType(title: string, description: string): string {
  const combined = `${title}\n${description}`.toLowerCase();

  if (
    combined.includes("bug") ||
    combined.includes("error") ||
    combined.includes("crash") ||
    combined.includes("cannot")
  ) {
    return "bug";
  }

  if (combined.includes("feature") || combined.includes("enhancement")) {
    return "enhancement";
  }

  if (combined.includes("story")) {
    return "story";
  }

  if (combined.includes("task")) {
    return "task";
  }

  if (combined.includes("how") || combined.includes("question")) {
    return "question";
  }

  return "unknown";
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_./-]+/g) || []).filter(
    (token) => token.length >= 3,
  );
}

function keywordScore(queryText: string, candidateText: string): number {
  const queryTokens = Array.from(new Set(tokenize(queryText)));
  const candidateTokens = new Set(tokenize(candidateText));

  if (queryTokens.length === 0) {
    return 0;
  }

  const matches = queryTokens.filter((token) =>
    candidateTokens.has(token),
  ).length;
  return matches / queryTokens.length;
}

function jaccardScore(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function filePathRelevanceScore(
  queryText: string,
  filePath: string,
  component: string,
): number {
  const queryTokens = Array.from(new Set(tokenize(queryText)));
  const pathTokens = new Set(tokenize(filePath));
  const componentTokens = new Set(tokenize(component));

  if (queryTokens.length === 0) {
    return 0;
  }

  let score = 0;

  for (const token of queryTokens) {
    if (pathTokens.has(token)) {
      score += 1.2;
    } else if (
      Array.from(pathTokens).some(
        (pathToken) => pathToken.includes(token) || token.includes(pathToken),
      )
    ) {
      score += 0.5;
    }

    if (componentTokens.has(token)) {
      score += 0.8;
    }
  }

  return score / queryTokens.length;
}

function genericFilePenalty(filePath: string): number {
  const quality = getPathQuality(filePath);
  const normalizedPath = filePath.toLowerCase();
  let penalty = quality.score;

  if (normalizedPath.endsWith("/chat.contribution.ts")) {
    penalty *= 0.45;
  }

  if (normalizedPath.endsWith("/constants.ts")) {
    penalty *= 0.65;
  }

  if (normalizedPath.endsWith("/runsubagenttool.ts")) {
    penalty *= 0.4;
  }

  if (normalizedPath.endsWith("/chatterminaltoolprogresspart.ts")) {
    penalty *= 0.5;
  }

  if (normalizedPath.endsWith("/terminalinstance.ts")) {
    penalty *= 0.7;
  }

  if (normalizedPath.endsWith("/extensioneditor.ts")) {
    penalty *= 0.7;
  }

  return penalty;
}

function pathFamilyBoost(
  queryText: string,
  filePath: string,
  component: string,
): number {
  const text = queryText.toLowerCase();
  const normalizedPath = filePath.toLowerCase();
  let boost = 1;

  const hasAny = (tokens: string[]) =>
    tokens.some((token) => text.includes(token));

  if (
    hasAny([
      "session",
      "account menu",
      "aquarium",
      "agent feedback",
      "copilot chat session",
      "title bar",
    ]) &&
    (normalizedPath.includes("src/vs/sessions/") || component === "Sessions")
  ) {
    boost *= 1.9;
  }

  if (
    hasAny(["authentication", "auth", "token", "sign in", "login", "access"]) &&
    (normalizedPath.includes("/authentication/") ||
      normalizedPath.includes("copilottoken") ||
      component === "Authentication")
  ) {
    boost *= 1.9;
  }

  if (
    hasAny([
      "setting",
      "settings",
      "configuration",
      "provider",
      "endpoint",
      "byok",
      "model",
    ]) &&
    (normalizedPath.includes("configuration") ||
      normalizedPath.includes("settings") ||
      component === "Settings")
  ) {
    boost *= 1.75;
  }

  if (
    hasAny(["issue reporter", "report issue", "issue report"]) &&
    (normalizedPath.includes("/contrib/issue/") ||
      normalizedPath.includes("issuereporter") ||
      component === "IssueReporter")
  ) {
    boost *= 2;
  }

  if (
    hasAny(["welcome", "getting started", "onboarding"]) &&
    (normalizedPath.includes("welcomegettingstarted") ||
      normalizedPath.includes("gettingstarted") ||
      component === "GettingStarted")
  ) {
    boost *= 2;
  }

  if (
    hasAny(["task", "tasks", "task output"]) &&
    (normalizedPath.includes("/tasks/") ||
      normalizedPath.includes("taskservice") ||
      component === "Tasks")
  ) {
    boost *= 1.7;
  }

  if (
    hasAny(["search", "ignore file", "ripgrep"]) &&
    (normalizedPath.includes("/search/") ||
      normalizedPath.includes("ignorefile") ||
      component === "Search")
  ) {
    boost *= 1.7;
  }

  if (
    hasAny([
      "terminal",
      "shell",
      "pty",
      "osc 8",
      "output monitor",
      "run in terminal",
    ]) &&
    (normalizedPath.includes("/terminal/") ||
      normalizedPath.includes("terminalcontrib") ||
      component === "Terminal")
  ) {
    boost *= 1.5;
  }

  if (
    hasAny(["extension", "enablement", "marketplace", "profile"]) &&
    (normalizedPath.includes("/extension") ||
      normalizedPath.includes("extensionmanagement") ||
      component === "Extensions")
  ) {
    boost *= 1.6;
  }

  return boost;
}

function componentPathAffinityScore(
  component: string,
  filePath: string,
): number {
  const normalizedPath = filePath.toLowerCase();

  if (component === "Chat") {
    let score = 1;

    if (normalizedPath.includes("/workbench/contrib/chat/")) {
      score += 1.8;
    }

    if (
      normalizedPath.includes("/common/chats") ||
      normalizedPath.includes("/common/chat")
    ) {
      score += 1.5;
    }

    if (
      normalizedPath.includes("/browser/widget/") ||
      normalizedPath.includes("/browser/agentsessions/")
    ) {
      score += 1.25;
    }

    if (
      normalizedPath.includes("chatservice") ||
      normalizedPath.includes("chatmodel") ||
      normalizedPath.includes("chatagents")
    ) {
      score += 1.25;
    }

    if (normalizedPath.includes("/aicustomization/")) {
      score -= 0.75;
    }

    if (normalizedPath.includes("/terminalcontrib/")) {
      score -= 1.4;
    }

    if (normalizedPath.includes("/extensions/copilot/")) {
      score -= 1.1;
    }

    if (normalizedPath.includes("/test/")) {
      score -= 0.35;
    }

    return Math.max(0.2, score);
  }

  if (component === "Terminal") {
    let score = 1;

    if (normalizedPath.includes("/workbench/contrib/terminal")) {
      score += 1.4;
    }

    if (normalizedPath.includes("/terminalcontrib/chatagenttools/")) {
      score += 0.4;
    }

    if (normalizedPath.includes("/test/")) {
      score -= 0.3;
    }

    return Math.max(0.2, score);
  }

  if (component === "Sessions") {
    let score = 1;

    if (normalizedPath.includes("/src/vs/sessions/")) {
      score += 1.8;
    }

    if (
      normalizedPath.includes("/contrib/sessions/") ||
      normalizedPath.includes("/contrib/accountmenu/")
    ) {
      score += 1.1;
    }

    if (
      normalizedPath.includes("session") ||
      normalizedPath.includes("accountmenu") ||
      normalizedPath.includes("aquarium")
    ) {
      score += 0.75;
    }

    if (normalizedPath.includes("/workbench/contrib/chat/")) {
      score -= 0.5;
    }

    return Math.max(0.2, score);
  }

  if (component === "Editor") {
    let score = 1;

    if (normalizedPath.includes("/src/vs/editor/")) {
      score += 1.6;
    }

    if (
      normalizedPath.includes("/snippet/") ||
      normalizedPath.includes("snippetsession")
    ) {
      score += 1.2;
    }

    if (normalizedPath.includes("/test/")) {
      score -= 0.25;
    }

    return Math.max(0.2, score);
  }

  if (component === "Search") {
    let score = 1;

    if (normalizedPath.includes("/search/")) {
      score += 1.8;
    }

    if (
      normalizedPath.includes("ignorefile") ||
      normalizedPath.includes("ripgrep")
    ) {
      score += 1.2;
    }

    return Math.max(0.2, score);
  }

  if (component === "Settings") {
    let score = 1;

    if (
      normalizedPath.includes("configuration") ||
      normalizedPath.includes("settings")
    ) {
      score += 1.5;
    }

    if (normalizedPath.includes("/extensions/copilot/")) {
      score += 0.5;
    }

    return Math.max(0.2, score);
  }

  if (component === "Extensions") {
    let score = 1;

    if (normalizedPath.includes("/extension")) {
      score += 1.4;
    }

    if (
      normalizedPath.includes("extensionenablement") ||
      normalizedPath.includes("extensionmanagement")
    ) {
      score += 1.1;
    }

    return Math.max(0.2, score);
  }

  if (component === "Authentication") {
    let score = 1;

    if (
      normalizedPath.includes("authentication") ||
      normalizedPath.includes("copilottoken")
    ) {
      score += 1.7;
    }

    return Math.max(0.2, score);
  }

  if (component === "Update") {
    let score = 1;

    if (
      normalizedPath.includes("/update/") ||
      normalizedPath.includes("updateservice")
    ) {
      score += 1.6;
    }

    return Math.max(0.2, score);
  }

  if (component === "Tasks") {
    let score = 1;

    if (
      normalizedPath.includes("/tasks/") ||
      normalizedPath.includes("taskservice")
    ) {
      score += 1.6;
    }

    return Math.max(0.2, score);
  }

  return 1;
}

function componentQueryAffinityScore(
  component: string,
  title: string,
  description: string,
): number {
  const titleText = title.toLowerCase();
  const descriptionText = description.toLowerCase();
  const combinedText = `${titleText}\n${descriptionText}`;
  let score = 1;

  if (component === "Chat") {
    if (titleText.includes("copilot")) {
      score += 1.8;
    }

    if (combinedText.includes("agent")) {
      score += 0.9;
    }

    if (combinedText.includes("chat")) {
      score += 0.8;
    }

    if (combinedText.includes("tool")) {
      score += 0.35;
    }

    if (combinedText.includes("task output")) {
      score += 0.4;
    }

    if (combinedText.includes("terminal") && !titleText.includes("terminal")) {
      score -= 0.15;
    }

    if (
      combinedText.includes("snippet") ||
      combinedText.includes("search") ||
      combinedText.includes("ignore file") ||
      combinedText.includes("profile") ||
      combinedText.includes("setting") ||
      combinedText.includes("settings") ||
      combinedText.includes("configuration") ||
      combinedText.includes("endpoint") ||
      combinedText.includes("provider") ||
      combinedText.includes("issue reporter") ||
      combinedText.includes("report issue") ||
      combinedText.includes("authentication") ||
      combinedText.includes("token") ||
      combinedText.includes("sign in") ||
      combinedText.includes("welcome") ||
      combinedText.includes("getting started") ||
      combinedText.includes("update service") ||
      combinedText.includes("installer") ||
      combinedText.includes("session list") ||
      combinedText.includes("account menu") ||
      combinedText.includes("aquarium") ||
      combinedText.includes("agent feedback")
    ) {
      score -= 1.2;
    }

    return Math.max(0.3, score);
  }

  if (component === "Terminal") {
    if (titleText.includes("terminal")) {
      score += 1.2;
    }

    if (combinedText.includes("terminal")) {
      score += 0.8;
    }

    if (combinedText.includes("task")) {
      score += 0.3;
    }

    if (titleText.includes("copilot")) {
      score -= 0.55;
    }

    if (combinedText.includes("agent")) {
      score -= 0.15;
    }

    return Math.max(0.3, score);
  }

  if (component === "Sessions") {
    if (combinedText.includes("session")) {
      score += 1.2;
    }

    if (
      combinedText.includes("account menu") ||
      combinedText.includes("aquarium")
    ) {
      score += 1.1;
    }

    if (
      combinedText.includes("agent feedback") ||
      combinedText.includes("copilot chat session")
    ) {
      score += 1.1;
    }

    if (
      combinedText.includes("remote agent host") ||
      combinedText.includes("title bar")
    ) {
      score += 0.9;
    }

    return Math.max(0.3, score);
  }

  if (component === "Editor") {
    if (combinedText.includes("snippet")) {
      score += 1.7;
    }

    if (
      combinedText.includes("inline edit") ||
      combinedText.includes("editor")
    ) {
      score += 0.8;
    }

    return Math.max(0.3, score);
  }

  if (component === "Search") {
    if (combinedText.includes("search")) {
      score += 1.6;
    }

    if (
      combinedText.includes("ignore file") ||
      combinedText.includes("ripgrep")
    ) {
      score += 1.3;
    }

    return Math.max(0.3, score);
  }

  if (component === "Settings") {
    if (
      combinedText.includes("setting") ||
      combinedText.includes("configuration")
    ) {
      score += 1.4;
    }

    if (
      combinedText.includes("endpoint") ||
      combinedText.includes("provider") ||
      combinedText.includes("model")
    ) {
      score += 1.1;
    }

    return Math.max(0.3, score);
  }

  if (component === "Extensions") {
    if (combinedText.includes("extension")) {
      score += 1.5;
    }

    if (
      combinedText.includes("enablement") ||
      combinedText.includes("marketplace") ||
      combinedText.includes("profile")
    ) {
      score += 1;
    }

    return Math.max(0.3, score);
  }

  if (component === "Authentication") {
    if (
      combinedText.includes("authentication") ||
      combinedText.includes("auth") ||
      combinedText.includes("token") ||
      combinedText.includes("login") ||
      combinedText.includes("sign in")
    ) {
      score += 1.7;
    }

    return Math.max(0.3, score);
  }

  if (component === "Update") {
    if (combinedText.includes("update")) {
      score += 1.2;
    }

    if (
      combinedText.includes("installer") ||
      combinedText.includes("win32") ||
      combinedText.includes("insider")
    ) {
      score += 1.2;
    }

    return Math.max(0.3, score);
  }

  if (component === "Tasks") {
    if (combinedText.includes("task")) {
      score += 1.2;
    }

    if (combinedText.includes("task output")) {
      score += 0.8;
    }

    return Math.max(0.3, score);
  }

  if (component === "GettingStarted") {
    if (
      combinedText.includes("welcome") ||
      combinedText.includes("getting started") ||
      combinedText.includes("onboarding")
    ) {
      score += 1.6;
    }

    return Math.max(0.3, score);
  }

  return 1;
}

function countBy<T extends string>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return counts;
}

function topKey(counts: Map<string, number>): string {
  let bestKey = "";
  let bestCount = -1;

  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  return bestKey;
}

function rankWeight(index: number): number {
  if (index === 0) return 1.75;
  if (index === 1) return 1.1;
  if (index === 2) return 0.85;
  return 0.65;
}

function normalizeInput(input: RecommendationInput) {
  const title = input.title.trim();
  const description = (input.description || "").trim();
  const topK = input.topK ?? 5;

  if (!title) {
    throw new Error("title is required");
  }

  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("topK must be a positive number");
  }

  return { title, description, topK };
}

function rerankEvidenceCandidate(
  queryText: string,
  queryTokens: string[],
  candidate: RankedCandidate,
  evidence: QueryIssueResult,
): number {
  const candidateLabelTokens = evidence.issue.labels.flatMap((label) =>
    tokenize(label),
  );
  const labelScore = jaccardScore(queryTokens, candidateLabelTokens);
  const candidateTextScore = keywordScore(
    queryText,
    `${evidence.issue.title}\n${candidate.title}`,
  );
  const componentNames = Array.from(
    new Set(
      evidence.likelyFiles
        .map((file) => file.component)
        .filter((component) => component !== "Unknown"),
    ),
  );
  const bestComponentQueryFit =
    componentNames.length > 0
      ? Math.max(
          ...componentNames.map((component) =>
            componentQueryAffinityScore(component, candidate.title, queryText),
          ),
        )
      : 1;
  const bestFileQueryFit =
    evidence.likelyFiles.length > 0
      ? Math.max(
          ...evidence.likelyFiles.map((file) =>
            filePathRelevanceScore(queryText, file.path, file.component),
          ),
        )
      : 0;
  const avgFileQueryFit =
    evidence.likelyFiles.length > 0
      ? evidence.likelyFiles.reduce(
          (sum, file) =>
            sum + filePathRelevanceScore(queryText, file.path, file.component),
          0,
        ) / evidence.likelyFiles.length
      : 0;
  const hasEvidenceBonus = evidence.linkedPullRequests.length > 0 ? 0.05 : 0;

  return (
    candidate.score * 0.6 +
    candidateTextScore * 0.15 +
    labelScore * 0.08 +
    bestFileQueryFit * 0.1 +
    avgFileQueryFit * 0.05 +
    Math.min(bestComponentQueryFit / 2.5, 0.12) +
    hasEvidenceBonus
  );
}

function loadOptionalRichSemanticMatches(
  queryVector: number[],
  limit: number,
): RichSemanticMatch[] {
  try {
    const index = loadRichSemanticIndex();

    if (
      index.records.length === 0 ||
      index.records[0].vector.length !== queryVector.length
    ) {
      return [];
    }

    return index.records
      .filter(
        (record) =>
          record.type === "pull_request" ||
          record.type === "implementation_pattern" ||
          record.type === "patch_hunk" ||
          record.type === "review_comment",
      )
      .filter((record) => {
        const qualityScore = record.metadata.pathQualityScore;
        return typeof qualityScore !== "number" || qualityScore >= 0.25;
      })
      .map((record) => ({
        record,
        score: cosineSimilarity(queryVector, record.vector),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function metadataList(
  value: string | number | boolean | null | undefined,
): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberMetadata(
  value: string | number | boolean | null | undefined,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  const hits = left.filter((value) => rightSet.has(value.toLowerCase())).length;
  return hits / Math.max(left.length, right.length);
}

function hasRegistryOrContributionFile(filePaths: string[]): boolean {
  return filePaths.some((filePath) =>
    /\b(contribution|registry|actions?|commands?|package\.json|menus?|configuration)\b/i.test(
      filePath,
    ),
  );
}

function scoreImplementationPatternMatch(input: {
  semanticScore: number;
  queryResolutionType: string;
  queryComponent: string;
  querySurfaces: string[];
  requiresNewFiles: boolean;
  record: RichSemanticRecord;
}): number {
  const patternResolutionType =
    typeof input.record.metadata.resolutionType === "string"
      ? input.record.metadata.resolutionType
      : "unknown";
  const components = metadataList(input.record.metadata.components);
  const surfaces = metadataList(input.record.metadata.surfaces);
  const createdFiles = metadataList(input.record.metadata.typicalFilesCreated);
  const modifiedFiles = metadataList(input.record.metadata.typicalFilesModified);
  const labelWeight = numberMetadata(input.record.metadata.labelWeight, 0.5);
  const createdFileCount = numberMetadata(
    input.record.metadata.createdFileCount,
    createdFiles.length,
  );
  const modifiedFileCount = numberMetadata(
    input.record.metadata.modifiedExistingFileCount,
    modifiedFiles.length,
  );
  const sameComponent =
    input.queryComponent !== "Unknown" &&
    components.includes(input.queryComponent)
      ? 0.28
      : 0;
  const surfaceFit = overlapScore(input.querySurfaces, surfaces) * 0.24;
  const createdShapeFit =
    input.requiresNewFiles === createdFileCount > 0 ? 0.18 : -0.12;
  const registryFit =
    hasRegistryOrContributionFile(modifiedFiles) &&
    input.querySurfaces.includes("ui")
      ? 0.12
      : 0;
  const resolutionFit =
    patternResolutionType === input.queryResolutionType
      ? 0.18
      : patternResolutionType === "unknown"
        ? 0
        : ["docs", "config", "test"].includes(patternResolutionType) &&
            input.queryResolutionType !== patternResolutionType
          ? -0.24
          : -0.08;
  const sizePenalty = Math.max(0.35, Math.min(1, labelWeight));
  const breadthPenalty =
    createdFileCount + modifiedFileCount > 12
      ? 0.82
      : createdFileCount + modifiedFileCount > 6
        ? 0.92
        : 1;

  return (
    (input.semanticScore * 0.58 +
      sameComponent +
      surfaceFit +
      createdShapeFit +
      registryFit +
      resolutionFit) *
    sizePenalty *
    breadthPenalty
  );
}

function modeForResolutionType(resolutionType: string): RecommendationMode {
  if (resolutionType === "existing_bug") return "bug_localization";
  if (resolutionType === "new_feature") return "feature_planning";
  if (
    resolutionType === "enhancement" ||
    resolutionType === "enhancement_with_new_files"
  ) {
    return "enhancement_planning";
  }

  if (
    resolutionType === "docs" ||
    resolutionType === "config" ||
    resolutionType === "test" ||
    resolutionType === "refactor"
  ) {
    return "specialized_routing";
  }

  return "general_triage";
}

function newFileNameFromQuery(queryText: string, suffix: string): string {
  const words = (queryText.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(
      (word) =>
        ![
          "add",
          "new",
          "support",
          "for",
          "the",
          "and",
          "with",
          "when",
          "issue",
          "feature",
          "allow",
          "users",
          "to",
        ].includes(word),
    )
    .slice(0, 4);
  const [first = "new", ...rest] = words;
  const stem = [
    first,
    ...rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)),
  ].join("");

  return `${stem || "newFeature"}${suffix}`;
}

function likelyNewFileSuggestions(input: {
  queryText: string;
  areas: Array<{ area_path: string; component: string }>;
  mode: RecommendationMode;
  targetComponent: string;
  newFileProbability: number;
}): Array<{ file_path: string; component: string; reason: string }> {
  if (
    input.newFileProbability < 0.35 ||
    (input.mode !== "feature_planning" &&
      input.mode !== "enhancement_planning" &&
      input.mode !== "specialized_routing" &&
      input.mode !== "general_triage")
  ) {
    return [];
  }

  const componentAreas = input.areas.filter(
    (area) => area.component === input.targetComponent,
  );
  const selectedAreas =
    componentAreas.length > 0 ? componentAreas : input.areas.slice(0, 1);

  return selectedAreas.slice(0, 3).flatMap((area) => {
    const baseName = newFileNameFromQuery(input.queryText, "");
    const sourceFile = `${area.area_path}/${baseName}.ts`;
    const testFile = `${area.area_path}/test/${baseName}.test.ts`;

    return [
      {
        file_path: sourceFile,
        component: area.component,
        reason:
          input.newFileProbability >= 0.7
            ? "Likely new implementation file based on new-file likelihood, target area, and naming conventions."
            : "Possible new implementation file based on target area and naming conventions.",
      },
      {
        file_path: testFile,
        component: area.component,
        reason:
          input.newFileProbability >= 0.7
            ? "Likely test file paired with the new implementation file."
            : "Possible test file paired with the implementation area.",
      },
    ];
  });
}

function implementationStepsForMode(mode: RecommendationMode): string[] {
  if (mode === "feature_planning") {
    return [
      "Inspect existing contribution, command, service, and UI registration patterns in the recommended area.",
      "Extend the closest existing entry point before creating new files.",
      "Create new implementation files only where the existing area lacks the requested capability.",
      "Add or update tests near the existing test conventions for that area.",
      "Validate behavior against similar historical implementation PRs.",
    ];
  }

  if (mode === "enhancement_planning") {
    return [
      "Inspect the current feature implementation and its tests.",
      "Extend the existing behavior with the smallest compatible change.",
      "Create a helper or new file only if the enhancement introduces a separable concept.",
      "Update tests to cover the newly supported case.",
    ];
  }

  if (mode === "specialized_routing") {
    return [
      "Confirm whether the change is docs, config, test, build, or refactor work.",
      "Inspect the matching file category in the recommended area.",
      "Keep implementation scope narrow unless related code changes are required.",
    ];
  }

  return [];
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

function outputGuidanceForMode(mode: RecommendationMode): string {
  if (mode === "feature_planning") {
    return "Use likely implementation areas, files to inspect, possible new files, and similar patterns. Not enough evidence for exact file prediction.";
  }

  if (mode === "enhancement_planning") {
    return "Use likely existing feature areas, files to extend, new-file likelihood, possible helper/test files, and similar enhancement patterns.";
  }

  if (mode === "bug_localization") {
    return "Use likely existing files as investigation starting points, not guaranteed bug locations.";
  }

  if (mode === "specialized_routing") {
    return "Use likely file categories and areas for docs/config/test/refactor routing.";
  }

  return "Routing is uncertain; treat all recommendations as candidate starting points for human review.";
}

function loadOptionalCodeSemanticMatches(
  queryVector: number[],
  limit: number,
): CodeSemanticMatch[] {
  try {
    const index = loadCodeSemanticIndex();

    if (
      index.records.length === 0 ||
      index.records[0].vector.length !== queryVector.length
    ) {
      return [];
    }

    return index.records
      .filter((record) => {
        if (!record.filePath) {
          return false;
        }

        return getPathQuality(record.filePath).includeInSemanticIndex;
      })
      .map((record) => ({
        record,
        score: cosineSimilarity(queryVector, record.vector),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function formatLineRange(record: RichSemanticRecord): string {
  const newStartLine = record.metadata.newStartLine;
  const newLineCount = record.metadata.newLineCount;
  const reviewLine = record.metadata.line;

  if (typeof newStartLine === "number" && typeof newLineCount === "number") {
    const endLine = newStartLine + Math.max(newLineCount - 1, 0);
    return newStartLine === endLine
      ? `line ${newStartLine}`
      : `lines ${newStartLine}-${endLine}`;
  }

  if (typeof reviewLine === "number") {
    return `line ${reviewLine}`;
  }

  return "line range unavailable";
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

export async function generateRecommendation(
  input: RecommendationInput,
): Promise<RecommendationResult> {
  const normalized = normalizeInput(input);
  const provider = createEmbeddingProvider();
  const embeddingIndex = loadEmbeddingIndex();
  const queryProfile = buildSemanticIssueProfile({
    title: normalized.title,
    body: normalized.description,
  });
  const mode = modeForResolutionType(queryProfile.resolution_type);
  const queryText = buildCanonicalIssueText({
    title: normalized.title,
    body: normalized.description,
  });
  const queryVector = await provider.embedOne(queryText);

  if (embeddingIndex.length === 0) {
    throw new Error("Embedding index is empty. Run create:embeddings first.");
  }

  if (embeddingIndex[0].vector.length !== queryVector.length) {
    throw new Error(
      `Embedding dimension mismatch. Rebuild the index with 'npm run create:embeddings -- --reset' for the current provider.`,
    );
  }

  const semanticCandidates = embeddingIndex
    .map((record) => ({
      record,
      score: cosineSimilarity(queryVector, record.vector),
    }))
    .sort((left, right) => right.score - left.score);
  const bm25Candidates = bm25Search(
    queryText,
    embeddingIndex.map((record) => ({
      id: record.issueNumber,
      text: record.text,
    })),
    Math.max(normalized.topK * 12, 60),
  );
  const semanticRankByIssue = new Map(
    semanticCandidates.map((candidate, index) => [
      candidate.record.issueNumber,
      index,
    ]),
  );
  const bm25ScoreByIssue = new Map(
    bm25Candidates.map((candidate) => [candidate.id, candidate.score]),
  );
  const fusedIssueNumbers = reciprocalRankFusion(
    [
      semanticCandidates
        .slice(0, Math.max(normalized.topK * 12, 60))
        .map((candidate) => candidate.record.issueNumber),
      bm25Candidates.map((candidate) => candidate.id),
    ],
    Math.max(normalized.topK * 12, 60),
  );
  const recordByIssue = new Map(
    embeddingIndex.map((record) => [record.issueNumber, record]),
  );
  const maxBm25Score = Math.max(...bm25Candidates.map((candidate) => candidate.score), 1);
  const rankedCandidates = fusedIssueNumbers
    .map<RankedCandidate | null>((fusedCandidate) => {
      const record = recordByIssue.get(fusedCandidate.id);

      if (!record) {
        return null;
      }

      const semanticScore = cosineSimilarity(queryVector, record.vector);
      const lexicalScore = keywordScore(queryText, record.text);
      const normalizedBm25Score =
        (bm25ScoreByIssue.get(record.issueNumber) || 0) / maxBm25Score;
      const semanticRankScore =
        1 / ((semanticRankByIssue.get(record.issueNumber) || 0) + 1);
      const blendedScore =
        fusedCandidate.score * 10 +
        semanticScore * 0.38 +
        lexicalScore * 0.18 +
        normalizedBm25Score * 0.32 +
        semanticRankScore * 0.12;

      return {
        issueNumber: record.issueNumber,
        title: record.title,
        url: record.url,
        labels: record.labels,
        score: blendedScore,
        semanticScore,
        lexicalScore,
      };
    })
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score);

  const queryTokens = Array.from(new Set(tokenize(queryText)));
  const richSemanticMatches = loadOptionalRichSemanticMatches(
    queryVector,
    Math.max(normalized.topK * 8, 24),
  );
  const codeSemanticMatches = loadOptionalCodeSemanticMatches(
    queryVector,
    Math.max(normalized.topK * 4, 12),
  );
  const candidatePool = rankedCandidates.slice(
    0,
    Math.max(normalized.topK * 8, 24),
  );
  const evidenceResults = await Promise.all(
    candidatePool.map(async (candidate) => ({
      candidate,
      evidence: await fetchIssueEvidence(candidate.issueNumber),
    })),
  );

  const matchedEvidence = evidenceResults
    .filter(
      (
        result,
      ): result is { candidate: RankedCandidate; evidence: QueryIssueResult } =>
        result.evidence !== null,
    )
    .filter((result) => result.evidence.evidencePaths.length > 0)
    .map((result) => ({
      ...result,
      rerankedScore: rerankEvidenceCandidate(
        queryText,
        queryTokens,
        result.candidate,
        result.evidence,
      ),
    }))
    .sort(
      (left, right) =>
        right.rerankedScore - left.rerankedScore ||
        right.candidate.score - left.candidate.score ||
        left.candidate.issueNumber - right.candidate.issueNumber,
    )
    .slice(0, normalized.topK);

  const similarTickets: SimilarTicketCandidate[] =
    matchedEvidence.length > 0
      ? matchedEvidence.map((result) => ({
          candidate: result.candidate,
          similarityScore: result.rerankedScore,
        }))
      : evidenceResults.slice(0, normalized.topK).map((result) => ({
          candidate: result.candidate,
          similarityScore: result.candidate.score,
        }));
  const componentScores = new Map<string, number>();
  const fileScores = new Map<
    string,
    {
      file_path: string;
      component: string;
      reason: string;
      score: number;
      line_ranges: Array<{
        start_line: number;
        end_line: number;
        source: string;
      }>;
    }
  >();
  let sessionsEvidenceCount = 0;
  let workbenchChatEvidenceCount = 0;
  const similarImplementationPatterns: Array<{
    pattern_name: string;
    summary: string;
    score: number;
    example_prs: number[];
  }> = [];
  const similarFeaturePrs: Array<{
    pull_request_number: number;
    title: string;
    url?: string;
  }> = [];
  const similarEnhancements: Array<{
    pull_request_number: number;
    title: string;
    url?: string;
  }> = [];

  matchedEvidence.forEach((result, index) => {
    const issueWeight = result.rerankedScore * rankWeight(index);
    const uniqueFiles = result.evidence.likelyFiles;
    const fileWeight =
      uniqueFiles.length > 0 ? issueWeight / uniqueFiles.length : issueWeight;

    for (const file of uniqueFiles) {
      const relevanceScore = filePathRelevanceScore(
        queryText,
        file.path,
        file.component,
      );
      const relevanceBoost = 1 + relevanceScore * 2.5;
      const familyBoost = pathFamilyBoost(queryText, file.path, file.component);
      const specificityPenalty = genericFilePenalty(file.path);
      const existingFile = fileScores.get(file.path);
      const nextScore =
        (existingFile?.score || 0) +
        fileWeight * relevanceBoost * familyBoost * specificityPenalty;

      fileScores.set(file.path, {
        file_path: file.path,
        component: file.component,
        reason: `Referenced by historical PRs ${file.linkedPullRequests.map((value) => `#${value}`).join(", ")}`,
        score: nextScore,
        line_ranges: existingFile?.line_ranges || [],
      });

      if (file.component !== "Unknown") {
        const componentAffinity = componentPathAffinityScore(
          file.component,
          file.path,
        );
        const componentPathBoost = pathFamilyBoost(
          queryText,
          file.path,
          file.component,
        );
        const normalizedPath = file.path.toLowerCase();

        if (normalizedPath.includes("src/vs/sessions/")) {
          sessionsEvidenceCount += 1;
        }

        if (normalizedPath.includes("/workbench/contrib/chat/")) {
          workbenchChatEvidenceCount += 1;
        }

        componentScores.set(
          file.component,
          (componentScores.get(file.component) || 0) +
            fileWeight *
              Math.max(0.75, relevanceBoost * 0.75) *
              componentAffinity *
              componentPathBoost *
              specificityPenalty,
        );
      }
    }
  });
  const provisionalComponent =
    topKey(componentScores) || queryProfile.componentHints[0] || "Unknown";

  for (const match of richSemanticMatches) {
    if (match.record.type === "implementation_pattern") {
      const patternResolutionType = match.record.metadata.resolutionType;

      if (
        mode === "bug_localization" &&
        patternResolutionType !== "existing_bug"
      ) {
        continue;
      }

      const patternName =
        typeof match.record.metadata.patternName === "string"
          ? match.record.metadata.patternName
          : match.record.title || "Implementation pattern";
      const summary =
        typeof match.record.metadata.intent === "string"
          ? match.record.metadata.intent
          : match.record.text.slice(0, 240);
      const examplePrs = metadataList(match.record.metadata.examplePrs)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      const pullRequestNumber = match.record.pullRequestNumber;
      const patternScore = scoreImplementationPatternMatch({
        semanticScore: match.score,
        queryResolutionType: queryProfile.resolution_type,
        queryComponent: provisionalComponent,
        querySurfaces: queryProfile.likely_surface,
        requiresNewFiles: queryProfile.requires_new_files,
        record: match.record,
      });

      if (patternScore < 0.18) {
        continue;
      }

      similarImplementationPatterns.push({
        pattern_name: patternName,
        summary,
        score: Number(patternScore.toFixed(3)),
        example_prs: examplePrs,
      });

      if (
        pullRequestNumber &&
        (patternResolutionType === "new_feature" ||
          patternResolutionType === "enhancement")
      ) {
        const row = {
          pull_request_number: pullRequestNumber,
          title: match.record.title || patternName,
          url: match.record.url,
        };

        if (patternResolutionType === "new_feature") {
          similarFeaturePrs.push(row);
        } else {
          similarEnhancements.push(row);
        }
      }

      for (const filePath of metadataList(
        match.record.metadata.typicalFilesModified,
      ).slice(0, 5)) {
        const quality = getPathQuality(filePath);

        if (!quality.includeInSemanticIndex) {
          continue;
        }

        const component = mapFilePathToComponent(filePath);
        const existingFile = fileScores.get(filePath);
        const pathRelevance = filePathRelevanceScore(
          queryText,
          filePath,
          component,
        );
        const score =
          (patternScore * 0.12 + pathRelevance * 0.42) * quality.score;

        fileScores.set(filePath, {
          file_path: filePath,
          component,
          reason: existingFile
            ? `${existingFile.reason}; Similar implementation pattern`
            : "Similar implementation pattern",
          score: (existingFile?.score || 0) + score,
          line_ranges: existingFile?.line_ranges || [],
        });
      }

      continue;
    }

    if (match.record.type === "pull_request") {
      const primaryFiles = metadataList(match.record.metadata.primaryFiles);
      const pullRequestNumber = match.record.pullRequestNumber;
      const reason = pullRequestNumber
        ? `Fix profile match from PR #${pullRequestNumber}`
        : "Fix profile match from historical PR";

      for (const [fileIndex, filePath] of primaryFiles.slice(0, 8).entries()) {
        const quality = getPathQuality(filePath);

        if (!quality.includeInSemanticIndex) {
          continue;
        }

        const component = mapFilePathToComponent(filePath);
        const existingFile = fileScores.get(filePath);
        const pathRelevance = filePathRelevanceScore(
          queryText,
          filePath,
          component,
        );

        if (!quality.includeInFocusedEvaluation && pathRelevance < 0.06) {
          continue;
        }

        const rankDecay = fileIndex === 0 ? 1 : 1 / Math.sqrt(fileIndex + 1);
        const familyBoost = pathFamilyBoost(queryText, filePath, component);
        const score =
          (match.score * 0.08 + pathRelevance * 0.58) *
          quality.score *
          rankDecay *
          familyBoost;

        fileScores.set(filePath, {
          file_path: filePath,
          component,
          reason: existingFile ? `${existingFile.reason}; ${reason}` : reason,
          score: (existingFile?.score || 0) + score,
          line_ranges: existingFile?.line_ranges || [],
        });
      }

      continue;
    }

    if (!match.record.filePath) {
      continue;
    }

    const filePath = match.record.filePath;
    const component = mapFilePathToComponent(filePath);
    const existingFile = fileScores.get(filePath);
    const newStartLine = match.record.metadata.newStartLine;
    const newLineCount = match.record.metadata.newLineCount;
    const reviewLine = match.record.metadata.line;
    const structuredLineRange =
      typeof newStartLine === "number" && typeof newLineCount === "number"
        ? {
            start_line: newStartLine,
            end_line: newStartLine + Math.max(newLineCount - 1, 0),
            source: match.record.id,
          }
        : typeof reviewLine === "number"
          ? {
              start_line: reviewLine,
              end_line: reviewLine,
              source: match.record.id,
            }
          : null;
    const reason =
      match.record.type === "patch_hunk"
        ? `Semantic patch evidence from PR #${match.record.pullRequestNumber}`
        : `Semantic review evidence from PR #${match.record.pullRequestNumber}`;
    const score =
      match.score * 0.85 +
      filePathRelevanceScore(queryText, filePath, component) * 0.35;
    const quality = getPathQuality(filePath);

    fileScores.set(filePath, {
      file_path: filePath,
      component,
      reason: existingFile ? `${existingFile.reason}; ${reason}` : reason,
      score: (existingFile?.score || 0) + score * quality.score,
      line_ranges: structuredLineRange
        ? [...(existingFile?.line_ranges || []), structuredLineRange]
        : existingFile?.line_ranges || [],
    });
  }

  const adjustedComponentScores = new Map<string, number>();

  for (const [component, score] of componentScores.entries()) {
    adjustedComponentScores.set(
      component,
      score *
        componentQueryAffinityScore(
          component,
          normalized.title,
          normalized.description,
        ),
    );
  }

  const lowerQueryText = queryText.toLowerCase();
  const sessionsIntent =
    lowerQueryText.includes("session") ||
    lowerQueryText.includes("account menu") ||
    lowerQueryText.includes("aquarium") ||
    lowerQueryText.includes("agent feedback") ||
    lowerQueryText.includes("copilot chat session") ||
    lowerQueryText.includes("title bar");
  const authOrSettingsIntent =
    lowerQueryText.includes("authentication") ||
    lowerQueryText.includes("auth") ||
    lowerQueryText.includes("token") ||
    lowerQueryText.includes("sign in") ||
    lowerQueryText.includes("login") ||
    lowerQueryText.includes("provider") ||
    lowerQueryText.includes("endpoint") ||
    lowerQueryText.includes("configuration") ||
    lowerQueryText.includes("settings") ||
    lowerQueryText.includes("byok") ||
    lowerQueryText.includes("model");

  if (sessionsIntent) {
    adjustedComponentScores.set(
      "Sessions",
      (adjustedComponentScores.get("Sessions") || 0) * 1.4 + 0.12,
    );
    adjustedComponentScores.set(
      "Chat",
      (adjustedComponentScores.get("Chat") || 0) * 0.74,
    );
  }

  if (sessionsIntent && sessionsEvidenceCount > 0) {
    const sessionsEvidenceBoost = Math.min(0.18, sessionsEvidenceCount * 0.02);
    adjustedComponentScores.set(
      "Sessions",
      (adjustedComponentScores.get("Sessions") || 0) + sessionsEvidenceBoost,
    );
  }

  if (
    sessionsIntent &&
    sessionsEvidenceCount >= workbenchChatEvidenceCount &&
    sessionsEvidenceCount > 0
  ) {
    adjustedComponentScores.set(
      "Sessions",
      (adjustedComponentScores.get("Sessions") || 0) + 0.08,
    );
    adjustedComponentScores.set(
      "Chat",
      (adjustedComponentScores.get("Chat") || 0) * 0.7,
    );
  }

  if (authOrSettingsIntent) {
    adjustedComponentScores.set(
      "Authentication",
      (adjustedComponentScores.get("Authentication") || 0) * 1.28 + 0.06,
    );
    adjustedComponentScores.set(
      "Settings",
      (adjustedComponentScores.get("Settings") || 0) * 1.22 + 0.04,
    );
    adjustedComponentScores.set(
      "Chat",
      (adjustedComponentScores.get("Chat") || 0) * 0.78,
    );
  }

  const suggestedComponent = topKey(adjustedComponentScores) || "Unknown";

  for (const match of codeSemanticMatches) {
    if (!match.record.filePath) {
      continue;
    }

    const filePath = match.record.filePath;
    const component = mapFilePathToComponent(filePath);
    const pathRelevance = filePathRelevanceScore(queryText, filePath, component);
    const componentAligned = component === suggestedComponent;

    if (!componentAligned && pathRelevance < 0.08) {
      continue;
    }

    const quality = getPathQuality(filePath);

    if (!quality.includeInFocusedEvaluation) {
      continue;
    }

    const existingFile = fileScores.get(filePath);
    const symbolName = match.record.metadata.symbolName;
    const chunkType = match.record.metadata.chunkType;
    const reason =
      typeof symbolName === "string" && symbolName.length > 0
        ? `Code semantic match in ${symbolName}`
        : `Code semantic match in ${chunkType || "source chunk"}`;
    const score =
      match.score * (componentAligned ? 0.34 : 0.18) + pathRelevance * 0.55;

    fileScores.set(filePath, {
      file_path: filePath,
      component,
      reason: existingFile ? `${existingFile.reason}; ${reason}` : reason,
      score: (existingFile?.score || 0) + score * quality.score,
      line_ranges: existingFile?.line_ranges || [],
    });
  }

  const fileRows = Array.from(fileScores.values())
    .map((file) => ({
      ...file,
      score:
        file.score *
        (file.component === suggestedComponent
          ? componentPathAffinityScore(suggestedComponent, file.file_path)
          : 0.75),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.file_path.localeCompare(right.file_path),
    )
    .slice(0, 10)
    .map(({ score: _score, line_ranges: _lineRanges, ...file }) => file);
  const areaScores = new Map<
    string,
    {
      area_path: string;
      component: string;
      reason: string;
      score: number;
      supporting_files: Set<string>;
    }
  >();

  for (const file of Array.from(fileScores.values())) {
    const areaPath = impactAreaForFile(file.file_path);
    const existingArea = areaScores.get(areaPath);
    const areaScore =
      file.score * (file.component === suggestedComponent ? 1.1 : 0.85);

    areaScores.set(areaPath, {
      area_path: areaPath,
      component: existingArea?.component || file.component,
      reason:
        existingArea?.reason ||
        `Historical fixes touched files under ${areaPath}`,
      score: (existingArea?.score || 0) + areaScore,
      supporting_files: new Set([
        ...(existingArea?.supporting_files || []),
        file.file_path,
      ]),
    });
  }

  const areaRows = Array.from(areaScores.values())
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.area_path.localeCompare(right.area_path),
    )
    .slice(0, 8)
    .map(({ score: _score, supporting_files, ...area }) => ({
      ...area,
      supporting_files: Array.from(supporting_files.values()).slice(0, 5),
    }));

  const evidencePath = matchedEvidence
    .flatMap((result) => result.evidence.evidencePaths)
    .slice(0, 10);
  const topSimilar = similarTickets[0];
  const likelyComponents = Array.from(adjustedComponentScores.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([component, score]) => ({
      component,
      reason: "Ranked from similar issues, graph evidence, semantic matches, and query/component affinity.",
      confidence: Number(Math.min(0.95, Math.max(0.05, score)).toFixed(3)),
    }));
  const likelyNewFiles = likelyNewFileSuggestions({
    queryText,
    areas: areaRows,
    mode,
    targetComponent: suggestedComponent,
    newFileProbability: queryProfile.new_file_probability,
  });
  const possibleNewFiles =
    queryProfile.new_file_likelihood === "possible" ? likelyNewFiles : [];
  const plannedNewFiles =
    queryProfile.new_file_likelihood === "likely" ? likelyNewFiles : [];
  const likelyNewDirectories = Array.from(
    new Set(
      [...plannedNewFiles, ...possibleNewFiles].map((file) =>
        impactAreaForFile(file.file_path),
      ),
    ),
  ).slice(0, 5);
  const existingFilesToInspect =
    mode === "feature_planning" ||
    mode === "enhancement_planning" ||
    mode === "specialized_routing"
      ? fileRows.slice(0, 8)
      : [];
  const existingFilesToExtend =
    mode === "feature_planning" || mode === "enhancement_planning"
      ? fileRows
          .filter((file) => file.component === suggestedComponent)
          .slice(0, 6)
      : [];
  const likelyExistingFiles =
    mode === "bug_localization" || mode === "general_triage"
      ? fileRows
      : [];
  const similarFixPrs = matchedEvidence
    .flatMap((result) => result.evidence.linkedPullRequests)
    .map((pullRequest) => ({
      pull_request_number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
    }))
    .slice(0, 8);
  const limitations = [
    mode === "feature_planning"
      ? "This issue likely requires new implementation. Not enough evidence for exact file prediction; use likely implementation areas, files to inspect, possible new files, and similar patterns."
      : "",
    mode === "enhancement_planning"
      ? queryProfile.new_file_likelihood === "possible"
        ? "This issue likely extends existing behavior, but may require one or more new helper or test files. Prioritize files to inspect/extend, then use possible new files as planning hints."
        : "This issue likely extends existing behavior. Prioritize files to inspect/extend before creating new files."
      : "",
    mode === "general_triage"
      ? "Resolution type is uncertain; human review is recommended before assigning implementation work."
      : "",
    queryProfile.confidence < 0.55
      ? "Resolution-type confidence is low because the issue text has weak routing signals."
      : "",
  ].filter(Boolean);

  return {
    mode,
    resolution_type: queryProfile.resolution_type,
    likely_components: likelyComponents,
    likely_areas: areaRows,
    limitations,
    routing: {
      requires_new_files: queryProfile.requires_new_files,
      requires_existing_file_edits: queryProfile.requires_existing_file_edits,
      likely_surface: queryProfile.likely_surface,
      implementation_scope: queryProfile.implementation_scope,
      new_file_probability: queryProfile.new_file_probability,
      new_file_likelihood: queryProfile.new_file_likelihood,
      existing_file_edit_probability: queryProfile.existing_file_edit_probability,
      non_code_probability: queryProfile.non_code_probability,
      reasoning: queryProfile.reasoning,
      evidence_terms: queryProfile.evidence_terms,
      confidence_label: confidenceLabel(queryProfile.confidence),
      output_guidance: outputGuidanceForMode(mode),
    },
    likely_existing_files: likelyExistingFiles,
    existing_files_to_inspect: existingFilesToInspect,
    existing_files_to_extend: existingFilesToExtend,
    likely_new_files: plannedNewFiles,
    possible_new_files: possibleNewFiles,
    likely_new_directories: likelyNewDirectories,
    similar_implementation_patterns: similarImplementationPatterns
      .sort((left, right) => right.score - left.score)
      .slice(0, 8),
    similar_feature_prs: similarFeaturePrs.slice(0, 8),
    similar_fix_prs: similarFixPrs,
    similar_enhancements: similarEnhancements.slice(0, 8),
    suggested_implementation_steps: implementationStepsForMode(mode),
    ticket_type: inferTicketType(normalized.title, normalized.description),
    suggested_component: suggestedComponent,
    suggested_team:
      suggestedComponent === "Unknown"
        ? "Unknown"
        : `${suggestedComponent} Team`,
    confidence: Number(
      Math.min(1, Math.max(0, topSimilar?.candidate.score || 0)).toFixed(3),
    ),
    similar_tickets: similarTickets.map((candidate) => ({
      issue_number: candidate.candidate.issueNumber,
      title: candidate.candidate.title,
      similarity_score: Number(candidate.similarityScore.toFixed(3)),
      labels: candidate.candidate.labels,
      url: candidate.candidate.url,
    })),
    likely_impacted_files: fileRows,
    likely_impacted_areas: areaRows,
    past_fix_pattern:
      matchedEvidence[0]?.evidence.linkedPullRequests[0]?.title ||
      "Review the linked historical pull requests for recurring file and component patterns.",
    possible_duplicate: topSimilar
      ? {
          issue_number: topSimilar.candidate.issueNumber,
          title: topSimilar.candidate.title,
          confidence: Number(
            Math.min(1, Math.max(0, topSimilar.candidate.score)).toFixed(3),
          ),
        }
      : {
          issue_number: "",
          title: "",
          confidence: 0,
        },
    evidence_path: evidencePath,
    missing_information: normalized.description
      ? []
      : ["Ticket description is missing."],
    suggested_questions_for_reporter: normalized.description
      ? []
      : [
          "Can you provide repro steps, the exact error, and the affected VS Code area?",
        ],
  };
}
