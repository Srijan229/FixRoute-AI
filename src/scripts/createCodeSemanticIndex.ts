import fs from "node:fs";
import path from "node:path";
import { loadSemanticEnv } from "../config/env.js";
import { createEmbeddingProvider } from "../lib/embeddings.js";
import { logInfo } from "../lib/logger.js";
import type {
  CodeChunkDataset,
  RichSemanticIndex,
  RichSemanticRecord,
} from "../lib/types.js";

const CODE_CHUNKS_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "code",
  "codeChunks.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  process.env.CODE_SEMANTIC_INDEX_FILE_PATH ||
    "data/processed/semantic/codeSemanticIndex.json",
);
const BATCH_SIZE = Number(process.env.CODE_SEMANTIC_BATCH_SIZE || 50);

function loadCodeChunks(): CodeChunkDataset {
  if (!fs.existsSync(CODE_CHUNKS_PATH)) {
    throw new Error("Missing code chunks. Run index:code first.");
  }

  return JSON.parse(
    fs.readFileSync(CODE_CHUNKS_PATH, "utf8"),
  ) as CodeChunkDataset;
}

function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    chunks.push(items.slice(index, index + batchSize));
  }

  return chunks;
}

function saveCodeSemanticIndex(index: RichSemanticIndex): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(index, null, 2), "utf8");
}

async function main() {
  const env = loadSemanticEnv();
  const provider = createEmbeddingProvider();
  const codeDataset = loadCodeChunks();
  const pendingRecords = codeDataset.chunks.map((chunk) => ({
    id: `code-chunk:${chunk.id}`,
    type: "code_chunk" as const,
    filePath: chunk.filePath,
    title: chunk.symbolName || chunk.filePath,
    metadata: {
      repoOwner: chunk.repoOwner,
      repoName: chunk.repoName,
      component: chunk.component,
      language: chunk.language,
      chunkType: chunk.chunkType,
      symbolName: chunk.symbolName,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    },
    text: [
      `Code chunk ${chunk.symbolName || ""}`.trim(),
      `File: ${chunk.filePath}`,
      `Component: ${chunk.component}`,
      chunk.text,
    ].join("\n\n"),
  }));
  const records: RichSemanticRecord[] = [];
  const batches = chunkArray(pendingRecords, BATCH_SIZE);

  logInfo("Starting code semantic index build", {
    sourcePath: CODE_CHUNKS_PATH,
    outputPath: OUTPUT_PATH,
    provider: env.EMBEDDING_PROVIDER,
    dimension: env.EMBEDDING_DIMENSION,
    recordCount: pendingRecords.length,
  });

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const vectors = await provider.embedBatch(
      batch.map((record) => record.text),
    );

    for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
      records.push({
        ...batch[itemIndex],
        vector: vectors[itemIndex],
      });
    }

    logInfo("Created code semantic index batch", {
      batchNumber: index + 1,
      batchCount: batches.length,
      batchSize: batch.length,
      completedRecordCount: records.length,
    });
  }

  const semanticIndex: RichSemanticIndex = {
    metadata: {
      provider: env.EMBEDDING_PROVIDER,
      dimension: env.EMBEDDING_DIMENSION,
      generatedAt: new Date().toISOString(),
      sourcePath: CODE_CHUNKS_PATH,
      recordCount: records.length,
      countsByType: {
        code_chunk: records.length,
      },
    },
    records,
  };

  saveCodeSemanticIndex(semanticIndex);

  logInfo("Code semantic index created", {
    outputPath: OUTPUT_PATH,
    recordCount: records.length,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
