import path from "node:path";
import { mapFilePathToComponent } from "./componentMapper.js";
import type {
  CodeSymbol,
  CodeSymbolKind,
  FileImport,
  PullRequestTouchedSymbol,
  TestLink,
} from "./types.js";

type SourceFileInput = {
  repoOwner: string;
  repoName: string;
  filePath: string;
  text: string;
};

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const IMPORT_REGEX =
  /import\s+(?:(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z0-9_$*\s,]+))\s+from\s+)?["']([^"']+)["']/g;
const MAX_SYMBOLS_PER_FILE = 200;
const MAX_IMPORTS_PER_FILE = 200;
const IGNORED_METHOD_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
]);

function languageForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".ts" || extension === ".tsx") return "typescript";
  if (extension === ".js" || extension === ".jsx") return "javascript";
  return "text";
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function cleanSymbolList(rawSymbols: string | undefined): string[] {
  if (!rawSymbols) {
    return [];
  }

  return rawSymbols
    .split(",")
    .map((symbol) =>
      symbol
        .replace(/\bas\b\s+[A-Za-z0-9_$]+/g, "")
        .replace(/\btype\b/g, "")
        .trim(),
    )
    .filter(Boolean);
}

function symbolId(filePath: string, name: string, startLine: number): string {
  return `${filePath}:${name}:${startLine}`;
}

function contextForLines(
  lines: string[],
  lineNumber: number,
  radius = 6,
): { startLine: number; endLine: number; text: string } {
  const startLine = Math.max(1, lineNumber - radius);
  const endLine = Math.min(lines.length, lineNumber + radius);

  return {
    startLine,
    endLine,
    text: lines.slice(startLine - 1, endLine).join("\n").trim().slice(0, 2400),
  };
}

function makeSymbol(input: {
  repoOwner: string;
  repoName: string;
  filePath: string;
  lines: string[];
  lineNumber: number;
  name: string;
  kind: CodeSymbolKind;
  exported: boolean;
  signature: string;
}): CodeSymbol {
  const context = contextForLines(input.lines, input.lineNumber);

  return {
    id: symbolId(input.filePath, input.name, input.lineNumber),
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    filePath: input.filePath,
    component: mapFilePathToComponent(input.filePath),
    language: languageForPath(input.filePath),
    name: input.name,
    kind: input.kind,
    exported: input.exported,
    startLine: input.lineNumber,
    endLine: context.endLine,
    signature: input.signature.trim(),
    context: context.text,
  };
}

function addSymbol(
  symbols: CodeSymbol[],
  seen: Set<string>,
  symbol: CodeSymbol,
): void {
  if (symbols.length >= MAX_SYMBOLS_PER_FILE) {
    return;
  }

  if (seen.has(symbol.id)) {
    return;
  }

  seen.add(symbol.id);
  symbols.push(symbol);
}

