import { createEmbeddingProvider, cosineSimilarity, loadEmbeddingIndex } from "./embeddings.js";
import { fetchIssueEvidence } from "./graphQueries.js";
import type { QueryIssueResult, RecommendationResult } from "./types.js";

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
  return (text.toLowerCase().match(/[a-z0-9_./-]+/g) || []).filter((token) => token.length >= 3);
}

function keywordScore(queryText: string, candidateText: string): number {
  const queryTokens = Array.from(new Set(tokenize(queryText)));
  const candidateTokens = new Set(tokenize(candidateText));

  if (queryTokens.length === 0) {
    return 0;
  }

  const matches = queryTokens.filter((token) => candidateTokens.has(token)).length;
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

function filePathRelevanceScore(queryText: string, filePath: string, component: string): number {
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
    } else if (Array.from(pathTokens).some((pathToken) => pathToken.includes(token) || token.includes(pathToken))) {
      score += 0.5;
    }

    if (componentTokens.has(token)) {
      score += 0.8;
    }
  }

  return score / queryTokens.length;
}


function genericFilePenalty(filePath: string): number {
  const normalizedPath = filePath.toLowerCase();
  let penalty = 1;

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

function pathFamilyBoost(queryText: string, filePath: string, component: string): number {
  const text = queryText.toLowerCase();
  const normalizedPath = filePath.toLowerCase();
  let boost = 1;

  const hasAny = (tokens: string[]) => tokens.some((token) => text.includes(token));

  if (
    hasAny(["session", "account menu", "aquarium", "agent feedback", "copilot chat session", "title bar"]) &&
    (normalizedPath.includes("src/vs/sessions/") || component === "Sessions")
  ) {
    boost *= 1.9;
  }

  if (
    hasAny(["authentication", "auth", "token", "sign in", "login", "access"]) &&
    (normalizedPath.includes("/authentication/") || normalizedPath.includes("copilottoken") || component === "Authentication")
  ) {
    boost *= 1.9;
  }

  if (
    hasAny(["setting", "settings", "configuration", "provider", "endpoint", "byok", "model"]) &&
    (normalizedPath.includes("configuration") || normalizedPath.includes("settings") || component === "Settings")
  ) {
    boost *= 1.75;
  }

  if (
    hasAny(["issue reporter", "report issue", "issue report"]) &&
    (normalizedPath.includes("/contrib/issue/") || normalizedPath.includes("issuereporter") || component === "IssueReporter")
  ) {
    boost *= 2;
  }

  if (
    hasAny(["welcome", "getting started", "onboarding"]) &&
    (normalizedPath.includes("welcomegettingstarted") || normalizedPath.includes("gettingstarted") || component === "GettingStarted")
  ) {
    boost *= 2;
  }

  if (
    hasAny(["task", "tasks", "task output"]) &&
    (normalizedPath.includes("/tasks/") || normalizedPath.includes("taskservice") || component === "Tasks")
  ) {
    boost *= 1.7;
  }

  if (
    hasAny(["search", "ignore file", "ripgrep"]) &&
    (normalizedPath.includes("/search/") || normalizedPath.includes("ignorefile") || component === "Search")
  ) {
    boost *= 1.7;
  }

  if (
    hasAny(["terminal", "shell", "pty", "osc 8", "output monitor", "run in terminal"]) &&
    (normalizedPath.includes("/terminal/") || normalizedPath.includes("terminalcontrib") || component === "Terminal")
  ) {
    boost *= 1.5;
  }

  if (
    hasAny(["extension", "enablement", "marketplace", "profile"]) &&
    (normalizedPath.includes("/extension") || normalizedPath.includes("extensionmanagement") || component === "Extensions")
  ) {
    boost *= 1.6;
  }

  return boost;
}

function componentPathAffinityScore(component: string, filePath: string): number {
  const normalizedPath = filePath.toLowerCase();

  if (component === "Chat") {
    let score = 1;

    if (normalizedPath.includes("/workbench/contrib/chat/")) {
      score += 1.8;
    }

    if (normalizedPath.includes("/common/chats") || normalizedPath.includes("/common/chat")) {
      score += 1.5;
    }

    if (normalizedPath.includes("/browser/widget/") || normalizedPath.includes("/browser/agentsessions/")) {
      score += 1.25;
    }

    if (normalizedPath.includes("chatservice") || normalizedPath.includes("chatmodel") || normalizedPath.includes("chatagents")) {
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

    if (normalizedPath.includes("/contrib/sessions/") || normalizedPath.includes("/contrib/accountmenu/")) {
      score += 1.1;
    }

    if (normalizedPath.includes("session") || normalizedPath.includes("accountmenu") || normalizedPath.includes("aquarium")) {
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

    if (normalizedPath.includes("/snippet/") || normalizedPath.includes("snippetsession")) {
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

    if (normalizedPath.includes("ignorefile") || normalizedPath.includes("ripgrep")) {
      score += 1.2;
    }

    return Math.max(0.2, score);
  }

  if (component === "Settings") {
    let score = 1;

    if (normalizedPath.includes("configuration") || normalizedPath.includes("settings")) {
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

    if (normalizedPath.includes("extensionenablement") || normalizedPath.includes("extensionmanagement")) {
      score += 1.1;
    }

    return Math.max(0.2, score);
  }

  if (component === "Authentication") {
    let score = 1;

    if (normalizedPath.includes("authentication") || normalizedPath.includes("copilottoken")) {
      score += 1.7;
    }

    return Math.max(0.2, score);
  }

  if (component === "Update") {
    let score = 1;

    if (normalizedPath.includes("/update/") || normalizedPath.includes("updateservice")) {
      score += 1.6;
    }

    return Math.max(0.2, score);
  }

  if (component === "Tasks") {
    let score = 1;

    if (normalizedPath.includes("/tasks/") || normalizedPath.includes("taskservice")) {
      score += 1.6;
    }

    return Math.max(0.2, score);
  }

  return 1;
}

function componentQueryAffinityScore(component: string, title: string, description: string): number {
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

    if (combinedText.includes("account menu") || combinedText.includes("aquarium")) {
      score += 1.1;
    }

    if (combinedText.includes("agent feedback") || combinedText.includes("copilot chat session")) {
      score += 1.1;
    }

    if (combinedText.includes("remote agent host") || combinedText.includes("title bar")) {
      score += 0.9;
    }

    return Math.max(0.3, score);
  }

  if (component === "Editor") {
    if (combinedText.includes("snippet")) {
      score += 1.7;
    }

    if (combinedText.includes("inline edit") || combinedText.includes("editor")) {
      score += 0.8;
    }

    return Math.max(0.3, score);
  }

  if (component === "Search") {
    if (combinedText.includes("search")) {
      score += 1.6;
    }

    if (combinedText.includes("ignore file") || combinedText.includes("ripgrep")) {
      score += 1.3;
    }

    return Math.max(0.3, score);
  }

  if (component === "Settings") {
    if (combinedText.includes("setting") || combinedText.includes("configuration")) {
      score += 1.4;
    }

    if (combinedText.includes("endpoint") || combinedText.includes("provider") || combinedText.includes("model")) {
      score += 1.1;
    }

    return Math.max(0.3, score);
  }

  if (component === "Extensions") {
    if (combinedText.includes("extension")) {
      score += 1.5;
    }

    if (combinedText.includes("enablement") || combinedText.includes("marketplace") || combinedText.includes("profile")) {
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

    if (combinedText.includes("installer") || combinedText.includes("win32") || combinedText.includes("insider")) {
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
    if (combinedText.includes("welcome") || combinedText.includes("getting started") || combinedText.includes("onboarding")) {
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
  evidence: QueryIssueResult
): number {
  const candidateLabelTokens = evidence.issue.labels.flatMap((label) => tokenize(label));
  const labelScore = jaccardScore(queryTokens, candidateLabelTokens);
  const candidateTextScore = keywordScore(queryText, `${evidence.issue.title}\n${candidate.title}`);
  const componentNames = Array.from(new Set(evidence.likelyFiles.map((file) => file.component).filter((component) => component !== "Unknown")));
  const bestComponentQueryFit =
    componentNames.length > 0
      ? Math.max(...componentNames.map((component) => componentQueryAffinityScore(component, candidate.title, queryText)))
      : 1;
  const bestFileQueryFit =
    evidence.likelyFiles.length > 0
      ? Math.max(...evidence.likelyFiles.map((file) => filePathRelevanceScore(queryText, file.path, file.component)))
      : 0;
  const avgFileQueryFit =
    evidence.likelyFiles.length > 0
      ? evidence.likelyFiles.reduce(
          (sum, file) => sum + filePathRelevanceScore(queryText, file.path, file.component),
          0
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

export async function generateRecommendation(input: RecommendationInput): Promise<RecommendationResult> {
  const normalized = normalizeInput(input);
  const provider = createEmbeddingProvider();
  const embeddingIndex = loadEmbeddingIndex();
  const queryText = [normalized.title, normalized.description]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const queryVector = await provider.embedOne(queryText);

  if (embeddingIndex.length === 0) {
    throw new Error("Embedding index is empty. Run create:embeddings first.");
  }

  if (embeddingIndex[0].vector.length !== queryVector.length) {
    throw new Error(
      `Embedding dimension mismatch. Rebuild the index with 'npm run create:embeddings -- --reset' for the current provider.`
    );
  }

  const rankedCandidates = embeddingIndex
    .map<RankedCandidate>((record) => {
      const semanticScore = cosineSimilarity(queryVector, record.vector);
      const lexicalScore = keywordScore(queryText, record.text);
      const blendedScore = semanticScore * 0.65 + lexicalScore * 0.35;

      return {
        issueNumber: record.issueNumber,
        title: record.title,
        url: record.url,
        labels: record.labels,
        score: blendedScore,
        semanticScore,
        lexicalScore
      };
    })
    .sort((left, right) => right.score - left.score);

  const queryTokens = Array.from(new Set(tokenize(queryText)));
  const candidatePool = rankedCandidates.slice(0, Math.max(normalized.topK * 8, 24));
  const evidenceResults = await Promise.all(
    candidatePool.map(async (candidate) => ({
      candidate,
      evidence: await fetchIssueEvidence(candidate.issueNumber)
    }))
  );

  const matchedEvidence = evidenceResults
    .filter(
      (result): result is { candidate: RankedCandidate; evidence: QueryIssueResult } =>
        result.evidence !== null
    )
    .filter((result) => result.evidence.evidencePaths.length > 0)
    .map((result) => ({
      ...result,
      rerankedScore: rerankEvidenceCandidate(queryText, queryTokens, result.candidate, result.evidence)
    }))
    .sort(
      (left, right) =>
        right.rerankedScore - left.rerankedScore ||
        right.candidate.score - left.candidate.score ||
        left.candidate.issueNumber - right.candidate.issueNumber
    )
    .slice(0, normalized.topK);

  const similarTickets: SimilarTicketCandidate[] =
    matchedEvidence.length > 0
      ? matchedEvidence.map((result) => ({
          candidate: result.candidate,
          similarityScore: result.rerankedScore
        }))
      : evidenceResults.slice(0, normalized.topK).map((result) => ({
          candidate: result.candidate,
          similarityScore: result.candidate.score
        }));
  const componentScores = new Map<string, number>();
  const fileScores = new Map<
    string,
    { file_path: string; component: string; reason: string; score: number }
  >();
  let sessionsEvidenceCount = 0;
  let workbenchChatEvidenceCount = 0;

  matchedEvidence.forEach((result, index) => {
    const issueWeight = result.rerankedScore * rankWeight(index);
    const uniqueFiles = result.evidence.likelyFiles;
    const fileWeight = uniqueFiles.length > 0 ? issueWeight / uniqueFiles.length : issueWeight;

    for (const file of uniqueFiles) {
      const relevanceScore = filePathRelevanceScore(queryText, file.path, file.component);
      const relevanceBoost = 1 + relevanceScore * 2.5;
      const familyBoost = pathFamilyBoost(queryText, file.path, file.component);
      const specificityPenalty = genericFilePenalty(file.path);
      const existingFile = fileScores.get(file.path);
      const nextScore =
        (existingFile?.score || 0) + fileWeight * relevanceBoost * familyBoost * specificityPenalty;

      fileScores.set(file.path, {
        file_path: file.path,
        component: file.component,
        reason: `Referenced by historical PRs ${file.linkedPullRequests.map((value) => `#${value}`).join(", ")}`,
        score: nextScore
      });

      if (file.component !== "Unknown") {
        const componentAffinity = componentPathAffinityScore(file.component, file.path);
        const componentPathBoost = pathFamilyBoost(queryText, file.path, file.component);
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
              specificityPenalty
        );
      }
    }
  });

  const adjustedComponentScores = new Map<string, number>();

  for (const [component, score] of componentScores.entries()) {
    adjustedComponentScores.set(
      component,
      score * componentQueryAffinityScore(component, normalized.title, normalized.description)
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
    adjustedComponentScores.set("Sessions", (adjustedComponentScores.get("Sessions") || 0) * 1.4 + 0.12);
    adjustedComponentScores.set("Chat", (adjustedComponentScores.get("Chat") || 0) * 0.74);
  }

  if (sessionsIntent && sessionsEvidenceCount > 0) {
    const sessionsEvidenceBoost = Math.min(0.18, sessionsEvidenceCount * 0.02);
    adjustedComponentScores.set(
      "Sessions",
      (adjustedComponentScores.get("Sessions") || 0) + sessionsEvidenceBoost
    );
  }

  if (sessionsIntent && sessionsEvidenceCount >= workbenchChatEvidenceCount && sessionsEvidenceCount > 0) {
    adjustedComponentScores.set("Sessions", (adjustedComponentScores.get("Sessions") || 0) + 0.08);
    adjustedComponentScores.set("Chat", (adjustedComponentScores.get("Chat") || 0) * 0.7);
  }

  if (authOrSettingsIntent) {
    adjustedComponentScores.set(
      "Authentication",
      (adjustedComponentScores.get("Authentication") || 0) * 1.28 + 0.06
    );
    adjustedComponentScores.set("Settings", (adjustedComponentScores.get("Settings") || 0) * 1.22 + 0.04);
    adjustedComponentScores.set("Chat", (adjustedComponentScores.get("Chat") || 0) * 0.78);
  }

  const suggestedComponent = topKey(adjustedComponentScores) || "Unknown";

  const fileRows = Array.from(fileScores.values())
    .map((file) => ({
      ...file,
      score: file.score * (file.component === suggestedComponent ? componentPathAffinityScore(suggestedComponent, file.file_path) : 0.75)
    }))
    .sort((left, right) => right.score - left.score || left.file_path.localeCompare(right.file_path))
    .slice(0, 10)
    .map(({ score: _score, ...file }) => file);

  const evidencePath = matchedEvidence.flatMap((result) => result.evidence.evidencePaths).slice(0, 10);
  const topSimilar = similarTickets[0];

  return {
    ticket_type: inferTicketType(normalized.title, normalized.description),
    suggested_component: suggestedComponent,
    suggested_team: suggestedComponent === "Unknown" ? "Unknown" : `${suggestedComponent} Team`,
    confidence: Number((topSimilar?.candidate.score || 0).toFixed(3)),
    similar_tickets: similarTickets.map((candidate) => ({
      issue_number: candidate.candidate.issueNumber,
      title: candidate.candidate.title,
      similarity_score: Number(candidate.similarityScore.toFixed(3)),
      labels: candidate.candidate.labels,
      url: candidate.candidate.url
    })),
    likely_impacted_files: fileRows,
    past_fix_pattern:
      matchedEvidence[0]?.evidence.linkedPullRequests[0]?.title ||
      "Review the linked historical pull requests for recurring file and component patterns.",
    possible_duplicate: topSimilar
      ? {
          issue_number: topSimilar.candidate.issueNumber,
          title: topSimilar.candidate.title,
          confidence: Number(topSimilar.candidate.score.toFixed(3))
        }
      : {
          issue_number: "",
          title: "",
          confidence: 0
        },
    evidence_path: evidencePath,
    missing_information: normalized.description ? [] : ["Ticket description is missing."],
    suggested_questions_for_reporter: normalized.description
      ? []
      : ["Can you provide repro steps, the exact error, and the affected VS Code area?"]
  };
}
