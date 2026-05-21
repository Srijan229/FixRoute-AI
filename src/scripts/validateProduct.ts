import fs from "node:fs";
import path from "node:path";
import {
  createEmbeddingProvider,
  cosineSimilarity,
  loadEmbeddingIndex,
} from "../lib/embeddings.js";
import {
  fetchIssueEvidence,
  searchIssuesByTitle,
} from "../lib/graphQueries.js";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { generateRecommendation } from "../lib/recommendation.js";
import { logInfo } from "../lib/logger.js";
import type {
  BenchmarkCase,
  HoldoutSplit,
  QueryIssueResult,
  RecommendationResult,
} from "../lib/types.js";

const HOLDOUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "holdout.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "productValidation.json",
);

type Args = {
  limit?: number;
};

type BaselineCandidate = {
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  score: number;
};

type SystemName = "lexical_graph" | "semantic_graph" | "full_graph_aware";

type SystemMetrics = {
  evaluated_cases: number;
  component_accuracy: number;
  component_top3_accuracy: number;
  duplicate_support_rate: number;
  component_aligned_file_hit_rate: number;
  focused_file_recall_at_5: number;
  evidence_path_validity_rate: number;
  average_confidence: number;
};

type ValidationCaseRow = {
  issue_number: number;
  expected_component: string;
  title: string;
  outcomes: Record<
    SystemName,
    {
      predicted_component: string;
      confidence: number;
      duplicate_issue: number | string;
      top_files: string[];
      top_similar_issues: number[];
      focused_file_hit: boolean;
      component_correct: boolean;
    }
  >;
};

type ValidationReport = {
  claim_under_test: string;
  test_basis: string;
  holdout_metadata: HoldoutSplit["metadata"];
  metrics: Record<SystemName, SystemMetrics>;
  threshold_assessment: {
    component_accuracy_target: number;
    component_top3_accuracy_target: number;
    evidence_path_validity_target: number;
    component_aligned_file_hit_target: number;
    supported: boolean;
    reason: string;
  };
  comparative_findings: string[];
  difficult_cases_sample: ValidationCaseRow[];
};

function parseArgs(argv: string[]): Args {
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit" && argv[index + 1]) {
      limit = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  return { limit };
}

function loadHoldoutSplit(): HoldoutSplit {
  if (!fs.existsSync(HOLDOUT_PATH)) {
    throw new Error("Missing holdout split. Run build:holdout first.");
  }

  return JSON.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as HoldoutSplit;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_./-]+/g) || []).filter(
    (token) => token.length >= 3,
  );
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function keywordScore(queryText: string, candidateText: string): number {
  const queryTokens = unique(tokenize(queryText));
  const candidateTokens = new Set(tokenize(candidateText));

  if (queryTokens.length === 0) {
    return 0;
  }

  const matches = queryTokens.filter((token) =>
    candidateTokens.has(token),
  ).length;
  return matches / queryTokens.length;
}

function rankWeight(index: number): number {
  return 1 / (index + 1);
}

function impactAreaForFile(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, Math.min(parts.length - 1, 6)).join("/") || filePath;
}

function filePriorityScore(
  filePath: string,
  expectedComponent: string,
): number {
  const normalizedPath = filePath.toLowerCase();
  let score = 0;

  if (mapFilePathToComponent(filePath) === expectedComponent) {
    score += 50;
  }

  if (normalizedPath.includes("/src/")) {
    score += 20;
  }

  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx")) {
    score += 10;
  }

  if (
    normalizedPath.includes("/common/") ||
    normalizedPath.includes("/browser/")
  ) {
    score += 5;
  }

  if (normalizedPath.includes("/test/")) {
    score -= 10;
  }

  if (
    normalizedPath.endsWith(".css") ||
    normalizedPath.endsWith(".md") ||
    normalizedPath.endsWith(".yml")
  ) {
    score -= 8;
  }

  if (
    normalizedPath.startsWith(".vscode/") ||
    normalizedPath.startsWith("build/")
  ) {
    score -= 12;
  }

  return score;
}

