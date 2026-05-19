import fs from "node:fs";
import path from "node:path";
import {
  createEmbeddingProvider,
  cosineSimilarity,
} from "../lib/embeddings.js";
import type { RichSemanticIndex } from "../lib/types.js";

const INDEX_PATH = path.resolve(
  process.cwd(),
  process.env.CODE_SEMANTIC_INDEX_FILE_PATH ||
    "data/processed/semantic/codeSemanticIndex.json",
);

type Args = {
  query: string;
  topK: number;
};

function parseArgs(argv: string[]): Args {
  let query = "";
  let topK = 10;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--query" && next) {
      query = next.trim();
      index += 1;
      continue;
    }

    if (current === "--top-k" && next) {
      topK = Number(next);
      index += 1;
    }
  }

  if (!query) {
    throw new Error("Provide --query");
  }

  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("--top-k must be a positive number");
  }

  return { query, topK };
}

function loadIndex(): RichSemanticIndex {
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error(
      "Missing code semantic index. Run create:code-semantic-index first.",
    );
  }

  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as RichSemanticIndex;
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = createEmbeddingProvider();
  const index = loadIndex();
  const queryVector = await provider.embedOne(args.query);
  const results = index.records
    .map((record) => ({
      id: record.id,
      filePath: record.filePath,
      component: record.metadata.component,
      symbolName: record.metadata.symbolName,
      startLine: record.metadata.startLine,
      endLine: record.metadata.endLine,
      score: cosineSimilarity(queryVector, record.vector),
      preview: preview(record.text),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, args.topK);

  console.log(
    JSON.stringify(
      { query: args.query, totalRecords: index.records.length, results },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
