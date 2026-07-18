// scripts/check-architecture.mjs
// validate local source resolution, runtime cycles, & dependency direction

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const SOURCE_ROOT = resolve('src')
const LOCAL_PREFIXES = ['./', '../']
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const AMBIENT_CWD_ALLOWLIST = new Set([
  'src/agent/agent.ts',
  'src/shared/workspace-path.ts',
  'src/tools/bash.ts',
  'src/tools/edit.ts',
  'src/tools/git.ts',
  'src/tools/list-files.ts',
  'src/tools/preview.ts',
  'src/tools/read.ts',
  'src/tools/ripgrep-utils.ts',
  'src/tools/search-code.ts',
  'src/tools/write.ts',
  'src/tui/App.tsx',
  'src/utils/file-read.ts',
])
const INTERACTIVE_SESSION_CONSUMERS = new Set([
  'src/tui/App.tsx',
  'src/tui/model/use-model-picker.ts',
  'src/tui/run/use-agent-turn.ts',
])
const AGENT_STATE_RUNTIME_UTILS = new Set(['src/utils/ellipsize.ts'])
const SESSION_CODEC_RUNTIME_DEPS = new Set([
  'src/session/types.ts',
  'src/session/undo-state.ts',
  'src/types/attachments.ts',
  'src/types/todo.ts',
  'src/utils/guards.ts',
])
const SESSION_LAYER_RANKS = new Map([
  ['src/session/types.ts', 0],
  ['src/session/undo-state.ts', 1],
  ['src/session/codec.ts', 2],
  ['src/session/store.ts', 3],
  ['src/session/resume.ts', 4],
])

function toRepoPath(path)
{
  return relative(process.cwd(), path).split(sep).join('/')
}

function collectSourceFiles(path)
{
  const files = []
  for (const entry of readdirSync(path, { withFileTypes: true }))
  {
    const child = resolve(path, entry.name)
    if (entry.isDirectory())
    {
      files.push(...collectSourceFiles(child))
      continue
    }

    if (SOURCE_EXTENSIONS.includes(extname(entry.name))) files.push(child)
  }
  return files.sort()
}

function isLocalSpecifier(specifier)
{
  return LOCAL_PREFIXES.some((prefix) => specifier.startsWith(prefix))
}

function sourceCandidates(path)
{
  const extension = extname(path)
  if (extension === '.js')
  {
    const stem = path.slice(0, -extension.length)
    return [stem + '.ts', stem + '.tsx']
  }
  if (extension === '.jsx') return [path.slice(0, -4) + '.tsx']
  if (extension === '.mjs') return [path.slice(0, -4) + '.mts']
  if (extension === '.cjs') return [path.slice(0, -4) + '.cts']
  if (SOURCE_EXTENSIONS.includes(extension)) return [path]
  return [
    ...SOURCE_EXTENSIONS.map((sourceExtension) => path + sourceExtension),
    ...SOURCE_EXTENSIONS.map((sourceExtension) =>
      resolve(path, `index${sourceExtension}`)
    ),
  ]
}

function resolveLocalSpecifier(source, specifier, sourcePaths)
{
  const base = resolve(dirname(source), specifier)
  return sourceCandidates(base).find((candidate) => sourcePaths.has(candidate))
}

function importIsTypeOnly(node)
{
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name || !clause.namedBindings) return false
  if (!ts.isNamedImports(clause.namedBindings)) return false
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  )
}

function exportIsTypeOnly(node)
{
  if (node.isTypeOnly) return true
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false
  return (
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  )
}

