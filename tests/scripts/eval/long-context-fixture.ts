// tests/scripts/eval/long-context-fixture.ts
// seed a multi-module project w/ one cross-file bug for the long-context task

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// generic helpers that pad the tree so the agent has to search, not guess
const FILLER_MODULES = [
  'slug',
  'pad-left',
  'chunk',
  'unique',
  'group-by',
  'clamp',
  'range',
  'debounce-key',
  'parse-bool',
  'deep-get',
  'pick',
  'omit',
  'to-cents',
  'from-cents',
  'format-date',
  'parse-date',
  'is-email',
  'mask-card',
  'retry-delay',
  'sort-by',
  'sum-by',
  'median',
  'percentile',
  'tokenize',
]

// turn a kebab module name into its exported camelCase function name
function camel(name: string): string
{
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

// render a plausible utility module; bodies vary so the tree does not read as
// one template, but none of them touch the pricing path under test
function fillerModule(name: string, index: number): string
{
  const fn = camel(name)
  const variants = [
    `// ${fn}: normalize an input value before it reaches the storage layer\nexport function ${fn}(value, options = {})\n{\n  const limit = options.limit ?? 64\n  const text = String(value ?? '').trim()\n  return text.length > limit ? text.slice(0, limit) : text\n}\n`,
    `// ${fn}: split a list into fixed-size windows for batched processing\nexport function ${fn}(items, size = 10)\n{\n  const out = []\n  for (let i = 0; i < items.length; i += size)\n  {\n    out.push(items.slice(i, i + size))\n  }\n  return out\n}\n`,
    `// ${fn}: reduce a list by a key selector into a lookup table\nexport function ${fn}(items, keyOf)\n{\n  const table = new Map()\n  for (const item of items)\n  {\n    const key = keyOf(item)\n    const bucket = table.get(key) ?? []\n    bucket.push(item)\n    table.set(key, bucket)\n  }\n  return table\n}\n`,
    `// ${fn}: bound a number to an inclusive range\nexport function ${fn}(value, low, high)\n{\n  if (Number.isNaN(value)) return low\n  return Math.min(high, Math.max(low, value))\n}\n`,
  ]
  const body = variants[index % variants.length]!
  return `${body}\n// used by ${index + 3} call sites across the reporting and checkout flows\nexport const ${fn}Version = ${index + 1}\n`
}

// the three modules on the buggy path: discountRate returns a percent
// (10 means 10%), but applyDiscount treats it as a fraction
const PRICING_FILES: Record<string, string> = {
  'src/pricing/discount-rate.mjs': [
    '// resolve the discount percent for a customer tier',
    '// tiers are expressed in whole percent: 10 means ten percent off',
    'const TIER_PERCENT = {',
    '  standard: 0,',
    '  silver: 5,',
    '  gold: 10,',
    '  platinum: 15,',
    '}',
    '',
    'export function discountRate(tier)',
    '{',
    '  return TIER_PERCENT[tier] ?? 0',
    '}',
    '',
  ].join('\n'),
  'src/pricing/apply-discount.mjs': [
    "import { discountRate } from './discount-rate.mjs'",
    '',
    '// reduce a line subtotal by the tier discount',
    'export function applyDiscount(subtotal, tier)',
    '{',
    '  const rate = discountRate(tier)',
    '  return subtotal * (1 - rate)',
    '}',
    '',
  ].join('\n'),
  'src/orders/total.mjs': [
    "import { applyDiscount } from '../pricing/apply-discount.mjs'",
    "import { toCents } from '../util/to-cents.mjs'",
    '',
    '// sum line items, apply the customer tier discount, and round to cents',
    'export function orderTotal(order)',
    '{',
    '  const subtotal = order.lines.reduce(',
    '    (sum, line) => sum + line.unitPrice * line.quantity,',
    '    0',
    '  )',
    '  const discounted = applyDiscount(subtotal, order.customer.tier)',
    '  return Math.round(discounted * 100) / 100',
    '}',
    '',
    'export { toCents }',
    '',
  ].join('\n'),
  'src/orders/line-item.mjs': [
    '// build a validated line item',
    'export function lineItem(sku, unitPrice, quantity)',
    '{',
    "  if (typeof sku !== 'string' || sku.length === 0)",
    '  {',
    "    throw new Error('sku is required')",
    '  }',
    '  if (!(unitPrice >= 0) || !(quantity > 0))',
    '  {',
    "    throw new Error('unitPrice and quantity must be non-negative')",
    '  }',
    '  return { sku, unitPrice, quantity }',
    '}',
    '',
  ].join('\n'),
  'src/customers/customer.mjs': [
    '// build a customer record w/ a validated tier',
    "const TIERS = new Set(['standard', 'silver', 'gold', 'platinum'])",
    '',
    'export function customer(id, tier)',
    '{',
    '  if (!TIERS.has(tier))',
    '  {',
    '    throw new Error(`unknown tier: ${tier}`)',
    '  }',
    '  return { id, tier }',
    '}',
    '',
  ].join('\n'),
}

// locked tests; the grader rejects any change to these
export const LONG_CONTEXT_TEST_FILES: Record<string, string> = {
  'test/orders.test.mjs': [
    "import assert from 'node:assert'",
    "import test from 'node:test'",
    "import { orderTotal } from '../src/orders/total.mjs'",
    "import { lineItem } from '../src/orders/line-item.mjs'",
    "import { customer } from '../src/customers/customer.mjs'",
    '',
    "test('standard customers pay the full subtotal', () =>",
    '{',
    '  const order = {',
    "    customer: customer('c1', 'standard'),",
    "    lines: [lineItem('a', 20, 2), lineItem('b', 5, 1)],",
    '  }',
    '  assert.strictEqual(orderTotal(order), 45)',
    '})',
    '',
    "test('gold customers get ten percent off', () =>",
    '{',
    '  const order = {',
    "    customer: customer('c2', 'gold'),",
    "    lines: [lineItem('a', 20, 2), lineItem('b', 5, 1)],",
    '  }',
    '  assert.strictEqual(orderTotal(order), 40.5)',
    '})',
    '',
  ].join('\n'),
  'test/line-item.test.mjs': [
    "import assert from 'node:assert'",
    "import test from 'node:test'",
    "import { lineItem } from '../src/orders/line-item.mjs'",
    '',
    "test('lineItem rejects an empty sku', () =>",
    '{',
    "  assert.throws(() => lineItem('', 1, 1))",
    '})',
    '',
    "test('lineItem keeps its fields', () =>",
    '{',
    "  assert.deepStrictEqual(lineItem('x', 2, 3), {",
    "    sku: 'x',",
    '    unitPrice: 2,',
    '    quantity: 3,',
    '  })',
    '})',
    '',
  ].join('\n'),
  'test/customer.test.mjs': [
    "import assert from 'node:assert'",
    "import test from 'node:test'",
    "import { customer } from '../src/customers/customer.mjs'",
    '',
    "test('customer rejects unknown tiers', () =>",
    '{',
    "  assert.throws(() => customer('c', 'bronze'))",
    '})',
    '',
  ].join('\n'),
}

// write the whole project: filler utils, the pricing path, locked tests,
// and a package.json so `npm test` and `node --test` both work
export async function seedLongContextProject(dir: string): Promise<void>
{
  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: 'storefront',
        version: '1.3.2',
        type: 'module',
        scripts: { test: 'node --test test/' },
      },
      null,
      2
    ),
    'README.md':
      '# storefront\n\nOrder pricing library. Run `npm test` to execute the suite under `test/`.\n',
    ...PRICING_FILES,
    ...LONG_CONTEXT_TEST_FILES,
  }
  FILLER_MODULES.forEach((name, index) =>
  {
    files[`src/util/${name}.mjs`] = fillerModule(name, index)
  })

  for (const [rel, content] of Object.entries(files))
  {
    const path = join(dir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}
