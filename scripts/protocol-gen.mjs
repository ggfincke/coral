// scripts/protocol-gen.mjs
// generate TS types, Ajv validators, and Pydantic models from protocol schemas

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import prettier from 'prettier'

const require = createRequire(import.meta.url)
const { compile } = require('json-schema-to-typescript')

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROTOCOL_DIR = join(REPO_ROOT, 'protocol')
const TS_OUT_DIR = join(REPO_ROOT, 'src/protocol/generated')
const PY_OUT_DIR = join(REPO_ROOT, 'protocol/generated/python')
const SDK_EXEC_OUT = join(
  REPO_ROOT,
  'packages/coral-sdk/src/coral_sdk/generated/exec_events.py'
)
const CHECK = process.argv.includes('--check')

const SCHEMA_FILES = [
  'exec-events.schema.json',
  'envelope.schema.json',
  'handshake.schema.json',
  'chat.schema.json',
  'model.schema.json',
  'embedding.schema.json',
]

const VALIDATOR_EXPORTS = [
  {
    schemaFile: 'exec-events.schema.json',
    validateName: 'validateCoralExecFrame',
    guardName: 'isCoralExecFrame',
    typeName: 'CoralExecFrame',
  },
  {
    schemaFile: 'envelope.schema.json',
    validateName: 'validateEnvelope',
    guardName: 'isEnvelope',
    typeName: 'Envelope',
  },
  {
    schemaFile: 'handshake.schema.json',
    validateName: 'validateHandshakeFrame',
    guardName: 'isHandshakeFrame',
    typeName: 'HandshakeFrame',
  },
  {
    schemaFile: 'chat.schema.json',
    validateName: 'validateChatProtocol',
    guardName: 'isChatProtocol',
    typeName: 'ChatProtocol',
  },
  {
    schemaFile: 'model.schema.json',
    validateName: 'validateModelProtocol',
    guardName: 'isModelProtocol',
    typeName: 'ModelProtocol',
  },
  {
    schemaFile: 'embedding.schema.json',
    validateName: 'validateEmbeddingProtocol',
    guardName: 'isEmbeddingProtocol',
    typeName: 'EmbeddingProtocol',
  },
]

const COMPILE_OPTIONS = {
  additionalProperties: false,
  bannerComment: '',
  cwd: PROTOCOL_DIR,
  declareExternallyReferenced: true,
  format: false,
  unreachableDefinitions: true,
  unknownAny: true,
}

function loadSchema(filename)
{
  return JSON.parse(readFileSync(join(PROTOCOL_DIR, filename), 'utf8'))
}

function tsHeader(repoPath, purpose)
{
  return `// ${repoPath}\n// ${purpose}\n`
}

function pyHeader(repoPath, purpose)
{
  return `# ${repoPath}\n# ${purpose}\n`
}

function stripGeneratedNoise(source)
{
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function formatTypeScript(source, absPath)
{
  const config = await prettier.resolveConfig(join(REPO_ROOT, 'package.json'))
  return prettier.format(source, {
    ...config,
    filepath: absPath,
  })
}

function pythonLiteral(value)
{
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value === null) return 'None'
  return String(value)
}

function refName(ref)
{
  const prefix = '#/$defs/'
  if (!ref.startsWith(prefix))
  {
    throw new Error(`unsupported $ref: ${ref}`)
  }
  return ref.slice(prefix.length)
}

function constrainedPythonType(type, schema)
{
  const constraints = []
  if (type === 'str')
  {
    if (schema.minLength !== undefined)
      constraints.push(`min_length=${pythonLiteral(schema.minLength)}`)
    if (schema.maxLength !== undefined)
      constraints.push(`max_length=${pythonLiteral(schema.maxLength)}`)
    if (schema.pattern !== undefined)
      constraints.push(`pattern=${pythonLiteral(schema.pattern)}`)
  }
  if (type === 'float' || type === 'int')
  {
    if (schema.minimum !== undefined)
      constraints.push(`ge=${pythonLiteral(schema.minimum)}`)
    if (schema.maximum !== undefined)
      constraints.push(`le=${pythonLiteral(schema.maximum)}`)
    if (schema.exclusiveMinimum !== undefined)
      constraints.push(`gt=${pythonLiteral(schema.exclusiveMinimum)}`)
    if (schema.exclusiveMaximum !== undefined)
      constraints.push(`lt=${pythonLiteral(schema.exclusiveMaximum)}`)
    if (schema.multipleOf !== undefined)
      constraints.push(`multiple_of=${pythonLiteral(schema.multipleOf)}`)
  }
  if (type.startsWith('list['))
  {
    if (schema.minItems !== undefined)
      constraints.push(`min_length=${pythonLiteral(schema.minItems)}`)
    if (schema.maxItems !== undefined)
      constraints.push(`max_length=${pythonLiteral(schema.maxItems)}`)
  }
  if (constraints.length === 0) return type
  return `Annotated[${type}, Field(${constraints.join(', ')})]`
}

