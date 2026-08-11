export const KNOWLEDGE_CHUNK_MAX_CHARS = 2_400;
export const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 300;

export type KnowledgeChunk = {
  index: number;
  start: number;
  end: number;
  content: string;
};

export function chunkKnowledgeContent(content: string): KnowledgeChunk[] {
  if (content.length <= KNOWLEDGE_CHUNK_MAX_CHARS) {
    return content.length === 0
      ? []
      : [{ index: 0, start: 0, end: content.length, content }];
  }

  const blocks = findBlocks(content);
  const ranges: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;

  for (const block of blocks) {
    if (block.end - block.start > KNOWLEDGE_CHUNK_MAX_CHARS) {
      if (current) {
        ranges.push(current);
      }
      current = null;
      ranges.push(...splitOversizedRange(block.start, block.end));
      continue;
    }

    if (!current) {
      current = { ...block };
      continue;
    }

    if (block.end - current.start <= KNOWLEDGE_CHUNK_MAX_CHARS) {
      current.end = block.end;
    } else {
      ranges.push(current);
      current = { ...block };
    }
  }

  if (current) {
    ranges.push(current);
  }

  return ranges
    .map((range, index) => ({
      index,
      start: range.start,
      end: range.end,
      content: content.slice(range.start, range.end).trim()
    }))
    .filter((chunk) => chunk.content.length > 0);
}

function findBlocks(content: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /\S[\s\S]*?(?=\n\s*\n|$)/g;

  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }

  return ranges;
}

function splitOversizedRange(start: number, end: number) {
  const ranges: Array<{ start: number; end: number }> = [];
  const step = KNOWLEDGE_CHUNK_MAX_CHARS - KNOWLEDGE_CHUNK_OVERLAP_CHARS;

  for (let cursor = start; cursor < end; cursor += step) {
    ranges.push({
      start: cursor,
      end: Math.min(end, cursor + KNOWLEDGE_CHUNK_MAX_CHARS)
    });

    if (ranges.at(-1)?.end === end) {
      break;
    }
  }

  return ranges;
}