export function extractSymbolsFromSource(input: SourceFileInput): CodeSymbol[] {
  if (!isCodeFile(input.filePath)) {
    return [];
  }

  const lines = input.text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    const exported = /\bexport\b/.test(trimmed);
    const patterns: Array<{
      kind: CodeSymbolKind;
      pattern: RegExp;
      group?: number;
    }> = [
      { kind: "class", pattern: /\b(?:export\s+)?class\s+([A-Za-z0-9_$]+)/ },
      {
        kind: "interface",
        pattern: /\b(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
      },
      { kind: "type", pattern: /\b(?:export\s+)?type\s+([A-Za-z0-9_$]+)/ },
      { kind: "enum", pattern: /\b(?:export\s+)?enum\s+([A-Za-z0-9_$]+)/ },
      {
        kind: "function",
        pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
      },
      {
        kind: "constant",
        pattern: /\b(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/,
      },
      {
        kind: "method",
        pattern:
          /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*[:{]/,
      },
    ];

    for (const { kind, pattern, group = 1 } of patterns) {
      const match = trimmed.match(pattern);

      if (!match?.[group]) {
        continue;
      }

      if (
        kind === "method" &&
        IGNORED_METHOD_NAMES.has(match[group].toLowerCase())
      ) {
        continue;
      }

      addSymbol(
        symbols,
        seen,
        makeSymbol({
          repoOwner: input.repoOwner,
          repoName: input.repoName,
          filePath: input.filePath,
          lines,
          lineNumber,
          name: match[group],
          kind,
          exported,
          signature: trimmed,
        }),
      );
      break;
    }

    const commandMatch = trimmed.match(
      /(?:registerCommand|registerAction2|MenuRegistry\.appendMenuItem|id:)\s*\(?\s*["'`]([^"'`]+)["'`]/,
    );

    if (commandMatch?.[1]) {
      addSymbol(
        symbols,
        seen,
        makeSymbol({
          repoOwner: input.repoOwner,
          repoName: input.repoName,
          filePath: input.filePath,
          lines,
          lineNumber,
          name: commandMatch[1],
          kind: "command",
          exported: false,
          signature: trimmed,
        }),
      );
    }

    if (/\b(registerWorkbenchContribution|Registry\.as|contribution)\b/.test(trimmed)) {
      const contributionName =
        trimmed.match(/([A-Za-z0-9_$]+Contribution[A-Za-z0-9_$]*)/)?.[1] ||
        `${path.basename(input.filePath)}:${lineNumber}`;

      addSymbol(
        symbols,
        seen,
        makeSymbol({
          repoOwner: input.repoOwner,
          repoName: input.repoName,
          filePath: input.filePath,
          lines,
          lineNumber,
          name: contributionName,
          kind: "contribution",
          exported: false,
          signature: trimmed,
        }),
      );
    }
  });

  return symbols;
}

export function extractImportsFromSource(input: {
  filePath: string;
  text: string;
  knownFiles: Set<string>;
}): FileImport[] {
  if (!isCodeFile(input.filePath)) {
    return [];
  }

  const imports: FileImport[] = [];
  let match: RegExpExecArray | null;

  while ((match = IMPORT_REGEX.exec(input.text))) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) {
      break;
    }

    const importedPath = match[3];
    imports.push({
      sourceFile: input.filePath,
      importedPath,
      importedSymbols: [
        ...cleanSymbolList(match[1]),
        ...cleanSymbolList(match[2]),
      ],
      resolvedFile: resolveImportPath(
        input.filePath,
        importedPath,
        input.knownFiles,
      ),
    });
  }

  return imports;
}

export function resolveImportPath(
  sourceFile: string,
  importedPath: string,
  knownFiles: Set<string>,
): string | null {
  if (!importedPath.startsWith(".")) {
    return null;
  }

  const sourceDir = path.posix.dirname(sourceFile);
  const base = path.posix.normalize(path.posix.join(sourceDir, importedPath));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
    path.posix.join(base, "index.js"),
    path.posix.join(base, "index.jsx"),
  ];

  return candidates.find((candidate) => knownFiles.has(candidate)) || null;
}

export function inferTestLinks(files: string[]): TestLink[] {
  const knownFiles = new Set(files);
  const links: TestLink[] = [];

  for (const filePath of files) {
    if (!/(\/test\/|\/tests\/|\.test\.|\.spec\.)/.test(filePath)) {
      continue;
    }

    const candidates = sourceCandidatesForTest(filePath);
    const sourceFile = candidates.find((candidate) => knownFiles.has(candidate));

    if (!sourceFile) {
      continue;
    }

    links.push({
      testFile: filePath,
      sourceFile,
      confidence: 0.72,
      reason: "Matched source/test naming convention.",
    });
  }

  return links;
}

function sourceCandidatesForTest(filePath: string): string[] {
  const withoutTestDir = filePath.replace(/\/test(s)?\//, "/");
  const withoutTestSuffix = withoutTestDir
    .replace(/\.test(\.[tj]sx?)$/, "$1")
    .replace(/\.spec(\.[tj]sx?)$/, "$1");
  const basename = path.posix.basename(withoutTestSuffix);
  const dirname = path.posix.dirname(withoutTestSuffix);
  const parentDirname = dirname.replace(/\/browser$|\/common$|\/node$/, "");

  return Array.from(
    new Set([
      withoutTestSuffix,
      path.posix.join(parentDirname, basename),
      withoutTestSuffix.replace("/test/", "/browser/"),
      withoutTestSuffix.replace("/test/", "/common/"),
      withoutTestSuffix.replace("/test/browser/", "/browser/"),
      withoutTestSuffix.replace("/test/common/", "/common/"),
    ]),
  );
}

export function touchedSymbolsForPatch(input: {
  pullRequestNumber: number;
  filePath: string;
  patchText: string;
  symbolsByFile: Map<string, CodeSymbol[]>;
}): PullRequestTouchedSymbol[] {
  const symbols = input.symbolsByFile.get(input.filePath) || [];
  const patchText = input.patchText.toLowerCase();

  return symbols
    .filter(
      (symbol) =>
        patchText.includes(symbol.name.toLowerCase()) ||
        patchText.includes(symbol.signature.toLowerCase().slice(0, 80)),
    )
    .slice(0, 20)
    .map((symbol) => ({
      pullRequestNumber: input.pullRequestNumber,
      filePath: input.filePath,
      symbolId: symbol.id,
      symbolName: symbol.name,
      symbolKind: symbol.kind,
    }));
}
