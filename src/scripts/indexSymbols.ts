import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import {
  extractImportsFromSource,
  extractSymbolsFromSource,
  inferTestLinks,
  touchedSymbolsForPatch,
} from "../lib/symbolIndex.js";
import { logInfo } from "../lib/logger.js";
import type {
  CodeSymbol,
  PatchHunk,
  SymbolIndexDataset,
} from "../lib/types.js";

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "code",
  "symbolIndex.json",
);
const PATCH_HUNKS_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "patches",
  "patchHunks.json",
);
const MAX_FILE_BYTES = Number(process.env.CODE_INDEX_MAX_FILE_BYTES || 200000);
const FILE_LIMIT = Number(process.env.CODE_INDEX_FILE_LIMIT || 0);
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "data",
  ".vscode-test",
  "coverage",
  ".next",
]);

function repoDirectoryName(owner: string, repo: string): string {
  return `${owner}__${repo}`;
}

function getSourcePath(owner: string, repo: string): string {
  return path.resolve(
    process.cwd(),
    process.env.TARGET_REPO_PATH ||
      path.join("data", "raw", "repos", repoDirectoryName(owner, repo)),
  );
}

function walkFiles(root: string): string[] {
  const files: string[] = [];

  function walk(currentPath: string): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(entryPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        continue;
      }

      const stats = fs.statSync(entryPath);

      if (stats.size <= MAX_FILE_BYTES) {
        files.push(entryPath);
      }
    }
  }

  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function loadOptionalJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function saveDataset(dataset: SymbolIndexDataset): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dataset), "utf8");
}

function main() {
  const env = loadGitHubEnv();
  const sourcePath = getSourcePath(env.GITHUB_OWNER, env.GITHUB_REPO);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Missing target repo at ${sourcePath}. Run clone:target-repo first or set TARGET_REPO_PATH.`,
    );
  }

  const absoluteFiles = walkFiles(sourcePath);
  const selectedFiles =
    FILE_LIMIT > 0 ? absoluteFiles.slice(0, FILE_LIMIT) : absoluteFiles;
  const fileTexts = selectedFiles.map((absoluteFilePath) => {
    const filePath = path
      .relative(sourcePath, absoluteFilePath)
      .split(path.sep)
      .join("/");

    return {
      filePath,
      text: fs.readFileSync(absoluteFilePath, "utf8"),
    };
  });
  const knownFiles = new Set(fileTexts.map((file) => file.filePath));
  const symbols: CodeSymbol[] = fileTexts.flatMap((file) =>
    extractSymbolsFromSource({
      repoOwner: env.GITHUB_OWNER,
      repoName: env.GITHUB_REPO,
      filePath: file.filePath,
      text: file.text,
    }),
  );
  const imports = fileTexts.flatMap((file) =>
    extractImportsFromSource({
      filePath: file.filePath,
      text: file.text,
      knownFiles,
    }),
  );
  const testLinks = inferTestLinks(fileTexts.map((file) => file.filePath));
  const symbolsByFile = new Map<string, CodeSymbol[]>();

  for (const symbol of symbols) {
    symbolsByFile.set(symbol.filePath, [
      ...(symbolsByFile.get(symbol.filePath) || []),
      symbol,
    ]);
  }

  const patchHunks = loadOptionalJsonFile<PatchHunk[]>(PATCH_HUNKS_PATH, []);
  const pullRequestTouchedSymbols = patchHunks.flatMap((hunk) =>
    touchedSymbolsForPatch({
      pullRequestNumber: hunk.pullRequestNumber,
      filePath: hunk.filePath,
      patchText: hunk.patchText,
      symbolsByFile,
    }),
  );
  const dataset: SymbolIndexDataset = {
    symbols,
    imports,
    testLinks,
    pullRequestTouchedSymbols,
    metadata: {
      repoOwner: env.GITHUB_OWNER,
      repoName: env.GITHUB_REPO,
      sourcePath,
      fileCount: selectedFiles.length,
      symbolCount: symbols.length,
      importCount: imports.length,
      testLinkCount: testLinks.length,
      pullRequestTouchedSymbolCount: pullRequestTouchedSymbols.length,
      generatedAt: new Date().toISOString(),
    },
  };

  saveDataset(dataset);

  logInfo("Symbol index complete", {
    outputPath: OUTPUT_PATH,
    ...dataset.metadata,
  });
}

main();