function deriveFocusedExpectedFiles(benchmarkCase: BenchmarkCase): string[] {
  const componentFiles = benchmarkCase.expected.files.filter(
    (filePath) =>
      mapFilePathToComponent(filePath) === benchmarkCase.expected.component,
  );
  const candidateFiles =
    componentFiles.length > 0 ? componentFiles : benchmarkCase.expected.files;

  return [...candidateFiles]
    .sort((left, right) => {
      const scoreDifference =
        filePriorityScore(right, benchmarkCase.expected.component) -
        filePriorityScore(left, benchmarkCase.expected.component);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return left.localeCompare(right);
    })
    .slice(0, 10);
}

function recall(expectedFiles: string[], predictedFiles: string[]): number {
  if (expectedFiles.length === 0) {
    return 0;
  }

  const hits = expectedFiles.filter((file) =>
    predictedFiles.includes(file),
  ).length;
  return hits / expectedFiles.length;
}

function topKey(scores: Map<string, number>): string {
  let selected = "Unknown";
  let maxScore = -Infinity;

  for (const [key, value] of scores.entries()) {
    if (value > maxScore) {
      selected = key;
      maxScore = value;
    }
  }

  return selected;
}

function isEvidencePathValid(pathRow: string[]): boolean {
  return (
    pathRow.length === 4 &&
    pathRow[0].startsWith("Issue #") &&
    pathRow[1].startsWith("FIXED_BY PR #") &&
    pathRow[2].startsWith("CHANGES ") &&
    pathRow[3].startsWith("BELONGS_TO ")
  );
}

function aggregateRecommendation(
  candidates: BaselineCandidate[],
  evidenceRows: Array<{
    candidate: BaselineCandidate;
    evidence: QueryIssueResult;
  }>,
): RecommendationResult {
  const componentScores = new Map<string, number>();
  const fileScores = new Map<
    string,
    { file_path: string; component: string; reason: string; score: number }
  >();

  evidenceRows.forEach((result, index) => {
    const issueWeight = result.candidate.score * rankWeight(index);
    const uniqueFiles = result.evidence.likelyFiles;
    const fileWeight =
      uniqueFiles.length > 0 ? issueWeight / uniqueFiles.length : issueWeight;

    for (const file of uniqueFiles) {
      componentScores.set(
        file.component,
        (componentScores.get(file.component) || 0) + issueWeight,
      );

      const existingFile = fileScores.get(file.path);
      const reason = `Seen in Issue #${result.evidence.issue.number} via PR(s) ${file.linkedPullRequests.join(", ")}`;

      if (!existingFile) {
        fileScores.set(file.path, {
          file_path: file.path,
          component: file.component,
          reason,
          score: fileWeight,
        });
      } else {
        existingFile.score += fileWeight;
      }
    }
  });

  const suggestedComponent = topKey(componentScores);
  const topFiles = Array.from(fileScores.values())
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.file_path.localeCompare(right.file_path),
    )
    .slice(0, 10)
    .map(({ score: _score, ...file }) => file);
  const areaMap = new Map<
    string,
    {
      area_path: string;
      component: string;
      reason: string;
      supporting_files: Set<string>;
    }
  >();

  for (const file of topFiles) {
    const areaPath = impactAreaForFile(file.file_path);
    const existingArea = areaMap.get(areaPath);

    areaMap.set(areaPath, {
      area_path: areaPath,
      component: existingArea?.component || file.component,
      reason:
        existingArea?.reason ||
        `Historical fixes touched files under ${areaPath}`,
      supporting_files: new Set([
        ...(existingArea?.supporting_files || []),
        file.file_path,
      ]),
    });
  }

  const topAreas = Array.from(areaMap.values())
    .slice(0, 8)
    .map(({ supporting_files, ...area }) => ({
      ...area,
      supporting_files: Array.from(supporting_files.values()).slice(0, 5),
    }));
  const evidencePath = evidenceRows
    .flatMap((row) => row.evidence.evidencePaths)
    .slice(0, 10);
  const topCandidate = candidates[0];

  return {
    mode: "bug_localization",
    resolution_type: "existing_bug",
    likely_components:
      suggestedComponent === "Unknown"
        ? []
        : [
            {
              component: suggestedComponent,
              reason: "Lexical graph validation fallback.",
              confidence: Number((topCandidate?.score || 0).toFixed(3)),
            },
          ],
    likely_areas: topAreas,
    limitations: [],
    routing: {
      requires_new_files: false,
      requires_existing_file_edits: true,
      likely_surface: ["service"],
      implementation_scope: "unknown",
      new_file_probability: 0.12,
      existing_file_edit_probability: 0.86,
      non_code_probability: 0.12,
      reasoning: "Validation fallback uses bug-localization routing.",
      evidence_terms: [],
      confidence_label: "medium",
      output_guidance:
        "Use likely existing files as investigation starting points, not guaranteed bug locations.",
    },
    likely_existing_files: topFiles,
    existing_files_to_inspect: [],
    existing_files_to_extend: [],
    likely_new_files: [],
    possible_new_files: [],
    likely_new_directories: [],
    similar_implementation_patterns: [],
    similar_feature_prs: [],
    similar_fix_prs: [],
    similar_enhancements: [],
    suggested_implementation_steps: [],
    ticket_type: "unknown",
    suggested_component: suggestedComponent,
    suggested_team:
      suggestedComponent === "Unknown"
        ? "Unknown"
        : `${suggestedComponent} Team`,
    confidence: Number((topCandidate?.score || 0).toFixed(3)),
    similar_tickets: candidates.slice(0, 5).map((candidate) => ({
      issue_number: candidate.issueNumber,
      title: candidate.title,
      similarity_score: Number(candidate.score.toFixed(3)),
      labels: candidate.labels,
      url: candidate.url,
    })),
    likely_impacted_files: topFiles,
    likely_impacted_areas: topAreas,
    past_fix_pattern:
      evidenceRows[0]?.evidence.linkedPullRequests[0]?.title ||
      "Review the linked historical pull requests for recurring file and component patterns.",
    possible_duplicate: topCandidate
      ? {
          issue_number: topCandidate.issueNumber,
          title: topCandidate.title,
          confidence: Number(topCandidate.score.toFixed(3)),
        }
      : {
          issue_number: "",
          title: "",
          confidence: 0,
        },
    evidence_path: evidencePath,
    missing_information: [],
    suggested_questions_for_reporter: [],
  };
}

