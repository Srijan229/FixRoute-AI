import fs from "node:fs";
import path from "node:path";
import { loadSemanticEnv } from "../config/env.js";
import type { GitHubIssue, IssueEmbeddingRecord } from "./types.js";

type EmbeddingProvider = {
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedOne: (text: string) => Promise<number[]>;
};

const TOKEN_REGEX = /[a-z0-9_./-]+/g;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_REGEX) || []).filter((token) => token.length >= 2);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function hashToken(token: string, dimension: number): number {
  let hash = 2166136261;

  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash) % dimension;
}

function createLocalEmbedding(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const slot = hashToken(token, dimension);
    vector[slot] += 1;
  }

  return normalizeVector(vector);
}

async function embedWithGemini(texts: string[]): Promise<number[][]> {
  const env = loadSemanticEnv();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.EMBEDDING_MODEL}:batchEmbedContents?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${env.EMBEDDING_MODEL}`,
          content: {
            parts: [{ text }]
          },
          outputDimensionality: env.EMBEDDING_DIMENSION,
          taskType: "RETRIEVAL_DOCUMENT"
        }))
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini embedding request failed: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = (await response.json()) as {
    embeddings?: Array<{ values?: number[] }>;
  };

  if (!payload.embeddings || payload.embeddings.length !== texts.length) {
    throw new Error("Gemini embedding response shape was unexpected");
  }

  return payload.embeddings.map((embedding) => normalizeVector(embedding.values || []));
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const env = loadSemanticEnv();

  if (env.EMBEDDING_PROVIDER === "gemini") {
    return {
      embedBatch: embedWithGemini,
      embedOne: async (text: string) => (await embedWithGemini([text]))[0]
    };
  }

  return {
    embedBatch: async (texts: string[]) =>
      texts.map((text) => createLocalEmbedding(text, env.EMBEDDING_DIMENSION)),
    embedOne: async (text: string) => createLocalEmbedding(text, env.EMBEDDING_DIMENSION)
  };
}

export function buildIssueEmbeddingText(issue: GitHubIssue): string {
  const labels = issue.labels.map((label) => label.name).join(" ");

  return [issue.title, labels, issue.body ?? ""]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function getEmbeddingsFilePath(): string {
  return path.resolve(process.cwd(), loadSemanticEnv().EMBEDDINGS_FILE_PATH);
}

export function saveEmbeddingIndex(records: IssueEmbeddingRecord[]): void {
  const outputPath = getEmbeddingsFilePath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(records, null, 2), "utf8");
}

export function loadEmbeddingIndex(): IssueEmbeddingRecord[] {
  const inputPath = getEmbeddingsFilePath();

  if (!fs.existsSync(inputPath)) {
    throw new Error("Missing embedding index. Run create:embeddings first.");
  }

  return JSON.parse(fs.readFileSync(inputPath, "utf8")) as IssueEmbeddingRecord[];
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("Vector dimensions do not match");
  }

  let sum = 0;

  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }

  return sum;
}
