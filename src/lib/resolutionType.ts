export type ResolutionType =
  | "existing_bug"
  | "new_feature"
  | "enhancement"
  | "enhancement_with_new_files"
  | "refactor"
  | "docs"
  | "config"
  | "test"
  | "unknown";

export type WorkSurface =
  | "ui"
  | "api"
  | "service"
  | "config"
  | "test"
  | "docs"
  | "data"
  | "build"
  | "infra";

export type ImplementationScope = "small" | "medium" | "large" | "unknown";

export type ResolutionTypePrediction = {
  resolution_type: ResolutionType;
  requires_new_files: boolean;
  requires_existing_file_edits: boolean;
  likely_surface: WorkSurface[];
  implementation_scope: ImplementationScope;
  confidence: number;
  reasoning: string;
  evidence_terms: string[];
  missing_capability: boolean;
  existing_behavior_broken: boolean;
  new_file_probability: number;
  existing_file_edit_probability: number;
  non_code_probability: number;
};

type Signal = {
  type: ResolutionType;
  terms: string[];
  weight: number;
};

const SIGNALS: Signal[] = [
  {
    type: "existing_bug",
    weight: 1.15,
    terms: [
      "crash",
      "broken",
      "regression",
      "wrong behavior",
      "expected",
      "actual",
      "stack trace",
      "error",
      "previously worked",
      "fails",
      "cannot",
      "unable",
    ],
  },
  {
    type: "new_feature",
    weight: 1.2,
    terms: [
      "add ",
      "add support for",
      "implement",
      "introduce",
      "create",
      "new option",
      "new feature",
      "allow users to",
      "no way to",
      "missing capability",
      "support ",
      "feature request",
    ],
  },
  {
    type: "enhancement",
    weight: 1,
    terms: [
      "improve",
      "extend",
      "make it possible",
      "add option",
      "add option to",
      "expose",
      "support additional",
      "include",
      "allow",
      "include timestamps",
      "existing feature",
      "existing behavior",
    ],
  },
  {
    type: "docs",
    weight: 1.35,
    terms: ["documentation", "readme", "docs", "clarify", "guide", "examples"],
  },
  {
    type: "config",
    weight: 1.1,
    terms: ["configuration", "setting", "settings", "package", "dependency"],
  },
  {
    type: "test",
    weight: 1.25,
    terms: ["test failure", "flaky test", "failing test", "unit test", "e2e"],
  },
  {
    type: "refactor",
    weight: 1.1,
    terms: ["refactor", "cleanup", "rename", "move", "restructure"],
  },
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function scoreSignals(text: string): {
  scores: Map<ResolutionType, number>;
  terms: Map<ResolutionType, string[]>;
} {
  const scores = new Map<ResolutionType, number>();
  const terms = new Map<ResolutionType, string[]>();

  for (const signal of SIGNALS) {
    for (const term of signal.terms) {
      if (text.includes(term)) {
        scores.set(signal.type, (scores.get(signal.type) || 0) + signal.weight);
        terms.set(signal.type, [...(terms.get(signal.type) || []), term.trim()]);
      }
    }
  }

  return { scores, terms };
}

function inferSurfaces(text: string): WorkSurface[] {
  const surfaces: WorkSurface[] = [];

  if (/\b(ui|button|view|panel|widget|menu|screen|css|layout)\b/.test(text)) {
    surfaces.push("ui");
  }

  if (/\b(api|endpoint|route|request|response|protocol)\b/.test(text)) {
    surfaces.push("api");
  }

  if (/\b(service|provider|manager|controller|model|state)\b/.test(text)) {
    surfaces.push("service");
  }

  if (/\b(config|configuration|setting|settings|preference|option)\b/.test(text)) {
    surfaces.push("config");
  }

  if (/\b(test|spec|flaky|assert|coverage)\b/.test(text)) {
    surfaces.push("test");
  }

  if (/\b(doc|docs|documentation|readme|guide|example)\b/.test(text)) {
    surfaces.push("docs");
  }

  if (/\b(data|dataset|database|schema|migration|storage)\b/.test(text)) {
    surfaces.push("data");
  }

  if (/\b(build|bundle|compile|package|dependency|npm|webpack|esbuild)\b/.test(text)) {
    surfaces.push("build");
  }

  if (/\b(ci|infra|docker|deploy|workflow|pipeline|linux|windows|macos)\b/.test(text)) {
    surfaces.push("infra");
  }

  return unique(surfaces.length > 0 ? surfaces : ["service"]);
}

function inferScope(text: string, type: ResolutionType): ImplementationScope {
  if (
    /\b(project-wide|all|multiple|architecture|framework|redesign|migrate)\b/.test(
      text,
    )
  ) {
    return "large";
  }

  if (
    type === "new_feature" ||
    /\b(add support|new feature|implement|introduce|workflow)\b/.test(text)
  ) {
    return "medium";
  }

  if (/\b(typo|copy|small|single|one|minor)\b/.test(text)) {
    return "small";
  }

  return type === "unknown" ? "unknown" : "medium";
}

function hasStrongNewCapabilitySignal(text: string): boolean {
  return /\b(add|create|introduce|implement)\b.{0,50}\b(button|command|view|panel|api|endpoint|service|provider|action|menu|feature|support)\b/.test(
    text,
  );
}

function hasTitleLevelNewCapabilitySignal(text: string): boolean {
  return /^(feature request:\s*)?\b(add|create|introduce|implement|support)\b.{0,80}\b(button|command|view|panel|api|endpoint|service|provider|action|menu|feature|support|rendering)\b/.test(
    text,
  );
}

function hasMissingCapabilitySignal(text: string): boolean {
  return /\b(no way to|missing capability|not possible|cannot currently|feature request|add support for|new feature)\b/.test(
    text,
  );
}

function hasIncrementalEnhancementSignal(text: string): boolean {
  return (
    /\b(allow|include|extend|improve|expose|support additional|add option|make it possible)\b/.test(
      text,
    ) &&
    /\b(existing|current|already|export|setting|option|behavior|feature|flow|timestamps?|additional|case)\b/.test(
      text,
    )
  );
}

function hasQualityEnhancementSignal(text: string): boolean {
  return /\b(polish|refinement|refinements|confusing|unintuitive|inintuitive|delay|slow|placement|display name|cursor|color|telemetry gaps|gap|stale|wrong cursor|pricing|spend strings|header)\b/.test(
    text,
  );
}

function hasActionNounMention(text: string): boolean {
  return /\b(add|export|pin|manage|run|sync|focus|support|feedback)\b.{0,35}\b(button|menu|command|action|widget|view|panel|tool|task|model|option)\b/.test(
    text,
  );
}

export function classifyIssueResolution(input: {
  title: string;
  body?: string | null;
  labels?: string[];
}): ResolutionTypePrediction {
  const text = normalize(
    [input.title, input.body || "", ...(input.labels || [])].join("\n"),
  );
  const { scores, terms } = scoreSignals(text);
  const ranked = Array.from(scores.entries()).sort(
    (left, right) => right[1] - left[1],
  );
  const best = ranked[0];
  const totalScore = ranked.reduce((sum, [, score]) => sum + score, 0);
  let resolutionType = best ? best[0] : "unknown";
  const bestScore = best?.[1] || 0;
  const missingCapabilitySignal = hasMissingCapabilitySignal(text);
  const strongNewCapabilitySignal = hasStrongNewCapabilitySignal(text);
  const titleLevelNewCapabilitySignal = hasTitleLevelNewCapabilitySignal(text);
  const incrementalEnhancementSignal = hasIncrementalEnhancementSignal(text);
  const qualityEnhancementSignal = hasQualityEnhancementSignal(text);
  const actionNounMention = hasActionNounMention(text);

  if (
    qualityEnhancementSignal &&
    resolutionType !== "existing_bug" &&
    resolutionType !== "docs" &&
    resolutionType !== "config" &&
    resolutionType !== "test"
  ) {
    resolutionType = "enhancement";
  }

  if (
    (incrementalEnhancementSignal || actionNounMention) &&
    !missingCapabilitySignal &&
    !titleLevelNewCapabilitySignal &&
    resolutionType !== "existing_bug" &&
    resolutionType !== "docs" &&
    resolutionType !== "config" &&
    resolutionType !== "test"
  ) {
    resolutionType = "enhancement";
  }

  if (
    titleLevelNewCapabilitySignal &&
    (missingCapabilitySignal || !incrementalEnhancementSignal) &&
    resolutionType !== "existing_bug" &&
    resolutionType !== "docs" &&
    resolutionType !== "config" &&
    resolutionType !== "test"
  ) {
    resolutionType = "new_feature";
  }

  if (
    resolutionType === "new_feature" &&
    !missingCapabilitySignal &&
    !titleLevelNewCapabilitySignal &&
    (incrementalEnhancementSignal || actionNounMention || qualityEnhancementSignal)
  ) {
    resolutionType = "enhancement";
  }

  const confidence =
    resolutionType === "unknown"
      ? 0.25
      : clamp(0.45 + bestScore / Math.max(totalScore * 1.8, 4), 0.45, 0.92);
  const evidenceTerms = unique(terms.get(resolutionType) || []).slice(0, 12);
  const missingCapability =
    resolutionType === "new_feature" ||
    missingCapabilitySignal;
  const existingBehaviorBroken =
    resolutionType === "existing_bug" ||
    /\b(regression|previously worked|expected|actual|broken|crash|fails)\b/.test(
      text,
    );
  const likelySurface = inferSurfaces(text);
  const implementationScope = inferScope(text, resolutionType);
  const nonCodeProbability =
    resolutionType === "docs" || resolutionType === "config" || resolutionType === "test"
      ? 0.78
      : likelySurface.some((surface) =>
            ["docs", "config", "test", "build", "infra"].includes(surface),
          )
        ? 0.38
        : 0.12;
  const newFileProbability =
    resolutionType === "new_feature"
      ? 0.72
      : resolutionType === "enhancement"
        ? 0.34
        : resolutionType === "docs" || resolutionType === "test"
          ? 0.28
          : 0.12;
  const existingFileEditProbability =
    resolutionType === "existing_bug"
      ? 0.86
      : resolutionType === "enhancement"
        ? 0.78
        : resolutionType === "new_feature"
          ? 0.62
          : resolutionType === "unknown"
            ? 0.45
            : 0.58;

  return {
    resolution_type: resolutionType,
    requires_new_files: newFileProbability >= 0.5,
    requires_existing_file_edits: existingFileEditProbability >= 0.5,
    likely_surface: likelySurface,
    implementation_scope: implementationScope,
    confidence: Number(confidence.toFixed(3)),
    reasoning:
      evidenceTerms.length > 0
        ? `Classified as ${resolutionType} from terms: ${evidenceTerms.join(", ")}.`
        : "No strong resolution-type signals found; route with human review.",
    evidence_terms: evidenceTerms,
    missing_capability: missingCapability,
    existing_behavior_broken: existingBehaviorBroken,
    new_file_probability: Number(newFileProbability.toFixed(3)),
    existing_file_edit_probability: Number(
      existingFileEditProbability.toFixed(3),
    ),
    non_code_probability: Number(nonCodeProbability.toFixed(3)),
  };
}