function pythonType(schema)
{
  if (!schema || typeof schema !== 'object') return 'Any'
  if (schema.$ref) return refName(schema.$ref)
  if (schema.const !== undefined)
  {
    if (typeof schema.const === 'number')
    {
      const numberType = Number.isInteger(schema.const) ? 'int' : 'float'
      return constrainedPythonType(numberType, {
        minimum: schema.const,
        maximum: schema.const,
      })
    }
    return `Literal[${pythonLiteral(schema.const)}]`
  }
  if (Array.isArray(schema.enum))
  {
    return `Literal[${schema.enum.map(pythonLiteral).join(', ')}]`
  }
  if (Array.isArray(schema.anyOf))
  {
    return schema.anyOf.map((item) => pythonType(item)).join(' | ')
  }
  if (Array.isArray(schema.oneOf))
  {
    const branches = schema.oneOf.map((item) => pythonType(item))
    const branchTuple =
      branches.length === 1 ? `${branches[0]},` : branches.join(', ')
    return `Annotated[${branches.join(' | ')}, _one_of((${branchTuple}))]`
  }
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : []
  if (types.length > 1)
  {
    return types
      .map((item) => pythonType({ ...schema, type: item }))
      .join(' | ')
  }
  switch (types[0])
  {
    case 'string':
      return constrainedPythonType('str', schema)
    case 'number':
      return constrainedPythonType('float', schema)
    case 'integer':
      return constrainedPythonType('int', schema)
    case 'boolean':
      return 'bool'
    case 'null':
      return 'None'
    case 'array':
      return constrainedPythonType(
        `list[${pythonType(schema.items ?? {})}]`,
        schema
      )
    case 'object':
      return 'dict[str, Any]'
    default:
      return 'Any'
  }
}

function isObjectModel(schema)
{
  if (!schema || typeof schema !== 'object') return false
  if (
    schema.$ref ||
    schema.oneOf ||
    schema.anyOf ||
    schema.enum ||
    schema.const !== undefined
  )
  {
    return false
  }
  return schema.type === 'object' || Boolean(schema.properties)
}

function extraConfig(schema)
{
  return schema.additionalProperties === false ? 'forbid' : 'allow'
}

function emitPythonClass(name, schema)
{
  const required = new Set(schema.required ?? [])
  const properties = schema.properties ?? {}
  const lines = [
    `class ${name}(BaseModel):`,
    `    model_config = ConfigDict(extra=${JSON.stringify(extraConfig(schema))}, strict=True, allow_inf_nan=False)`,
  ]
  const keys = Object.keys(properties)
  if (keys.length === 0)
  {
    lines.push('    pass')
    return lines.join('\n')
  }
  for (const key of keys)
  {
    const fieldType = pythonType(properties[key])
    if (required.has(key)) lines.push(`    ${key}: ${fieldType}`)
    else lines.push(`    ${key}: ${fieldType} = Field(default=None)`)
  }
  return lines.join('\n')
}

function emitPythonAlias(name, schema)
{
  return `${name} = ${pythonType(schema)}`
}

const PYTHON_ONE_OF_HELPER = `def _one_of(branches: tuple[Any, ...]) -> BeforeValidator:
    adapters: tuple[TypeAdapter[Any], ...] | None = None

    def validate(value: Any) -> Any:
        nonlocal adapters
        if adapters is None:
            adapters = tuple(TypeAdapter(branch) for branch in branches)
        matches = 0
        for adapter in adapters:
            try:
                adapter.validate_python(value, strict=True)
            except ValidationError:
                continue
            matches += 1
        if matches != 1:
            raise ValueError(
                f"value must match exactly one oneOf branch; matched {matches}"
            )
        return value

    return BeforeValidator(validate)`

