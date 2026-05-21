import { mapFilePathToComponent } from "./componentMapper.js";
import { getPathQuality } from "./pathQuality.js";
import { impactAreaForFile } from "./fixProfile.js";
import {
  classifyIssueResolution,
  type ResolutionType,
  type WorkSurface,
} from "./resolutionType.js";
import type {
  GitHubPullRequest,
  PatchHunk,
  PullRequestCommit,
  PullRequestFile,
} from "./types.js";

export type ImplementationPattern = {
  pr_number: number;
  title: string;
  body: string;
  resolution_type: ResolutionType;
  created_files: string[];
  modified_existing_files: string[];
  deleted_files: string[];
  renamed_files: string[];
  new_symbols_added: string[];
  existing_symbols_modified: string[];
  components: string[];
  areas: string[];
  surfaces: WorkSurface[];
  tests_added_or_modified: string[];
  config_files_modified: string[];
  implementation_pattern: string;
  pattern_summary: string;
  pattern_tags: string[];
  label_weight: number;
};

const SYMBOL_DECLARATION_REGEX =
  /^\+\s*(?:export\s+)?(?:class|function|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const SYMBOL_REFERENCE_REGEX =
  /^[+-]\s*.*\b([A-Za-z_$][A-Za-z0-9_$]*(?:Service|Controller|Provider|Contribution|Widget|View|Pane|Editor|Model|Session|Tool|Action|Renderer|Part))\b/gm;

function compactList<T extends string>(values: T[], limit: number): T[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, limit);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function filesByStatus(files: PullRequestFile[], status: string): string[] {
  return files
    .filter((file) => file.status === status)
    .map((file) => file.filename)
    .filter((filePath) => getPathQuality(filePath).score >= 0.15);
}

function extractMatches(text: string, regex: RegExp): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

function inferPatternTags(pattern: ImplementationPattern): string[] {
  const tags: string[] = [pattern.resolution_type];

  if (pattern.created_files.length > 0) tags.push("creates_files");
  if (pattern.tests_added_or_modified.length > 0) tags.push("tests");
  if (pattern.config_files_modified.length > 0) tags.push("config");
  if (pattern.surfaces.length > 0) tags.push(...pattern.surfaces);
  if (pattern.components.length > 0) tags.push(...pattern.components);

  return compactList(tags, 12);
}

function inferPatternSurfaces(files: string[], text: string): WorkSurface[] {
  const joined = [files.join("\n"), text].join("\n").toLowerCase();
  const surfaces: WorkSurface[] = [];

  if (/\b(browser|widget|view|menu|action|css|ui|button)\b/.test(joined)) {
    surfaces.push("ui");
  }

  if (/\b(api|endpoint|route|protocol|request|response)\b/.test(joined)) {
    surfaces.push("api");
  }

  if (/\b(common|service|provider|manager|controller|model|state)\b/.test(joined)) {
    surfaces.push("service");
  }

  if (/\b(config|configuration|setting|package\.json|\.json|\.yml)\b/.test(joined)) {
    surfaces.push("config");
  }

  if (/\b(test|spec)\b/.test(joined)) {
    surfaces.push("test");
  }

  if (/\b(readme|docs?|markdown|\.md)\b/.test(joined)) {
    surfaces.push("docs");
  }

  if (/\b(build|gulp|webpack|esbuild|npm|dependency)\b/.test(joined)) {
    surfaces.push("build");
  }

  return compactList(surfaces.length > 0 ? surfaces : ["service"], 6);
}

export function buildImplementationPattern(input: {
  pullRequest: GitHubPullRequest;
  files: PullRequestFile[];
  commits?: PullRequestCommit[];
  patchHunks?: PatchHunk[];
}): ImplementationPattern {
  const createdFiles = filesByStatus(input.files, "added");
  const modifiedExistingFiles = filesByStatus(input.files, "modified");
  const deletedFiles = filesByStatus(input.files, "removed");
  const renamedFiles = filesByStatus(input.files, "renamed");
  const relevantFiles = [
    ...createdFiles,
    ...modifiedExistingFiles,
    ...renamedFiles,
  ];
  const components = compactList(relevantFiles.map(mapFilePathToComponent), 8);
  const areas = compactList(relevantFiles.map(impactAreaForFile), 12);
  const testsAddedOrModified = input.files
    .map((file) => file.filename)
    .filter((filePath) => getPathQuality(filePath).category === "test");
  const configFilesModified = input.files
    .map((file) => file.filename)
    .filter((filePath) => getPathQuality(filePath).category === "config");
  const patchText = (input.patchHunks || [])
    .slice(0, 50)
    .map((hunk) => hunk.patchText)
    .join("\n");
  const newSymbolsAdded = compactList(
    extractMatches(patchText, SYMBOL_DECLARATION_REGEX),
    20,
  );
  const existingSymbolsModified = compactList(
    extractMatches(patchText, SYMBOL_REFERENCE_REGEX),
    20,
  );
  const commitText = (input.commits || [])
    .map((commit) => commit.commit.message)
    .join("\n");
  const resolution = classifyIssueResolution({
    title: input.pullRequest.title,
    body: [input.pullRequest.body || "", commitText].join("\n"),
  });
  const changedFileCount = Math.max(input.files.length, 1);
  const labelWeight = 1 / Math.log(2 + changedFileCount);
  const surfaces = inferPatternSurfaces(relevantFiles, [
    input.pullRequest.title,
    input.pullRequest.body || "",
    commitText,
  ].join("\n"));
  const pattern: ImplementationPattern = {
    pr_number: input.pullRequest.number,
    title: input.pullRequest.title,
    body: input.pullRequest.body || "",
    resolution_type:
      resolution.resolution_type === "existing_bug" && createdFiles.length > 0
        ? "enhancement"
        : resolution.resolution_type,
    created_files: createdFiles,
    modified_existing_files: modifiedExistingFiles,
    deleted_files: deletedFiles,
    renamed_files: renamedFiles,
    new_symbols_added: newSymbolsAdded,
    existing_symbols_modified: existingSymbolsModified,
    components,
    areas,
    surfaces,
    tests_added_or_modified: testsAddedOrModified,
    config_files_modified: configFilesModified,
    implementation_pattern: "",
    pattern_summary: "",
    pattern_tags: [],
    label_weight: Number(labelWeight.toFixed(3)),
  };

  pattern.implementation_pattern = normalizeWhitespace(
    [
      createdFiles.length > 0 ? "creates new files" : "",
      modifiedExistingFiles.length > 0 ? "modifies existing files" : "",
      testsAddedOrModified.length > 0 ? "updates tests" : "",
      configFilesModified.length > 0 ? "updates config" : "",
      areas.length > 0 ? `areas ${areas.slice(0, 4).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  pattern.pattern_summary = normalizeWhitespace(
    [
      `PR #${input.pullRequest.number}: ${input.pullRequest.title}`,
      `Resolution type: ${pattern.resolution_type}`,
      `Surfaces: ${pattern.surfaces.join(", ")}`,
      pattern.implementation_pattern,
      createdFiles.length > 0
        ? `Created files: ${createdFiles.slice(0, 8).join(", ")}`
        : "",
      modifiedExistingFiles.length > 0
        ? `Modified files: ${modifiedExistingFiles.slice(0, 8).join(", ")}`
        : "",
      newSymbolsAdded.length > 0
        ? `New symbols: ${newSymbolsAdded.slice(0, 8).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  pattern.pattern_tags = inferPatternTags(pattern);

  return pattern;
}

export function formatImplementationPattern(pattern: ImplementationPattern): string {
  return [
    `Pattern Name: ${pattern.resolution_type} in ${pattern.components.join(", ") || "Unknown"}`,
    `Intent: ${pattern.title}`,
    `Components: ${pattern.components.join("; ") || "unknown"}`,
    `Areas: ${pattern.areas.join("; ") || "unknown"}`,
    `Surfaces: ${pattern.surfaces.join("; ") || "unknown"}`,
    `Typical Files Created: ${pattern.created_files.join("; ") || "none"}`,
    `Typical Files Modified: ${pattern.modified_existing_files.join("; ") || "none"}`,
    `Typical Tests Added: ${pattern.tests_added_or_modified.join("; ") || "none"}`,
    `Summary: ${pattern.pattern_summary}`,
    `Tags: ${pattern.pattern_tags.join("; ") || "unknown"}`,
  ].join("\n");
}
