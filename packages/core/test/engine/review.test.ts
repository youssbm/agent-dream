import { describe, expect, it } from 'vitest';
import { fileDiff, lineDiff } from '../../src/engine/review.ts';

describe('review diff', () => {
  it('computes a minimal line diff', () => {
    const d = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(d).toEqual([
      { kind: ' ', line: 'a' },
      { kind: '-', line: 'b' },
      { kind: '+', line: 'x' },
      { kind: ' ', line: 'c' },
    ]);
  });

  it('renders headers for new, changed and deleted files and collapses context', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = before.replace('line 10', 'line ten');
    const changed = fileDiff('pages/x.md', before, after);
    expect(changed.split('\n').slice(0, 2)).toEqual(['--- a/pages/x.md', '+++ b/pages/x.md']);
    expect(changed).toContain('-line 10');
    expect(changed).toContain('+line ten');
    expect(changed).toContain('@@');
    expect(changed).not.toContain(' line 1\n');
    expect(fileDiff('pages/n.md', null, 'new\n')).toBe('--- /dev/null\n+++ b/pages/n.md\n+new');
    expect(fileDiff('pages/d.md', 'old\n', null)).toBe('--- a/pages/d.md\n+++ /dev/null\n-old');
  });
});
