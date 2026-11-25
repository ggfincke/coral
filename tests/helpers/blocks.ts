// tests/helpers/blocks.ts
// transcript block text reader for assertions over mixed OutputBlock arrays

import type { OutputBlock } from '../../src/tui/transcript/types.js'

// text of a block, or '' for blocks w/o content (tool calls, diffs) so joins match
export function blockText(block: OutputBlock | undefined): string
{
  return block && 'content' in block ? block.content : ''
}