function collectEdges(files)
{
  const edges = []
  const external = []
  const unresolved = []
  const sourcePaths = new Set(files)

  function addEdge(source, specifier, runtime, kind)
  {
    if (!isLocalSpecifier(specifier))
    {
      external.push({
        source: toRepoPath(source),
        specifier,
        runtime,
        kind,
      })
      return
    }
    const target = resolveLocalSpecifier(source, specifier, sourcePaths)
    if (!target)
    {
      unresolved.push({ source: toRepoPath(source), specifier })
      return
    }
    edges.push({
      source: toRepoPath(source),
      target: toRepoPath(target),
      specifier,
      runtime,
      kind,
    })
  }

  for (const file of files)
  {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )

    for (const statement of sourceFile.statements)
    {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
      {
        addEdge(
          file,
          statement.moduleSpecifier.text,
          !importIsTypeOnly(statement),
          'import'
        )
      }
      else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
      {
        addEdge(
          file,
          statement.moduleSpecifier.text,
          !exportIsTypeOnly(statement),
          'export'
        )
      }
    }

    function visit(node)
    {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      )
      {
        addEdge(file, node.arguments[0].text, true, 'dynamic')
      }
      else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
      {
        addEdge(file, node.argument.literal.text, false, 'type-import')
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
  }

  return { edges, external, unresolved }
}

function runtimeCycles(files, edges)
{
  const paths = files.map(toRepoPath)
  const adjacency = new Map(paths.map((path) => [path, new Set()]))
  for (const edge of edges)
  {
    if (edge.runtime) adjacency.get(edge.source)?.add(edge.target)
  }

  const cycles = []
  const indexes = new Map()
  const lowLinks = new Map()
  const stack = []
  const stacked = new Set()
  let nextIndex = 0

  function connect(path)
  {
    indexes.set(path, nextIndex)
    lowLinks.set(path, nextIndex)
    nextIndex += 1
    stack.push(path)
    stacked.add(path)

    for (const target of adjacency.get(path) ?? [])
    {
      if (!indexes.has(target))
      {
        connect(target)
        lowLinks.set(path, Math.min(lowLinks.get(path), lowLinks.get(target)))
      }
      else if (stacked.has(target))
      {
        lowLinks.set(path, Math.min(lowLinks.get(path), indexes.get(target)))
      }
    }

    if (lowLinks.get(path) !== indexes.get(path)) return

    const component = []
    while (stack.length > 0)
    {
      const member = stack.pop()
      stacked.delete(member)
      component.push(member)
      if (member === path) break
    }

    const selfCycle =
      component.length === 1 && adjacency.get(path)?.has(path) === true
    if (component.length > 1 || selfCycle) cycles.push(component.sort())
  }

  for (const path of paths)
  {
    if (!indexes.has(path)) connect(path)
  }
  return cycles
}

function topLevel(path)
{
  return path.split('/')[1]
}

