import {
  createEmbeddingProvider,
  cosineSimilarity,
  loadRichSemanticIndex,
} from "../lib/embeddings.js";
import type { RichSemanticRecord, SemanticRecordType } from "../lib/types.js";

type Args = {
  query: string;
  topK: number;
  type?: SemanticRecordType;
};

function parseArgs(argv: string[]): Args {
  let query = "";
  let topK = 10;
  let type: SemanticRecordType | undefined;

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
      continue;
    }

    if (current === "--type" && next) {
      type = next as SemanticRecordType;
      index += 1;
    }
  }

  if (!query) {
    throw new Error("Provide --query");
  }

  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("--top-k must be a positive number");
  }

  return { query, topK, type };
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = createEmbeddingProvider();
  const index = loadRichSemanticIndex();
  const queryVector = await provider.embedOne(args.query);
  const candidateRecords = args.type
    ? index.records.filter((record) => record.type === args.type)
    : index.records;
  const results = candidateRecords
    .map((record: RichSemanticRecord) => ({
      id: record.id,
      type: record.type,
      issueNumber: record.issueNumber,
      pullRequestNumber: record.pullRequestNumber,
      filePath: record.filePath,
      title: record.title,
      url: record.url,
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