async function generateLexicalGraphRecommendation(
  benchmarkCase: BenchmarkCase,
  topK = 5,
): Promise<RecommendationResult> {
  const queryText = [benchmarkCase.title, benchmarkCase.body]
    .filter(Boolean)
    .join("\n\n");
  const issueNumbers = await searchIssuesByTitle(
    queryText,
    Math.max(topK * 6, 24),
  );
  const evidenceRows = (
    await Promise.all(
      issueNumbers.map(async (issueNumber) => ({
        issueNumber,
        evidence: await fetchIssueEvidence(issueNumber),
      })),
    )
  )
    .filter(
      (row): row is { issueNumber: number; evidence: QueryIssueResult } =>
        row.evidence !== null,
    )
    .filter((row) => row.evidence.evidencePaths.length > 0)
    .map((row) => ({
      candidate: {
        issueNumber: row.evidence.issue.number,
        title: row.evidence.issue.title,
        url: row.evidence.issue.url,
        labels: row.evidence.issue.labels,
        score: keywordScore(
          queryText,
          `${row.evidence.issue.title}\n${row.evidence.issue.labels.join(" ")}`,
        ),
      },
      evidence: row.evidence,
    }))
    .sort(
      (left, right) =>
        right.candidate.score - left.candidate.score ||
        left.candidate.issueNumber - right.candidate.issueNumber,
    )
    .slice(0, topK);

  return aggregateRecommendation(
    evidenceRows.map((row) => row.candidate),
    evidenceRows,
  );
}