function dependencyErrors(edges)
{
  const errors = []

  function forbid(edge, targets, label)
  {
    if (targets.includes(topLevel(edge.target)))
    {
      errors.push(`${label}: ${edge.source} -> ${edge.target}`)
    }
  }

  for (const edge of edges)
  {
    const source = topLevel(edge.source)
    const target = topLevel(edge.target)

    if (target === 'cli' && source !== 'cli')
    {
      errors.push(
        `only CLI files may depend on CLI composition: ${edge.source} -> ${edge.target}`
      )
    }
    if (target === 'tui' && source !== 'tui' && source !== 'cli')
    {
      errors.push(
        `only CLI composition may enter TUI: ${edge.source} -> ${edge.target}`
      )
    }
    if (source === 'agent')
    {
      forbid(edge, ['tui', 'session', 'telemetry'], 'Agent boundary')
      if (
        edge.source.startsWith('src/agent/state/') &&
        (edge.target.startsWith('src/agent/effects/') ||
          edge.target.startsWith('src/agent/loop/'))
      )
      {
        errors.push(
          `Agent state cannot depend on effects or loop coordination: ${edge.source} -> ${edge.target}`
        )
      }
      if (edge.source.startsWith('src/agent/state/') && edge.runtime)
      {
        if (!['agent', 'types', 'utils'].includes(target))
        {
          errors.push(
            `Agent state must remain I/O-free and policy-local: ${edge.source} -> ${edge.target}`
          )
        }
        if (target === 'utils' && !AGENT_STATE_RUNTIME_UTILS.has(edge.target))
        {
          errors.push(
            `Agent state runtime utility is not allowlisted: ${edge.source} -> ${edge.target}`
          )
        }
      }
    }
    if (
      ['tui', 'cli', 'session'].includes(source) &&
      (edge.target.startsWith('src/agent/effects/') ||
        edge.target.startsWith('src/agent/loop/'))
    )
    {
      errors.push(
        `application boundaries must use the Agent façade: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.target === 'src/agent/mcp-scope.ts' &&
      edge.source !== 'src/agent/agent.ts'
    )
    {
      errors.push(
        `only the Agent façade may own the MCP scope: ${edge.source} -> ${edge.target}`
      )
    }
    if (source === 'tools')
    {
      forbid(edge, ['agent', 'tui', 'session', 'mcp'], 'tool boundary')
      if (target === 'lsp' && edge.target !== 'src/lsp/contracts.ts')
      {
        errors.push(
          `tools may depend only on the neutral LSP contract: ${edge.source} -> ${edge.target}`
        )
      }
    }
    if (source === 'session')
    {
      forbid(edge, ['agent', 'tui'], 'session boundary')
      if (target === 'tools' && edge.target !== 'src/tools/tool.ts')
      {
        errors.push(
          `session may depend only on the neutral tool contract: ${edge.source} -> ${edge.target}`
        )
      }
      const sourceRank = SESSION_LAYER_RANKS.get(edge.source)
      const targetRank = SESSION_LAYER_RANKS.get(edge.target)
      if (
        sourceRank !== undefined &&
        targetRank !== undefined &&
        sourceRank < targetRank
      )
      {
        errors.push(
          `session layers may depend only inward: ${edge.source} -> ${edge.target}`
        )
      }
      if (
        edge.source === 'src/session/codec.ts' &&
        edge.runtime &&
        !SESSION_CODEC_RUNTIME_DEPS.has(edge.target)
      )
      {
        errors.push(
          `session codec runtime dependency is not pure-data allowlisted: ${edge.source} -> ${edge.target}`
        )
      }
    }
    if (source === 'types' && target !== 'types')
    {
      errors.push(
        `types must remain a neutral source leaf: ${edge.source} -> ${edge.target}`
      )
    }
    if (source === 'utils')
    {
      forbid(
        edge,
        [
          'agent',
          'tools',
          'tui',
          'session',
          'telemetry',
          'mcp',
          'lsp',
          'retrieval',
          'ollama',
        ],
        'utility boundary'
      )
    }
    if (source === 'config' && target === 'retrieval')
    {
      errors.push(
        `config must not depend on retrieval: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      source === 'mcp' &&
      target === 'tools' &&
      edge.target !== 'src/tools/tool.ts'
    )
    {
      errors.push(
        `MCP may depend only on the neutral tool contract: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.target.startsWith('src/mcp/') &&
      source !== 'mcp' &&
      edge.target !== 'src/mcp/types.ts' &&
      edge.target !== 'src/mcp/manager.ts'
    )
    {
      errors.push(
        `external MCP consumers may use only contracts or the lazy manager entry: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.source === 'src/mcp/types.ts' &&
      edge.target.startsWith('src/mcp/') &&
      edge.runtime
    )
    {
      errors.push(
        `MCP status contracts cannot load MCP runtime modules: ${edge.source} -> ${edge.target}`
      )
    }
    if (target === 'tools' && edge.target === 'src/tools/index.ts')
    {
      errors.push(
        `source modules cannot restore the retired tool façade: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      source === 'tui' &&
      (edge.target === 'src/tools/registry.ts' ||
        edge.target === 'src/tools/index.ts')
    )
    {
      errors.push(
        `TUI must consume event presentation, not the executable registry: ${edge.source} -> ${edge.target}`
      )
    }
    if (source === 'tui' && edge.target === 'src/tui/App.tsx')
    {
      errors.push(
        `TUI features cannot depend on the App composition root: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      (edge.target === 'src/tui/model/use-model-picker.ts' ||
        edge.target === 'src/tui/run/use-agent-turn.ts') &&
      edge.source !== 'src/tui/App.tsx'
    )
    {
      errors.push(
        `only App may compose TUI presentation adapters: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.target === 'src/tui/session/use-interactive-session.ts' &&
      !INTERACTIVE_SESSION_CONSUMERS.has(edge.source)
    )
    {
      errors.push(
        `interactive session consumers are not allowlisted: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.target === 'src/tui/session/use-interactive-session.ts' &&
      edge.runtime &&
      edge.source !== 'src/tui/App.tsx'
    )
    {
      errors.push(
        `only App may runtime-compose the interactive session hook: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.source === 'src/tui/transcript/types.ts' &&
      edge.target.startsWith('src/tui/')
    )
    {
      errors.push(
        `transcript value types cannot depend on TUI implementations: ${edge.source} -> ${edge.target}`
      )
    }
    if (
      edge.target === 'src/cwd.ts' &&
      !AMBIENT_CWD_ALLOWLIST.has(edge.source)
    )
    {
      errors.push(`ambient cwd consumer is not allowlisted: ${edge.source}`)
    }
  }

  const managerEdges = edges.filter(
    (edge) => edge.target === 'src/mcp/manager.ts'
  )
  if (
    managerEdges.length !== 1 ||
    managerEdges[0].kind !== 'dynamic' ||
    managerEdges[0].source !== 'src/agent/mcp-scope.ts' ||
    managerEdges[0].specifier !== '../mcp/manager.js'
  )
  {
    const rendered =
      managerEdges.length === 0
        ? 'none'
        : managerEdges
            .map((edge) => `${edge.kind} ${edge.source} via ${edge.specifier}`)
            .join(', ')
    errors.push(
      `mcp/manager.ts must have one MCP-scope-owned literal dynamic import; found ${rendered}`
    )
  }

  return errors
}

function externalDependencyErrors(external)
{
  const errors = []
  for (const edge of external)
  {
    if (edge.source.startsWith('src/agent/state/') && edge.runtime)
    {
      errors.push(
        `Agent state cannot load external runtime dependencies: ${edge.source} -> ${edge.specifier}`
      )
    }
    if (edge.source === 'src/session/codec.ts' && edge.runtime)
    {
      errors.push(
        `session codec cannot load external runtime dependencies: ${edge.source} -> ${edge.specifier}`
      )
    }
    const isMcpSdk =
      edge.specifier === '@modelcontextprotocol/sdk' ||
      edge.specifier.startsWith('@modelcontextprotocol/sdk/')
    const isAjv =
      edge.specifier === 'ajv' ||
      edge.specifier.startsWith('ajv/') ||
      edge.specifier === 'ajv-formats' ||
      edge.specifier.startsWith('ajv-formats/')
    if (!isMcpSdk && !isAjv) continue
    if (!edge.source.startsWith('src/mcp/'))
    {
      errors.push(
        `MCP SDK and schema runtimes must stay inside the lazy MCP boundary: ${edge.source} -> ${edge.specifier}`
      )
    }
    if (edge.source === 'src/mcp/types.ts')
    {
      errors.push(
        `MCP status contracts must remain SDK-free: ${edge.source} -> ${edge.specifier}`
      )
    }
  }
  return errors
}

const files = collectSourceFiles(SOURCE_ROOT)
const { edges, external, unresolved } = collectEdges(files)
const cycles = runtimeCycles(files, edges)
const errors = [
  ...dependencyErrors(edges),
  ...externalDependencyErrors(external),
]

for (const item of unresolved)
{
  errors.push(`unresolved local import: ${item.source} -> ${item.specifier}`)
}
for (const cycle of cycles)
{
  errors.push(`runtime import cycle: ${cycle.join(' -> ')}`)
}

if (errors.length > 0)
{
  console.error('\nArchitecture check failed:\n')
  for (const error of errors.sort()) console.error(`- ${error}`)
  console.error('')
  process.exit(1)
}

const runtimeEdgeCount = edges.filter((edge) => edge.runtime).length
console.log(
  `Architecture check passed: ${files.length} source modules, ${edges.length} local edges, ${runtimeEdgeCount} runtime edges, 0 unresolved imports, 0 runtime cycles, 0 forbidden edges`
)
