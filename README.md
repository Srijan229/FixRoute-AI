# FixRoute AI

FixRoute AI is an engineering issue-routing system for GitHub repositories. It
builds historical repository memory from issues, pull requests, changed files,
patch hunks, reviews, comments, and source code, then uses that memory to route a
new issue to evidence-backed engineering starting points.

The product is intentionally not framed as exact file prediction for every
issue. Real GitHub work can be a bug fix, feature implementation, enhancement,
refactor, documentation update, test change, or configuration change. FixRoute AI
first classifies the kind of engineering work required, then recommends the most
useful next investigation path.

## What It Does

- Ingests GitHub issues, pull requests, comments, timelines, reviews, review
  comments, changed files, commits, and patch hunks.
- Normalizes raw GitHub data into graph-ready and retrieval-ready datasets.
- Builds a Neo4j knowledge graph for repository relationships and evidence
  paths.
- Builds semantic indexes for historical issues, PRs, implementation patterns,
  patch hunks, and source-code chunks.
- Classifies a new issue into a resolution type before recommendation.
- Routes issues to likely components, areas, files to inspect or extend,
  possible new files/directories, similar tickets, and implementation patterns.
- Evaluates product claims using holdout data, leakage checks, component/area
  metrics, resolution-type metrics, and created-file analysis.

## Product Claim

FixRoute AI classifies what kind of engineering work an issue requires, then
routes it to the most likely component, area, existing files to inspect or
extend, possible new files to create, and evidence-backed implementation
patterns using historical repository memory.

## Resolution Types

FixRoute AI currently supports these resolution types:

- `existing_bug`
- `new_feature`
- `enhancement`
- `enhancement_with_new_files`
- `refactor`
- `docs`
- `config`
- `test`
- `unknown`

The recommender uses different output modes depending on the classification:

- `bug_localization`: likely existing files, similar issues, similar fix PRs,
  and evidence paths.
- `feature_planning`: implementation areas, files to inspect or extend, likely
  new files/directories, similar implementation patterns, and suggested steps.
- `enhancement_planning`: existing feature areas, files to extend, possible new
  files, similar enhancements, and suggested steps.
- `specialized_routing`: docs/config/test/refactor file categories and areas.
- `general_triage`: lower-confidence routing for issues that need human review.

## Architecture

```text
GitHub API + target repository clone
        |
        v
Raw data storage
        |
        v
Normalization
  - rich dataset
  - graph dataset
  - patch hunks
  - implementation patterns
        |
        v
Indexes and graph
  - Neo4j knowledge graph
  - issue embedding index
  - rich semantic index
  - code semantic index
        |
        v
Recommendation
  - canonical issue profile
  - resolution-type classification
  - mode-specific routing
  - evidence-backed output
        |
        v
Evaluation
  - holdout split
  - product claim metrics
  - resolution classifier report
  - leakage checks
```

## Requirements

- Node.js 20 or newer
- npm
- Neo4j AuraDB or a local Neo4j instance
- GitHub personal access token with access to the target repository
- Optional: Gemini API key for Gemini embeddings

## Environment Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Required values:

```env
GITHUB_TOKEN=
NEO4J_URI=
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=
```

Common optional values:

```env
GITHUB_OWNER=microsoft
GITHUB_REPO=vscode
GITHUB_API_BASE_URL=https://api.github.com
EMBEDDING_PROVIDER=local
GEMINI_API_KEY=
LOG_LEVEL=info
```

Generated datasets, checkpoints, cloned repositories, and secrets are excluded
from version control.

## Data Pipeline

Run the pipeline in this order for a fresh local build:

```bash
npm run fetch:issues
npm run fetch:prs
npm run fetch:issue-comments
npm run fetch:issue-timeline
npm run fetch:pr-reviews
npm run fetch:pr-review-comments
npm run clone:target-repo
npm run extract:patch-hunks
npm run index:symbols
npm run normalize:rich
npm run normalize:graph
npm run build:graph
npm run create:embeddings -- --reset
npm run create:rich-semantic-index
npm run create:code-semantic-index
```

For holdout-safe evaluation, build the split first and then index only training
data:

```bash
npm run build:holdout
npm run normalize:graph -- --holdout train
npm run create:embeddings -- --holdout train --reset
npm run create:rich-semantic-index -- --holdout train
```

## Querying

Query the graph:

```bash
npm run query:graph -- --issue-number 153829
npm run query:graph -- --title "snippet session"
```

Query semantic indexes:

```bash
npm run query:semantic -- --query "terminal crash when stopping node process" --top-k 5
npm run query:code -- --query "ChatExportAction export chat history" --top-k 5
```

Generate a recommendation:

```bash
npm run recommend:ticket -- \
  --title "Cannot read properties of undefined" \
  --description "Snippet session crashes while applying edits"
```

## API

Start the local API:

```bash
npm run serve:api
```

Health check:

```http
GET /health
```

Recommendation endpoint:

```http
POST /api/recommend
Content-Type: application/json
```

```json
{
  "title": "Cannot read properties of undefined",
  "description": "Snippet session crashes while applying edits",
  "topK": 5
}
```

## Evaluation

Run the main product evaluation:

```bash
npm run evaluate:product
```

Run the resolution classifier evaluation:

```bash
npm run evaluate:resolution
```

Run validation and tests:

```bash
npm run validate:product
npm run typecheck
npm test
```

The evaluation reports are written under:

```text
data/processed/evaluation/
```

Important reports include:

- `productEvaluation.json`
- `resolutionClassifierEvaluation.json`

Compact recommendation examples are available in
[`docs/recommendation-examples.md`](docs/recommendation-examples.md).

## Current Evaluation Focus

The most important current metric is routing quality, not global file recall.
The system is being optimized in this order:

1. Correct resolution type.
2. Correct mode-specific recommendation strategy.
3. Correct component and area.
4. Useful existing files to inspect or extend.
5. Useful possible new files/directories.
6. Similar implementation patterns and evidence paths.

This is deliberate. Many real issues require new implementation or broad
enhancement work, so exact file recall is not always the right success metric.

Exact file recall should not be used as the only success metric. For new
features and enhancements, FixRoute AI evaluates whether it chose the right
resolution type, routing mode, component, area, new-file likelihood, existing
files to inspect or extend, possible files to create, and supporting historical
evidence. A slightly lower aggregate file metric can still be a better product
result if the system avoids overclaiming exact file prediction for work that
requires planning or new implementation.

New-file prediction is intentionally separate from resolution type:

```json
{
  "resolution_type": "enhancement",
  "new_file_likelihood": "possible",
  "possible_new_files": []
}
```

This lets the system keep conservative issue classification while still warning
that helper files, tests, providers, commands, or other new implementation files
may be needed.

## Symbol-Aware Indexing

FixRoute AI also builds a symbol-aware code memory layer:

```bash
npm run index:symbols
npm run create:code-semantic-index
```

The symbol index extracts:

- exported symbols
- classes, interfaces, types, functions, methods, constants, and enums
- command IDs and contribution registrations
- file imports and resolved local import targets
- source/test naming links
- PR-to-symbol touches inferred from patch hunks

The code semantic index includes both `code_chunk` and `code_symbol` records.
Symbol matches are used to boost defining files, related test files, and import
neighbors during recommendation.

## Neo4j Graph

After `npm run build:graph`, inspect the graph in Neo4j Browser or AuraDB with:

```cypher
MATCH p=(n)-[r]->(m)
RETURN p
LIMIT 100;
```

For a smaller overview:

```cypher
MATCH (n)
RETURN labels(n) AS labels, count(*) AS count
ORDER BY count DESC;
```

## Project Guidance

Persistent project guidance lives in `AGENTS.md`. The key rule is to avoid
overclaiming exact file prediction. FixRoute AI should use cautious language:

- likely component
- likely area
- recommended starting point
- files to inspect
- possible files to create
- similar implementation pattern
- evidence-backed routing

## Notes

- The default target repository is `microsoft/vscode`.
- Local embeddings can be used without an external model provider.
- Set `EMBEDDING_PROVIDER=gemini` and `GEMINI_API_KEY` to use Gemini embeddings.
- Evaluation labels are inferred from historical PR shape and linked issues, so
  they are useful for direction but should not be treated as perfect human
  labels.
