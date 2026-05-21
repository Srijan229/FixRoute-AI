type Bm25Document<T> = {
  id: T;
  text: string;
};

export type Bm25Result<T> = {
  id: T;
  score: number;
};

const TOKEN_REGEX = /[a-z0-9_./-]+/g;
const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_REGEX) || []).filter(
    (token) => token.length >= 3,
  );
}

export function bm25Search<T>(
  query: string,
  documents: Array<Bm25Document<T>>,
  limit: number,
): Array<Bm25Result<T>> {
  const queryTerms = Array.from(new Set(tokenize(query)));

  if (queryTerms.length === 0 || documents.length === 0) {
    return [];
  }

  const termFrequencies = new Map<T, Map<string, number>>();
  const documentFrequencies = new Map<string, number>();
  let totalDocumentLength = 0;

  for (const document of documents) {
    const tokens = tokenize(document.text);
    const frequencies = new Map<string, number>();

    totalDocumentLength += tokens.length;

    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }

    for (const term of new Set(tokens)) {
      documentFrequencies.set(term, (documentFrequencies.get(term) || 0) + 1);
    }

    termFrequencies.set(document.id, frequencies);
  }

  const averageDocumentLength =
    totalDocumentLength > 0 ? totalDocumentLength / documents.length : 1;
  const scores = documents.map((document) => {
    const frequencies = termFrequencies.get(document.id) || new Map();
    const documentLength = Array.from(frequencies.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    let score = 0;

    for (const term of queryTerms) {
      const termFrequency = frequencies.get(term) || 0;

      if (termFrequency === 0) {
        continue;
      }

      const documentFrequency = documentFrequencies.get(term) || 0;
      const inverseDocumentFrequency = Math.log(
        1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const denominator =
        termFrequency +
        DEFAULT_K1 *
          (1 - DEFAULT_B + DEFAULT_B * (documentLength / averageDocumentLength));

      score +=
        inverseDocumentFrequency *
        ((termFrequency * (DEFAULT_K1 + 1)) / denominator);
    }

    return {
      id: document.id,
      score,
    };
  });

  return scores
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function reciprocalRankFusion<T>(
  rankedLists: Array<Array<T>>,
  limit: number,
  rankConstant = 60,
): Array<{ id: T; score: number }> {
  const scores = new Map<T, number>();

  for (const rankedList of rankedLists) {
    rankedList.forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (rankConstant + index + 1));
    });
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