function pythonModuleName(schemaFile)
{
  return schemaFile.replace(/\.schema\.json$/, '').replaceAll('-', '_')
}

function generatePythonModule(schemaFile, schema)
{
  const module = pythonModuleName(schemaFile)
  const repoPath = `protocol/generated/python/${module}.py`
  const defs = schema.$defs ?? {}
  const objectNames = []
  const aliasNames = []
  for (const [name, defSchema] of Object.entries(defs))
  {
    if (isObjectModel(defSchema)) objectNames.push(name)
    else aliasNames.push(name)
  }

  const body = []
  for (const name of objectNames)
    body.push(emitPythonClass(name, defs[name]), '')
  for (const name of aliasNames)
    body.push(emitPythonAlias(name, defs[name]), '')

  if (isObjectModel(schema) && schema.title)
  {
    body.push(emitPythonClass(schema.title, schema), '')
  }
  else if (schema.oneOf && schema.title)
  {
    body.push(emitPythonAlias(schema.title, schema), '')
  }

  const bodyText = body.join('\n').trimEnd()
  const usesOneOf = bodyText.includes('_one_of(')
  const typing = []
  if (bodyText.includes('Annotated[')) typing.push('Annotated')
  if (bodyText.includes('Any') || usesOneOf) typing.push('Any')
  if (bodyText.includes('Literal[')) typing.push('Literal')
  const pydantic = ['BaseModel', 'ConfigDict', 'Field']
  if (usesOneOf)
    pydantic.push('BeforeValidator', 'TypeAdapter', 'ValidationError')
  const chunks = [
    pyHeader(
      repoPath,
      `generated Pydantic v2 models from protocol/${schemaFile}`
    ),
    'from __future__ import annotations',
    '',
    ...(typing.length > 0
      ? [`from typing import ${typing.join(', ')}`, '']
      : []),
    `from pydantic import ${pydantic.join(', ')}`,
    '',
    ...(usesOneOf ? [PYTHON_ONE_OF_HELPER, ''] : []),
    bodyText,
    '',
  ]
  return { module, source: chunks.join('\n') }
}

function generatePythonInit(modules)
{
  const imports = modules.map((module) => `from .${module} import *`).join('\n')
  return `${pyHeader(
    'protocol/generated/python/__init__.py',
    're-export generated Pydantic models for later Python packages'
  )}\n${imports}\n`
}

async function generateTypes(schemas)
{
  const parts = []
  for (const filename of SCHEMA_FILES)
  {
    const schema = schemas.get(filename)
    const compiled = await compile(schema, schema.title, COMPILE_OPTIONS)
    parts.push(stripGeneratedNoise(compiled))
  }
  const absPath = join(TS_OUT_DIR, 'types.ts')
  const source = `${tsHeader(
    'src/protocol/generated/types.ts',
    'generated TypeScript types from protocol/ JSON schemas'
  )}\n${parts.join('\n\n')}\n`
  return formatTypeScript(source, absPath)
}

async function generateValidators(schemas)
{
  const typeImports = VALIDATOR_EXPORTS.map((item) => item.typeName).join(', ')
  const schemaConsts = SCHEMA_FILES.map(
    (filename, index) =>
      `const schema${index} = ${JSON.stringify(
        schemas.get(filename)
      )} as Record<string, unknown>`
  ).join('\n')
  const validatorFns = VALIDATOR_EXPORTS.map((item) =>
  {
    const ident = `schema${SCHEMA_FILES.indexOf(item.schemaFile)}`
    return [
      `export const ${item.validateName} = compileSchema(${ident})`,
      '',
      `export function ${item.guardName}(value: unknown): value is ${item.typeName}`,
      '{',
      `  return ${item.validateName}(value).valid`,
      '}',
    ].join('\n')
  }).join('\n\n')

  const absPath = join(TS_OUT_DIR, 'validators.ts')
  const source = `${tsHeader(
    'src/protocol/generated/validators.ts',
    'generated Ajv validators with embedded protocol JSON schemas'
  )}
import addFormatsModule from 'ajv-formats'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ${typeImports} } from './types.js'

const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default

const ajv = addFormats(
  new Ajv2020({
    strict: false,
    strictNumbers: true,
    allErrors: true,
    discriminator: true,
  })
)

export interface ProtocolValidation
{
  valid: boolean
  errors?: string
}

function compileSchema(
  schema: Record<string, unknown>
): (value: unknown) => ProtocolValidation
{
  const validate = ajv.compile(schema)
  return (value) =>
  {
    if (validate(value)) return { valid: true }
    return { valid: false, errors: ajv.errorsText(validate.errors) }
  }
}

${schemaConsts}

${validatorFns}
`
  return formatTypeScript(source, absPath)
}

