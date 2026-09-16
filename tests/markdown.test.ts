import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown } from '../src/renderer/Markdown';

test('parses the Markdown subset used by agent messages', () => {
  const blocks = parseMarkdown([
    '1. Implemented lazy monitoring with:',
    '- Bounded parsing.',
    '- `loadRun(runId)` guards.',
    '',
    '## Files',
    '```ts',
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    'Plain line one',
    'line two',
    '> quoted',
  ].join('\n'));
  assert.deepEqual(blocks.map((block) => block.type), ['list', 'list', 'heading', 'code', 'paragraph', 'quote']);
  assert.deepEqual(blocks[0], { type: 'list', ordered: true, start: 1, items: ['Implemented lazy monitoring with:'] });
  assert.deepEqual(blocks[1], { type: 'list', ordered: false, start: 1, items: ['Bounded parsing.', '`loadRun(runId)` guards.'] });
  assert.deepEqual(blocks[3], { type: 'code', text: 'const a = 1;\n\nconst b = 2;' });
  assert.deepEqual(blocks[4], { type: 'paragraph', text: 'Plain line one\nline two' });
});

test('keeps continuation lines with their list item and treats unclosed fences as code', () => {
  const blocks = parseMarkdown('3. Validation:\n   all tests passed\n```\nnever closed');
  assert.deepEqual(blocks[0], { type: 'list', ordered: true, start: 3, items: ['Validation:\nall tests passed'] });
  assert.deepEqual(blocks[1], { type: 'code', text: 'never closed' });
});
