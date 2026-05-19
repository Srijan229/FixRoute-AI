import { generateRecommendation } from "../lib/recommendation.js";

type QueryArgs = {
  title: string;
  description: string;
  topK: number;
};

function parseArgs(argv: string[]): QueryArgs {
  let title = "";
  let description = "";
  let topK = 5;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--title" && next) {
      title = next.trim();
      index += 1;
      continue;
    }

    if (current === "--description" && next) {
      description = next.trim();
      index += 1;
      continue;
    }

    if (current === "--top-k" && next) {
      topK = Number(next);
      index += 1;
    }
  }

  if (!title) {
    throw new Error("Provide --title for the new ticket");
  }

  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("--top-k must be a positive number");
  }

  return { title, description, topK };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = await generateRecommendation({
    title: args.title,
    description: args.description,
    topK: args.topK,
  });

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
