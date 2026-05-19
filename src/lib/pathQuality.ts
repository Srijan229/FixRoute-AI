export type PathQuality = {
  category:
    | "source"
    | "test"
    | "docs"
    | "config"
    | "generated"
    | "lockfile"
    | "unknown";
  score: number;
  includeInFocusedEvaluation: boolean;
  includeInSemanticIndex: boolean;
  reasons: string[];
};

const GENERATED_PATTERNS = [
  "/__snapshots__/",
  ".snap",
  ".generated.",
  "/generated/",
  "/out/",
  "/dist/",
];

const DOC_PATTERNS = [
  ".md",
  "agents.md",
  "protocol.md",
  "layout.md",
  "/readme",
];

const LOCKFILE_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".lock",
];

const CONFIG_PATTERNS = [
  "package.json",
  "tsconfig.json",
  "eslint.config",
  ".eslintrc",
  ".gitignore",
  ".npmrc",
  "cgmanifest.json",
];

function hasAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

export function getPathQuality(filePath: string): PathQuality {
  const normalized = filePath.toLowerCase();
  const reasons: string[] = [];
  let category: PathQuality["category"] = "unknown";
  let score = 0.75;

  if (hasAny(normalized, LOCKFILE_PATTERNS)) {
    category = "lockfile";
    score = 0.05;
    reasons.push("lockfile");
  } else if (hasAny(normalized, GENERATED_PATTERNS)) {
    category = "generated";
    score = 0.08;
    reasons.push("generated_or_snapshot");
  } else if (hasAny(normalized, DOC_PATTERNS)) {
    category = "docs";
    score = 0.18;
    reasons.push("documentation");
  } else if (hasAny(normalized, CONFIG_PATTERNS)) {
    category = "config";
    score = 0.35;
    reasons.push("configuration");
  } else if (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes(".test.") ||
    normalized.includes(".spec.")
  ) {
    category = "test";
    score = 0.45;
    reasons.push("test_file");
  } else if (
    normalized.startsWith("src/") ||
    normalized.includes("/src/") ||
    normalized.startsWith("extensions/") ||
    normalized.includes("/browser/") ||
    normalized.includes("/common/") ||
    normalized.includes("/node/") ||
    normalized.includes("/electron-browser/")
  ) {
    category = "source";
    score = 1;
    reasons.push("source_file");
  }

  if (
    normalized.endsWith(".ts") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".js") ||
    normalized.endsWith(".jsx")
  ) {
    score += 0.1;
    reasons.push("code_extension");
  }

  if (
    normalized.includes("/browser/") ||
    normalized.includes("/common/") ||
    normalized.includes("/node/")
  ) {
    score += 0.08;
    reasons.push("runtime_area");
  }

  if (
    normalized.includes("/test/") ||
    normalized.includes(".test.") ||
    normalized.includes(".spec.")
  ) {
    score *= 0.7;
  }

  const clampedScore = Math.max(0.01, Math.min(score, 1.25));

  return {
    category,
    score: clampedScore,
    includeInFocusedEvaluation: category === "source",
    includeInSemanticIndex: category !== "generated" && category !== "lockfile",
    reasons,
  };
}

export function getPatchHunkQuality(
  filePath: string,
  patchText: string,
): PathQuality {
  const pathQuality = getPathQuality(filePath);
  const lineCount = patchText.split("\n").length;
  let score = pathQuality.score;
  const reasons = [...pathQuality.reasons];

  if (lineCount > 120) {
    score *= 0.55;
    reasons.push("large_hunk");
  } else if (lineCount > 60) {
    score *= 0.75;
    reasons.push("medium_large_hunk");
  }

  return {
    ...pathQuality,
    score: Math.max(0.01, Math.min(score, 1.25)),
    includeInSemanticIndex:
      pathQuality.includeInSemanticIndex && lineCount <= 160,
    reasons,
  };
}
