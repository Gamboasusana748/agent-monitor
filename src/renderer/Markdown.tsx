import type { ReactNode } from 'react';

type Block =
  | { type: 'code'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'rule' }
  | { type: 'paragraph'; text: string };

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

/** Splits agent-authored Markdown into the small block subset the trace reader renders. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = Boolean(item[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index].match(LIST_ITEM);
        if (next && Boolean(next[2]) === ordered) {
          items.push(next[3]);
        } else if (lines[index].trim() && /^\s{2,}/.test(lines[index]) && items.length) {
          items[items.length - 1] += `\n${lines[index].trim()}`;
        } else break;
        index += 1;
      }
      blocks.push({ type: 'list', ordered, start: ordered ? Number(item[2]) : 1, items });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()
      && !LIST_ITEM.test(lines[index]) && !/^\s*(#{1,6}\s|`{3,}|~{3,}|>)/.test(lines[index])) {
      paragraph.push(lines[index++]);
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const key = nodes.length;
    if (match[2] !== undefined) nodes.push(<code key={key}>{match[2].trim()}</code>);
    else if (match[3] !== undefined || match[4] !== undefined) nodes.push(<strong key={key}>{inline(match[3] ?? match[4])}</strong>);
    else if (match[5] !== undefined) nodes.push(<em key={key}>{inline(match[5])}</em>);
    // Links stay inert: navigating inside the Electron window would replace the dashboard.
    else nodes.push(<span key={key} className="markdown__link" title={match[7]}>{match[6]}</span>);
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={['markdown', className].filter(Boolean).join(' ')}>
      {parseMarkdown(text).map((block, index) => {
        if (block.type === 'code') return <pre key={index}><code>{block.text}</code></pre>;
        if (block.type === 'heading') {
          const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3';
          return <Tag key={index}>{inline(block.text)}</Tag>;
        }
        if (block.type === 'list') {
          const items = block.items.map((item, i) => <li key={i}>{inline(item)}</li>);
          return block.ordered
            ? <ol key={index} start={block.start}>{items}</ol>
            : <ul key={index}>{items}</ul>;
        }
        if (block.type === 'quote') return <blockquote key={index}>{inline(block.text)}</blockquote>;
        if (block.type === 'rule') return <hr key={index} />;
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