async function generateSemanticGraphRecommendation(
  benchmarkCase: BenchmarkCase,
  embeddingIndex: ReturnType<typeof loadEmbeddingIndex>,
  topK = 5,
): Promise<RecommendationResult> {
  const provider = createEmbeddingProvider();
  const queryText = [benchmarkCase.title, benchmarkCase.body]
    .filter(Boolean)
    .join("\n\n");
  const queryVector = await provider.embedOne(queryText);

  const rankedCandidates = embeddingIndex
    .map<BaselineCandidate>((record) => ({
      issueNumber: record.issueNumber,
      title: record.title,
      url: record.url,
      labels: record.labels,
      score: cosineSimilarity(queryVector, record.vector),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.issueNumber - right.issueNumber,
    )
    .slice(0, Math.max(topK * 6, 24));

  const evidenceRows = (
    await Promise.all(
      rankedCandidates.map(async (candidate) => ({
        candidate,
        evidence: await fetchIssueEvidence(candidate.issueNumber),
      })),
    )
  )
    .filter(
      (
        row,
      ): row is { candidate: BaselineCandidate; evidence: QueryIssueResult } =>
        row.evidence !== null,
    )
    .filter((row) => row.evidence.evidencePaths.length > 0)
    .slice(0, topK);

  return aggregateRecommendation(
    evidenceRows.map((row) => row.candidate),
    evidenceRows,
  );
}

function initializeMetrics(): SystemMetrics {
  return {
    evaluated_cases: 0,
    component_accuracy: 0,
    component_top3_accuracy: 0,
    duplicate_support_rate: 0,
    component_aligned_file_hit_rate: 0,
    focused_file_recall_at_5: 0,
    evidence_path_validity_rate: 0,
    average_confidence: 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const holdoutSplit = loadHoldoutSplit();
  const cases = args.limit
    ? holdoutSplit.test_cases.slice(0, args.limit)
    : holdoutSplit.test_cases;
  const embeddingIndex = loadEmbeddingIndex();
  const systems: SystemName[] = [
    "lexical_graph",
    "semantic_graph",
    "full_graph_aware",
  ];
  const accumulators = Object.fromEntries(
    systems.map((name) => [name, initializeMetrics()]),
  ) as Record<SystemName, SystemMetrics>;
  const difficultCases: ValidationCaseRow[] = [];

  for (const benchmarkCase of cases) {
    const focusedExpectedFiles = deriveFocusedExpectedFiles(benchmarkCase);
    const outputs: Record<SystemName, RecommendationResult> = {
      lexical_graph: await generateLexicalGraphRecommendation(benchmarkCase),
      semantic_graph: await generateSemanticGraphRecommendation(
        benchmarkCase,
        embeddingIndex,
      ),
      full_graph_aware: await generateRecommendation({
        title: benchmarkCase.title,
        description: benchmarkCase.body,
        topK: 5,
      }),
    };

    const caseRow: ValidationCaseRow = {
      issue_number: benchmarkCase.issue_number,
      expected_component: benchmarkCase.expected.component,
      title: benchmarkCase.title,
      outcomes: {
        lexical_graph: {
          predicted_component: outputs.lexical_graph.suggested_component,
          confidence: outputs.lexical_graph.confidence,
          duplicate_issue:
            outputs.lexical_graph.possible_duplicate.issue_number,
          top_files: outputs.lexical_graph.likely_impacted_files
            .slice(0, 5)
            .map((file) => file.file_path),
          top_similar_issues: outputs.lexical_graph.similar_tickets
            .slice(0, 3)
            .map((ticket) => ticket.issue_number),
          focused_file_hit: false,
          component_correct: false,
        },
        semantic_graph: {
          predicted_component: outputs.semantic_graph.suggested_component,
          confidence: outputs.semantic_graph.confidence,
          duplicate_issue:
            outputs.semantic_graph.possible_duplicate.issue_number,
          top_files: outputs.semantic_graph.likely_impacted_files
            .slice(0, 5)
            .map((file) => file.file_path),
          top_similar_issues: outputs.semantic_graph.similar_tickets
            .slice(0, 3)
            .map((ticket) => ticket.issue_number),
          focused_file_hit: false,
          component_correct: false,
        },
        full_graph_aware: {
          predicted_component: outputs.full_graph_aware.suggested_component,
          confidence: outputs.full_graph_aware.confidence,
          duplicate_issue:
            outputs.full_graph_aware.possible_duplicate.issue_number,
          top_files: outputs.full_graph_aware.likely_impacted_files
            .slice(0, 5)
            .map((file) => file.file_path),
          top_similar_issues: outputs.full_graph_aware.similar_tickets
            .slice(0, 3)
            .map((ticket) => ticket.issue_number),
          focused_file_hit: false,
          component_correct: false,
        },
      },
    };

    for (const system of systems) {
      const recommendation = outputs[system];
      const topFilesAt5 = recommendation.likely_impacted_files
        .slice(0, 5)
        .map((file) => file.file_path);
      const top3Components = unique(
        recommendation.likely_impacted_files
          .map((file) => file.component)
          .filter((component) => component !== "Unknown"),
      ).slice(0, 3);
      const componentCorrect =
        recommendation.suggested_component === benchmarkCase.expected.component;
      const componentTop3Correct =
        componentCorrect ||
        top3Components.includes(benchmarkCase.expected.component);
      const componentAlignedHit = recommendation.likely_impacted_files.some(
        (file) => file.component === benchmarkCase.expected.component,
      );
      const focusedRecallAt5 = recall(focusedExpectedFiles, topFilesAt5);
      const evidencePathValid =
        recommendation.evidence_path.length > 0 &&
        recommendation.evidence_path.every((pathRow) =>
          isEvidencePathValid(pathRow),
        );

      accumulators[system].evaluated_cases += 1;
      accumulators[system].component_accuracy += componentCorrect ? 1 : 0;
      accumulators[system].component_top3_accuracy += componentTop3Correct
        ? 1
        : 0;
      accumulators[system].duplicate_support_rate +=
        recommendation.similar_tickets.length > 0 ? 1 : 0;
      accumulators[system].component_aligned_file_hit_rate +=
        componentAlignedHit ? 1 : 0;
      accumulators[system].focused_file_recall_at_5 += focusedRecallAt5;
      accumulators[system].evidence_path_validity_rate += evidencePathValid
        ? 1
        : 0;
      accumulators[system].average_confidence += recommendation.confidence;

      caseRow.outcomes[system].focused_file_hit = focusedRecallAt5 > 0;
      caseRow.outcomes[system].component_correct = componentCorrect;
    }

    const fullGraphOutcome = caseRow.outcomes.full_graph_aware;

    if (
      !fullGraphOutcome.component_correct ||
      !fullGraphOutcome.focused_file_hit
    ) {
      difficultCases.push(caseRow);
    }
  }

  for (const system of systems) {
    const evaluated = Math.max(accumulators[system].evaluated_cases, 1);
    accumulators[system].component_accuracy /= evaluated;
    accumulators[system].component_top3_accuracy /= evaluated;
    accumulators[system].duplicate_support_rate /= evaluated;
    accumulators[system].component_aligned_file_hit_rate /= evaluated;
    accumulators[system].focused_file_recall_at_5 /= evaluated;
    accumulators[system].evidence_path_validity_rate /= evaluated;
    accumulators[system].average_confidence /= evaluated;
  }

  const full = accumulators.full_graph_aware;
  const thresholdAssessment = {
    component_accuracy_target: 0.6,
    component_top3_accuracy_target: 0.8,
    evidence_path_validity_target: 0.95,
    component_aligned_file_hit_target: 0.75,
    supported:
      full.component_accuracy >= 0.6 &&
      full.component_top3_accuracy >= 0.8 &&
      full.evidence_path_validity_rate >= 0.95 &&
      full.component_aligned_file_hit_rate >= 0.75,
    reason:
      full.component_accuracy >= 0.6 &&
      full.component_top3_accuracy >= 0.8 &&
      full.evidence_path_validity_rate >= 0.95 &&
      full.component_aligned_file_hit_rate >= 0.75
        ? "The MVP meets the routing-oriented validation thresholds on the held-out set."
        : "The MVP does not yet meet the routing-oriented validation thresholds on the held-out set.",
  };

  const report: ValidationReport = {
    claim_under_test:
      "FixRoute AI helps route and investigate new microsoft/vscode tickets by finding similar historical issues and using graph evidence to recommend likely components, files, and duplicates.",
    test_basis:
      "Chronological 70/30 holdout evaluation on evidence-backed resolved issues from microsoft/vscode using the current train-only graph and train-only embedding index.",
    holdout_metadata: holdoutSplit.metadata,
    metrics: accumulators,
    threshold_assessment: thresholdAssessment,
    comparative_findings: [
      `Full graph-aware component accuracy: ${full.component_accuracy.toFixed(3)}`,
      `Lexical+graph component accuracy: ${accumulators.lexical_graph.component_accuracy.toFixed(3)}`,
      `Semantic+graph component accuracy: ${accumulators.semantic_graph.component_accuracy.toFixed(3)}`,
      `Full graph-aware component top-3 accuracy: ${full.component_top3_accuracy.toFixed(3)}`,
      `Full graph-aware focused file recall@5: ${full.focused_file_recall_at_5.toFixed(3)}`,
      `Full graph-aware evidence path validity: ${full.evidence_path_validity_rate.toFixed(3)}`,
    ],
    difficult_cases_sample: difficultCases.slice(0, 15),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), "utf8");
  logInfo("Product validation complete", report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
