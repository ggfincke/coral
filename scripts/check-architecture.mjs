// scripts/check-architecture.mjs
// validate local source resolution, runtime cycles, & dependency direction

import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
    return SOURCE_EXTENSIONS.map((sourceExtension) => stem + sourceExtension)
  }
  if (extension === '.jsx') return [path.slice(0, -4) + '.tsx']
  if (SOURCE_EXTENSIONS.includes(extension)) return [path]
  return [
    ...SOURCE_EXTENSIONS.map((sourceExtension) => path + sourceExtension),
    ...SOURCE_EXTENSIONS.map((sourceExtension) =>
      resolve(path, `index${sourceExtension}`)
    ),
  ]
}

function resolveLocalSpecifier(source, specifier)
{
  const base = resolve(dirname(source), specifier)
  return sourceCandidates(base).find((candidate) => existsSync(candidate))
}

function importIsTypeOnly(node)
{
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name || !clause.namedBindings) return false
  if (!ts.isNamedImports(clause.namedBindings)) return false
  return clause.namedBindings.elements.every((element) => element.isTypeOnly)
}

function exportIsTypeOnly(node)
{
  if (node.isTypeOnly) return true
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false
  return node.exportClause.elements.every((element) => element.isTypeOnly)
}

function collectEdges(files)
{
  const edges = []
  const unresolved = []

  function addEdge(source, specifier, runtime, kind)
  {
    if (!isLocalSpecifier(specifier)) return
    const target = resolveLocalSpecifier(source, specifier)
    if (!target)
    {
      unresolved.push({ source: toRepoPath(source), specifier })
      return
    }
    edges.push({
      source: toRepoPath(source),
      target: toRepoPath(target),
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

  return { edges, unresolved }
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
      errors.push(`only CLI files may depend on CLI composition: ${edge.source} -> ${edge.target}`)
    }
    if (target === 'tui' && source !== 'tui' && source !== 'cli')
    {
      errors.push(`only CLI composition may enter TUI: ${edge.source} -> ${edge.target}`)
    }
    if (source === 'agent')
    {
      forbid(edge, ['tui', 'session', 'telemetry'], 'Agent boundary')
    }
    if (source === 'tools')
    {
      forbid(edge, ['agent', 'tui', 'session', 'mcp'], 'tool boundary')
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
    }
    if (source === 'types' && target !== 'types')
    {
      errors.push(`types must remain a neutral source leaf: ${edge.source} -> ${edge.target}`)
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
      errors.push(`config must not depend on retrieval: ${edge.source} -> ${edge.target}`)
    }
    if (
      source === 'mcp' &&
      (edge.target === 'src/tools/index.ts' ||
        edge.target === 'src/tools/registry.ts')
    )
    {
      errors.push(`MCP must not load the built-in registry: ${edge.source} -> ${edge.target}`)
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
    topLevel(managerEdges[0].source) !== 'agent'
  )
  {
    const rendered =
      managerEdges.length === 0
        ? 'none'
        : managerEdges
            .map((edge) => `${edge.kind} ${edge.source}`)
            .join(', ')
    errors.push(
      `mcp/manager.ts must have one Agent-owned literal dynamic import; found ${rendered}`
    )
  }

  return errors
}

const files = collectSourceFiles(SOURCE_ROOT)
const { edges, unresolved } = collectEdges(files)
const cycles = runtimeCycles(files, edges)
const errors = dependencyErrors(edges)

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