function writeGeneratedFile(path, contents)
{
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function sdkExecSource(source)
{
  return source.replace(
    /^# protocol\/generated\/python\/exec_events\.py\n# generated Pydantic v2 models from protocol\/exec-events\.schema\.json/,
    '# packages/coral-sdk/src/coral_sdk/generated/exec_events.py\n# vendored pydantic models from protocol/generated/python/exec_events.py'
  )
}

async function generatedOutputs()
{
  const schemas = new Map(
    SCHEMA_FILES.map((filename) => [filename, loadSchema(filename)])
  )
  const types = await generateTypes(schemas)
  const validators = await generateValidators(schemas)
  const pythonModules = SCHEMA_FILES.map((filename) =>
    generatePythonModule(filename, schemas.get(filename))
  )

  const outputs = new Map([
    [join(TS_OUT_DIR, 'types.ts'), types],
    [join(TS_OUT_DIR, 'validators.ts'), validators],
  ])
  for (const item of pythonModules)
  {
    outputs.set(join(PY_OUT_DIR, `${item.module}.py`), item.source)
  }
  outputs.set(
    join(PY_OUT_DIR, '__init__.py'),
    generatePythonInit(pythonModules.map((item) => item.module))
  )
  const execModule = pythonModules.find((item) => item.module === 'exec_events')
  if (!execModule)
    throw new Error('exec-events schema did not produce a module')
  outputs.set(SDK_EXEC_OUT, sdkExecSource(execModule.source))
  return outputs
}

function generatedFiles(root)
{
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true }))
  {
    if (entry.name === '__pycache__') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...generatedFiles(path))
    else files.push(path)
  }
  return files
}

function checkGenerated(outputs)
{
  const expected = [...outputs.keys()].sort()
  const actual = [
    ...generatedFiles(TS_OUT_DIR),
    ...generatedFiles(PY_OUT_DIR),
    ...(existsSync(SDK_EXEC_OUT) ? [SDK_EXEC_OUT] : []),
  ].sort()
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const failures = []
  for (const path of expected)
  {
    if (!actualSet.has(path))
    {
      failures.push(`missing ${relative(REPO_ROOT, path)}`)
      continue
    }
    if (readFileSync(path, 'utf8') !== outputs.get(path))
      failures.push(`changed ${relative(REPO_ROOT, path)}`)
  }
  for (const path of actual)
  {
    if (!expectedSet.has(path))
      failures.push(`extra ${relative(REPO_ROOT, path)}`)
  }
  if (failures.length === 0)
  {
    process.stdout.write('protocol:check passed\n')
    return
  }
  process.stderr.write(`${failures.join('\n')}\n`)
  process.stderr.write(
    'protocol:check failed: generated files differ. Run npm run protocol:gen.\n'
  )
  process.exitCode = 1
}

function writeGenerated(outputs)
{
  rmSync(TS_OUT_DIR, { recursive: true, force: true })
  rmSync(PY_OUT_DIR, { recursive: true, force: true })
  for (const [path, contents] of outputs) writeGeneratedFile(path, contents)
  const written = [
    relative(REPO_ROOT, join(TS_OUT_DIR, 'types.ts')),
    relative(REPO_ROOT, join(TS_OUT_DIR, 'validators.ts')),
    relative(REPO_ROOT, PY_OUT_DIR),
    relative(REPO_ROOT, SDK_EXEC_OUT),
  ]
  process.stdout.write(`protocol:gen wrote ${written.join(', ')}\n`)
}

const outputs = await generatedOutputs()
if (CHECK) checkGenerated(outputs)
else writeGenerated(outputs)
