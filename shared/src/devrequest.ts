import type { DevRequestRow } from './protocol';

/** The request as text: the issue body Claude Code reads as its task, the Discord post, and what the owner can copy. */
export function requestText(r: Pick<DevRequestRow, 'title' | 'by' | 'scope' | 'wants' | 'current' | 'proposed' | 'acceptance' | 'affects' | 'needsCode' | 'tested'>): string {
  const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none given)');
  return [
    `## ${r.title}`,
    `Requested by ${r.by} in the game's Ask Claude chat (about ${r.scope}).`,
    `### What the developer wants (their words)\n${r.wants}`,
    `### What needs code\n${r.needsCode || '(not stated)'}`,
    `### Current behaviour\n${r.current || '(not stated)'}`,
    `### Proposed behaviour\n${r.proposed}`,
    `### Acceptance criteria\n${bullets(r.acceptance)}`,
    `### Affected skills and files\n${bullets(r.affects)}`,
    `### Number changes already tested in a match\n${r.tested.length ? r.tested.map((c) => `- ${c.label}: ${c.from ?? '?'} -> ${c.to}`).join('\n') : '- (none)'}`,
  ].join('\n\n');
}
