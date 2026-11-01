import type { MemoryRecord, SearchResult } from "./types.js";

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function terms(value: string): string[] {
  const chunks = normalize(value).match(/[\p{L}\p{N}_-]+/gu) || [];
  const result: string[] = [];
  for (const chunk of chunks) {
    result.push(chunk);
    if (/\p{Script=Han}/u.test(chunk)) {
      const characters = [...chunk].filter((character) => /[\p{L}\p{N}]/u.test(character));
      for (let index = 0; index < characters.length - 1; index++) result.push(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return result;
}

export function searchMemories(memories: MemoryRecord[], query: string, limit = 10): SearchResult[] {
  const normalizedQuery = normalize(query.trim());
  const queryTerms = [...new Set(terms(query))];
  if (!normalizedQuery) {
    return memories
      .map((memory) => ({ memory, score: new Date(memory.updatedAt).getTime() / 1e15 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return memories
    .map((memory) => {
      const title = normalize(memory.title || "");
      const content = normalize(memory.content);
      const tags = memory.tags.map(normalize);
      const haystack = `${title} ${content} ${tags.join(" ")}`;
      const coverage = queryTerms.filter(term => haystack.includes(term)).length / Math.max(1, queryTerms.length);
      if (!haystack.includes(normalizedQuery) && coverage < 0.34) return { memory, score: 0 };
      let score = 0;
      if (title === normalizedQuery) score += 15;
      if (title.includes(normalizedQuery)) score += 8;
      if (content.includes(normalizedQuery)) score += 6;
      if (tags.includes(normalizedQuery)) score += 7;
      for (const term of queryTerms) {
        if (title.includes(term)) score += 3;
        if (content.includes(term)) score += 1;
        if (tags.some((tag) => tag.includes(term))) score += 2;
      }
      if (queryTerms.length && queryTerms.every((term) => haystack.includes(term))) score += 4;
      if (score > 0) score += Math.max(0, 1 - (Date.now() - new Date(memory.updatedAt).getTime()) / (365 * 86400_000)) * 0.25;
      return { memory, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
    .slice(0, limit);
}
