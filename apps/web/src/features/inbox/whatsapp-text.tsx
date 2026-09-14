import type { JSONContent } from '@tiptap/react';

function inline(text: string, marks: { type: string }[] = []): JSONContent[] {
  const nodes: JSONContent[] = [];
  let plain = '';
  const flush = () => { if (plain) nodes.push({ type: 'text', text: plain, ...(marks.length ? { marks } : {}) }); plain = ''; };
  for (let i = 0; i < text.length; i++) {
    const marker = text[i];
    const type = marker === '*' ? 'bold' : marker === '_' ? 'italic' : null;
    if (type && !marks.some(m => m.type === type) && (marks.length > 0 || i === 0 || !/[\p{L}\p{N}_*]/u.test(text[i - 1])) && text[i + 1] && !/\s/.test(text[i + 1])) {
      let end = text.indexOf(marker, i + 1);
      while (end > i + 1 && (/\s/.test(text[end - 1]) || (text[end + 1] && /[\p{L}\p{N}]/u.test(text[end + 1])))) end = text.indexOf(marker, end + 1);
      if (end > i + 1) { flush(); nodes.push(...inline(text.slice(i + 1, end), [...marks, { type }])); i = end; continue; }
    }
    plain += marker;
  }
  flush(); return nodes;
}
export function parseWhatsappText(text: string): JSONContent {
  return { type: 'doc', content: text.split('\n').map(line => ({ type: 'paragraph', content: inline(line) })) };
}
export function serializeWhatsappText(doc: JSONContent): string {
  function blockText(block: JSONContent): string {
    let result = ''; let opened: string[] = [];
    function emit(text: string, desired: string[]) {
      let common = 0;
      while (common < opened.length && common < desired.length && opened[common] === desired[common]) common++;
      result += opened.slice(common).reverse().join('') + desired.slice(common).join('') + text;
      opened = desired;
    }
    function visit(node: JSONContent) {
      if (node.type === 'hardBreak') { emit('\n', []); return; }
      if (node.type !== 'text') { node.content?.forEach(visit); return; }
      const desired = [node.marks?.some(m => m.type === 'bold') ? '*' : '', node.marks?.some(m => m.type === 'italic') ? '_' : ''].filter(Boolean);
      const text = node.text ?? '';
      const pieces = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      if (pieces[1]) emit(pieces[1], []);
      if (pieces[2]) emit(pieces[2], desired);
      if (pieces[3]) emit(pieces[3], []);
    }
    visit(block); emit('', []); return result;
  }
  return (doc.content ?? []).map(blockText).join('\n');
}
export function WhatsappText({ text }: { text: string }) {
  return <>{parseWhatsappText(text).content?.map((line, index) => <span key={index}>
    {index > 0 ? '\n' : null}{line.content?.map((node, i) => {
      let content = <>{node.text}</>;
      if (node.marks?.some(m => m.type === 'italic')) content = <em>{content}</em>;
      if (node.marks?.some(m => m.type === 'bold')) content = <strong>{content}</strong>;
      return <span key={i}>{content}</span>;
    })}
  </span>)}</>;
}
