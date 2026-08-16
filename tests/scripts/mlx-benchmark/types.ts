// tests/scripts/mlx-benchmark/types.ts
// machine-readable contracts for the benchmark evidence and decision

export type TopologyKind = 'ollama' | 'stock-mlx' | 'custom-mlx'
export type TopologyRole = 'baseline' | 'candidate' | 'forensic'

export type HardGateCategory =
  | 'artifact-availability'
  | 'correctness'
  | 'tool-semantics'
  | 'context'
  | 'lifecycle'
  | 'residency'

export type PrimaryMetric =
  | 'coldFirstDeltaMs'
  | 'warmTtftMs'
  | 'promptTokensPerSecond'
  | 'decodeTokensPerSecond'
  | 'agentWallMs'
  | 'peakRssAboveBaselineBytes'

export interface ArtifactIdentity
{
  model: string
  revision: string
  tokenizerRevision: string
  chatTemplateSha256: string
  quantization: string
  contextWindow: number
  localPath: string
}

export interface ModelPair
{
  id: string
  description: string
  localEvidence: string[]
  ollama: ArtifactIdentity
  mlx: ArtifactIdentity
}

export interface TopologyIdentity
{
  id: string
  kind: TopologyKind
  role: TopologyRole
  description: string
  immutableRevision: string
  requiredCapability?: string
  launchPorts?: number[]
}

export interface MachineIdentity
{
  chip: string
  unifiedMemoryBytes: number
  os: string
  powerMode: string
}

export interface SoftwareIdentity
{
  coralRevision: string
  node: string
  ollama: string
  mlx: string
  mlxLm: string
  python: string
  uv: string
}

export interface BenchmarkProvenance
{
  generatedAt: string
  machine: MachineIdentity
  software: SoftwareIdentity
  command: string[]
  environment: Record<string, string>
  notes: string[]
}

export interface ToolEvidence
{
  expectedCalls?: number
  actualCalls: number
  toolErrors: number
  repairedToolCalls: number
  nameRepairs: number
  stallNudges: number
  validationFailures: number
  editRepairs: number
  reprompts: number
  maxCallsInResponse: number
  argumentsMatched?: boolean
  thinkingChars: number
  reasoningWithToolCall?: boolean
  textBeforeToolCall?: boolean
  priorToolResultUsed?: boolean
}

export interface HardGateObservation
{
  topologyId: string
  modelPairId: string
  category: HardGateCategory
  caseId: string
  repetition: number
  passed: boolean
  detail: string
  sequence: number
  promptTokens?: number
  toolEvidence?: ToolEvidence
  memorySnapshots?: ResidencyMemorySnapshot[]
}

export interface ResidencyMemorySnapshot
{
  stage: string
  processTreeRssBytes: number
  mlxAllocatorActiveBytes?: number
  mlxAllocatorCacheBytes?: number
  mlxAllocatorPeakBytes?: number
  mlxModelIdentity?: string
}

export interface MetricVector
{
  coldFirstDeltaMs?: number
  warmTtftMs?: number
  promptTokensPerSecond?: number
  decodeTokensPerSecond?: number
  agentWallMs?: number
  peakRssAboveBaselineBytes?: number
  unloadedRssBytes?: number
  peakAbsoluteRssBytes?: number
  mlxAllocatorActiveBytes?: number
  mlxAllocatorCacheBytes?: number
  mlxAllocatorPeakBytes?: number
}

export interface MlxAllocatorMetrics
{
  activeBytes: number
  cacheBytes: number
  peakBytes: number
  modelIdentity?: string
}

export interface PairedMetricSample
{
  pairIndex: number
  order: 'baseline-first' | 'candidate-first'
  baseline: MetricVector
  candidate: MetricVector
}

export interface PerformanceCell
{
  candidateTopologyId: string
  modelPairId: string
  workloadId: string
  warmupsCompleted: number
  metrics: PrimaryMetric[]
  samples: PairedMetricSample[]
}

export interface BenchmarkPolicySnapshot
{
  warmups: number
  measuredRuns: number
  bootstrapIterations: number
  confidenceLevel: number
  requiredImprovement: number
  maximumRegression: number
  rssSampleIntervalMs: number
}

export interface BenchmarkResult
{
  schemaVersion: 1
  runId: string
  status: 'pending' | 'complete'
  provenance: BenchmarkProvenance
  policy: BenchmarkPolicySnapshot
  configuration: BenchmarkRunConfiguration
  topologies: TopologyIdentity[]
  forensicFindings: ForensicFinding[]
  modelPairs: ModelPair[]
  baselineSmokes: BaselineSmokeEvidence[]
  hardGates: HardGateObservation[]
  performanceCells: PerformanceCell[]
}

export interface ForensicFinding
{
  topologyId: string
  immutableRevision: string
  disposition: 'disqualified'
  findings: string[]
}

export interface BaselineSmokeEvidence
{
  topologyId: string
  modelPairId: string
  passed: boolean
  detail: string
  temperature: 0
  think: false
  contextWindow: number
  promptTokens: number
  completionTokens: number
  loadMs: number
  totalMs: number
  finishReason: string
  artifactRevision: string
}

export interface ProcessLaunchConfig
{
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

interface CommonTopologyConfig
{
  id: string
  role: TopologyRole
  description: string
  requiredCapability?: string
}

export interface OllamaTopologyConfig extends CommonTopologyConfig
{
  kind: 'ollama'
  host: string
  listenerPort: number
  processRootPids: number[]
}

export interface StockMlxTopologyConfig extends CommonTopologyConfig
{
  kind: 'stock-mlx'
  launch: ProcessLaunchConfig
  host: '127.0.0.1'
  bindAttempts: number
  deniedBrowserOrigin: string
  startupTimeoutMs: number
}

export interface CustomMlxTopologyConfig extends CommonTopologyConfig
{
  kind: 'custom-mlx'
  checkout: string
  expectedRevision: string
  environment: Record<string, string>
}

export type BenchmarkTopologyConfig =
  OllamaTopologyConfig | StockMlxTopologyConfig | CustomMlxTopologyConfig

export interface BenchmarkRunConfiguration
{
  contextCeiling: number
  maxOutputTokens: number
  requestTimeoutMs: number
  temperature: 0
  topP: 1
  topologies: BenchmarkTopologyConfig[]
}

export interface BenchmarkConfig
{
  configVersion: 1
  runId: string
  output: string
  resultSchema: string
  machine: MachineIdentity
  software: SoftwareIdentity
  modelPairs: ModelPair[]
  topologies: BenchmarkTopologyConfig[]
  contextCeiling: number
  maxOutputTokens: number
  requestTimeoutMs: number
  temperature: 0
  topP: 1
  environmentAllowlist: string[]
}

export interface ConfidenceInterval
{
  estimate: number
  lower: number
  upper: number
}

export interface MetricDecision
{
  metric: PrimaryMetric
  aggregate: ConfidenceInterval
  cells: Array<{
    modelPairId: string
    workloadId: string
    interval: ConfidenceInterval
  }>
}

export interface CandidateDecision
{
  topologyId: string
  hardGatesPassed: boolean
  performancePassed: boolean
  materialImprovement: boolean
  qualified: boolean
  metrics: MetricDecision[]
  failures: string[]
}

export interface BenchmarkDecision
{
  schemaVersion: 1
  runId: string
  verdict: 'go' | 'no-go'
  selectedTopologyId?: string
  baselineTopologyId: string
  candidates: CandidateDecision[]
  failures: string[]
  generatedAt: string
}
