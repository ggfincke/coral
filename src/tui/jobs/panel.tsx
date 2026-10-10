// src/tui/jobs/panel.tsx
// view and control durable coding tasks independently of the chat session

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box } from 'ink'
import { controlJob } from '../../jobs/client.js'
import { getJobDiff } from '../../jobs/git.js'
import { createJobPlan } from '../../jobs/plan.js'
import { assertJobsPlatform } from '../../jobs/process.js'
import {
  jobSpecDigest,
  listJobRecords,
  parseJobSpec,
  readJob,
  readJobEvents,
  readJobSnapshot,
} from '../../jobs/store.js'
import type { JobEvent, JobRecord } from '../../jobs/types.js'
import type { SessionData } from '../../session/types.js'
import { toErrorMessage } from '../../utils/errors.js'
import { sanitizeUntrustedText } from '../../utils/untrusted-text.js'
import { LineList } from '../components/line-list.js'
import { useCoralInput } from '../input/use-coral-input.js'
import { runInExternalEditor } from '../prompt/editor-handoff.js'
import PromptInput from '../prompt/prompt-input.js'
import { selectionStyle, style } from '../theme.js'
import { physicalLines, truncateLine } from '../wrap.js'
import {
  JOB_TABS,
  jobDetailLines,
  orderJobs,
  type JobTab,
} from './presentation.js'

interface JobPanelProps
{
  active: boolean
  width: number
  height: number
  cwd: string
  model: string
  host: string
  suspendTerminal: (callback: () => Promise<void>) => Promise<void>
  onClose: () => void
}

interface CreationFields
{
  objective: string
  cwd: string
  model: string
  ref: string
  minutes: string
  repairs: string
}

const CREATE_FIELDS: { key: keyof CreationFields; label: string }[] = [
  { key: 'objective', label: 'Objective' },
  { key: 'cwd', label: 'Repository' },
  { key: 'model', label: 'Ollama model' },
  { key: 'ref', label: 'Committed ref' },
  { key: 'minutes', label: 'Active minutes' },
  { key: 'repairs', label: 'Repair attempts' },
]

type PanelScreen =
  | { kind: 'list' }
  | { kind: 'detail'; id: string; tab: JobTab }
  | { kind: 'create'; fields: CreationFields; field: number; editing: boolean }
  | { kind: 'cancel'; id: string }
  | {
      kind: 'resume'
      id: string
      instructions: string
      editing: boolean
      setupResolution?: 'retry' | 'skip'
      shellResolution?: 'continue' | 'retry'
    }

const EMPTY_COMPLETIONS: [] = []
const NO_ACTION = () =>
{}

export default function JobPanel({
  active,
  width,
  height,
  cwd,
  model,
  host,
  suspendTerminal,
  onClose,
}: JobPanelProps)
{
  const [screen, setScreen] = useState<PanelScreen>({ kind: 'list' })
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [events, setEvents] = useState<JobEvent[]>([])
  const [snapshot, setSnapshot] = useState<SessionData>()
  const [diff, setDiff] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [unreadable, setUnreadable] = useState(0)
  const [externalEditorOpen, setExternalEditorOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [offset, setOffset] = useState(0)
  const [acknowledgedDigest, setAcknowledgedDigest] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(false)
  const actionActive = useRef(false)
  const actionAbort = useRef<AbortController | undefined>(undefined)
  const pollGeneration = useRef(0)

  const detailId =
    screen.kind === 'detail' ||
    screen.kind === 'cancel' ||
    screen.kind === 'resume'
      ? screen.id
      : undefined
  const tab = screen.kind === 'detail' ? screen.tab : 'overview'
  const current = jobs.find((job) => job.id === detailId)
  const selectedIndex = Math.max(
    0,
    jobs.findIndex((job) => job.id === selectedId)
  )
  const digest = current ? jobSpecDigest(current.spec) : undefined
  const acknowledged = digest !== undefined && acknowledgedDigest === digest
  const editing =
    (screen.kind === 'create' || screen.kind === 'resume') && screen.editing
  const overviewTime =
    screen.kind === 'detail' && screen.tab === 'overview' ? now : 0

  useEffect(() =>
  {
    mounted.current = true
    return () =>
    {
      mounted.current = false
      actionAbort.current?.abort()
    }
  }, [])

  // each mounted view has one joined poll, and stale diff reads cannot repaint it
  useEffect(() =>
  {
    const generation = ++pollGeneration.current
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let previousSnapshot: string | undefined
    const accepts = () =>
      !controller.signal.aborted && pollGeneration.current === generation
    async function poll()
    {
      try
      {
        const listing = listJobRecords()
        const records = orderJobs(listing.jobs)
        if (!accepts()) return
        setUnreadable(listing.invalid.length)
        setJobs((previous) =>
          records.map((record) =>
          {
            const retained = previous.find((item) => item.id === record.id)
            return retained?.updatedAt === record.updatedAt &&
              retained.status === record.status &&
              jobSpecDigest(retained.spec) === jobSpecDigest(record.spec)
              ? retained
              : record
          })
        )
        setNow(Date.now())
        const job = records.find((record) => record.id === detailId)
        if (detailId && !job) throw new Error(`Task not found: ${detailId}`)
        if (job && tab === 'events') setEvents(readJobEvents(job.id))
        if (job && tab === 'transcript' && job.snapshot !== previousSnapshot)
        {
          setSnapshot(
            job.snapshot ? readJobSnapshot(job.id, job.snapshot) : undefined
          )
          previousSnapshot = job.snapshot
        }
        if (job && tab === 'diff')
        {
          const text = await getJobDiff(job, controller.signal)
          if (accepts()) setDiff(text)
        }
      }
      catch (cause)
      {
        if (accepts()) setError(toErrorMessage(cause))
      }
      finally
      {
        if (accepts()) timer = setTimeout(() => void poll(), 1500)
      }
    }
    void poll()
    return () =>
    {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [detailId, tab, refresh])

  const navigate = useCallback((next: PanelScreen) =>
  {
    setScreen(next)
    setOffset(0)
    setError('')
    setNotice('')
    setAcknowledgedDigest(undefined)
    setEvents([])
    setSnapshot(undefined)
    setDiff('')
  }, [])

  const close = useCallback(() =>
  {
    mounted.current = false
    actionAbort.current?.abort()
    onClose()
  }, [onClose])

  const back = () =>
  {
    if (busy) close()
    else if (
      (screen.kind === 'create' || screen.kind === 'resume') &&
      screen.editing
    )
      setScreen({ ...screen, editing: false })
    else if (screen.kind === 'cancel' || screen.kind === 'resume')
      navigate({ kind: 'detail', id: screen.id, tab: 'overview' })
    else if (screen.kind !== 'list') navigate({ kind: 'list' })
    else close()
  }

  const perform = async (
    label: string,
    work: (signal: AbortSignal) => Promise<void>,
    externalEditor = false
  ) =>
  {
    if (actionActive.current) return
    actionActive.current = true
    const controller = new AbortController()
    actionAbort.current = controller
    setBusy(label)
    setExternalEditorOpen(externalEditor)
    setError('')
    setNotice('')
    try
    {
      await work(controller.signal)
    }
    catch (cause)
    {
      if (mounted.current) setError(toErrorMessage(cause))
    }
    finally
    {
      actionActive.current = false
      if (actionAbort.current === controller) actionAbort.current = undefined
      if (mounted.current)
      {
        setBusy('')
        setExternalEditorOpen(false)
        setRefresh((value) => value + 1)
      }
    }
  }

  const create = () =>
  {
    if (screen.kind !== 'create') return
    const fields = screen.fields
    void perform(
      'Inspecting committed code and proposing a plan…',
      async (signal) =>
      {
        assertJobsPlatform()
        const minutes = Number(fields.minutes)
        const repairs = Number(fields.repairs)
        if (
          !fields.minutes.trim() ||
          !Number.isFinite(minutes) ||
          minutes <= 0 ||
          !Number.isSafeInteger(minutes * 60_000)
        )
          throw new Error(
            'Active minutes must resolve to a positive whole number of milliseconds.'
          )
        if (
          !fields.repairs.trim() ||
          !Number.isSafeInteger(repairs) ||
          repairs < 0
        )
          throw new Error('Repair attempts must be a nonnegative whole number.')
        const job = await createJobPlan(
          {
            cwd: fields.cwd,
            model: fields.model,
            host,
            objective: fields.objective,
            ...(fields.ref.trim() ? { ref: fields.ref.trim() } : {}),
            activeTimeLimitMs: minutes * 60_000,
            maxRepairs: repairs,
          },
          {},
          signal
        )
        if (!mounted.current) return
        setJobs((previous) =>
          orderJobs([...previous.filter((item) => item.id !== job.id), job])
        )
        setSelectedId(job.id)
        navigate({ kind: 'detail', id: job.id, tab: 'overview' })
        setNotice(
          'Draft saved. Review every command and limit before starting.'
        )
      }
    )
  }

  const editDraft = () =>
  {
    if (!current || current.status !== 'draft') return
    setAcknowledgedDigest(undefined)
    const id = current.id
    void perform(
      'Editing the task specification…',
      async () =>
      {
        const before = readJob(id)
        if (before.status !== 'draft')
          throw new Error('Only a draft task can be edited.')
        const beforeDigest = jobSpecDigest(before.spec)
        await suspendTerminal(async () =>
        {
          const outcome = await runInExternalEditor(
            JSON.stringify(before.spec, null, 2)
          )
          if (outcome.text === null || !mounted.current) return
          const spec = parseJobSpec(JSON.parse(outcome.text) as unknown)
          await controlJob({ action: 'edit', id, digest: beforeDigest, spec })
          if (mounted.current)
          {
            setAcknowledgedDigest(undefined)
            setOffset(0)
            setNotice(
              'Draft updated. Review the changes and acknowledge host execution again.'
            )
          }
        })
      },
      true
    )
  }

  const start = () =>
  {
    if (!current || current.status !== 'draft' || !digest) return
    if (!acknowledged)
    {
      setError(
        'Press space to acknowledge that the reviewed commands run on this host, then s to start.'
      )
      return
    }
    const id = current.id
    void perform(
      'Approving this exact draft and queueing the task…',
      async () =>
      {
        await controlJob({ action: 'start', id, digest, hostShell: true })
        if (mounted.current)
        {
          setAcknowledgedDigest(undefined)
          setNotice(
            'Task queued. You can close this viewer; execution continues in the background.'
          )
        }
      }
    )
  }

  const cancel = () =>
  {
    if (screen.kind !== 'cancel') return
    const id = screen.id
    void perform(
      'Cancelling the task and awaiting owned processes…',
      async () =>
      {
        await controlJob({ action: 'cancel', id })
        if (mounted.current)
        {
          navigate({ kind: 'detail', id, tab: 'overview' })
          setNotice(
            'Cancellation requested. The task record shows the settled result.'
          )
        }
      }
    )
  }

  const resume = () =>
  {
    if (screen.kind !== 'resume' || !current) return
    const { id, instructions, setupResolution, shellResolution } = screen
    if (!instructions.trim())
    {
      setError('Add continuation instructions before queueing the task.')
      return
    }
    if (current.pendingCommand?.phase === 'setup' && !setupResolution)
    {
      setError(
        'Inspect the unsettled setup command, then choose r to retry it or k to skip it.'
      )
      return
    }
    if (
      current.pendingCommand?.phase === 'checks' &&
      shellResolution !== 'retry'
    )
    {
      setError(
        'Inspect the interrupted verification command, then choose t to authorize rerunning the complete check suite.'
      )
      return
    }
    if (
      current.unsettledShells?.some((shell) => !shell.result) &&
      !shellResolution
    )
    {
      setError(
        'Inspect the unsettled Agent shell commands, then choose c to continue with their effects or t to permit retry.'
      )
      return
    }
    void perform('Queueing explicit continuation…', async () =>
    {
      await controlJob({
        action: 'resume',
        id,
        instructions,
        ...(setupResolution ? { setupResolution } : {}),
        ...(shellResolution ? { shellResolution } : {}),
      })
      if (mounted.current)
      {
        navigate({ kind: 'detail', id, tab: 'overview' })
        setNotice(
          'Continuation queued with the existing time and repair budgets.'
        )
      }
    })
  }

  const body = useMemo(() =>
  {
    if (screen.kind === 'list') return []
    if (screen.kind === 'create')
    {
      return [
        ...CREATE_FIELDS.map((field, index) =>
        {
          const value =
            screen.fields[field.key] ||
            (field.key === 'ref'
              ? '(current HEAD; requires a clean checkout)'
              : '(empty)')
          const line = truncateLine(
            `${index === screen.field ? '› ' : '  '}${field.label}: ${sanitizeUntrustedText(value).replaceAll('\n', ' ')}`,
            width
          )
          return index === screen.field ? selectionStyle()(line) : line
        }),
        '',
        ...physicalLines(
          [
            'Set ref to HEAD (or another committed ref) to explicitly use committed files when the source checkout is dirty.',
            `Planning uses ${sanitizeUntrustedText(host)} and reads the selected commit. It does not execute setup or verification commands.`,
          ],
          width
        ),
      ]
    }
    if (!current) return ['Loading task…']
    if (screen.kind === 'cancel')
      return physicalLines(
        [
          style('warning').bold(`Cancel task ${current.id}?`),
          '',
          'Cancellation stops this task and waits for its owned process group to terminate. Its worktree, files, and evidence are preserved.',
          '',
          'Press y to cancel the task. Escape returns to the viewer and leaves it running.',
        ],
        width
      )
    if (screen.kind === 'resume')
      return physicalLines(
        [
          style('accent').bold(`Continue task ${current.id}`),
          'Consumed time and repair attempts are retained. Review the worktree and command evidence before continuing.',
          '',
          'Additional instructions:',
          sanitizeUntrustedText(screen.instructions || '(enter instructions)'),
          '',
          ...(current.pendingCommand?.phase === 'setup'
            ? [
                style('warning')('This setup command has no settled result:'),
                sanitizeUntrustedText(current.pendingCommand.command),
                'r = explicitly retry it; k = skip it after inspecting its effects.',
                `Setup decision: ${screen.setupResolution ?? '(required)'}`,
              ]
            : []),
          ...(current.unsettledShells?.some((shell) => !shell.result)
            ? [
                '',
                style('warning')(
                  'These Agent shell commands have no settled result:'
                ),
                ...current.unsettledShells
                  .filter((shell) => !shell.result)
                  .map((shell) => sanitizeUntrustedText(shell.command)),
                'c = continue with existing effects; t = explicitly permit retry after reconciliation.',
                `Shell decision: ${screen.shellResolution ?? '(required)'}`,
              ]
            : []),
          ...(current.pendingCommand?.phase === 'checks'
            ? [
                '',
                style('warning')(
                  'This verification command has no settled result:'
                ),
                sanitizeUntrustedText(current.pendingCommand.command),
                't = authorize rerunning the full check suite after inspecting its effects.',
                `Check retry decision: ${screen.shellResolution === 'retry' ? 'authorized' : '(required)'}`,
              ]
            : []),
        ],
        width
      )
    return jobDetailLines(
      current,
      screen.tab,
      width,
      overviewTime,
      events,
      snapshot,
      diff
    )
  }, [current, diff, events, host, overviewTime, screen, snapshot, width])

  const promptRows = editing ? Math.min(4, Math.max(1, height - 6)) : 0
  const chromeRows =
    5 + (current?.status === 'draft' && screen.kind === 'detail' ? 1 : 0)
  const bodyHeight = Math.max(1, height - chromeRows - promptRows)
  const maxOffset = Math.max(0, body.length - bodyHeight)
  const shownOffset =
    screen.kind === 'create'
      ? Math.min(Math.max(screen.field - bodyHeight + 1, 0), maxOffset)
      : Math.min(offset, maxOffset)
  const listStart = Math.max(0, selectedIndex - bodyHeight + 1)
  const visible =
    screen.kind === 'list'
      ? jobs.length
        ? jobs.slice(listStart, listStart + bodyHeight).map((job) =>
          {
            const line = truncateLine(
              `${job.id === jobs[selectedIndex]?.id ? '›' : ' '} ${job.id} · ${job.status}${job.phase ? `/${job.phase}` : ''} · ${sanitizeUntrustedText(job.spec.objective).replaceAll('\n', ' ')}`,
              width
            )
            return job.id === jobs[selectedIndex]?.id
              ? selectionStyle()(line)
              : line
          })
        : ['No durable tasks yet. Press n to prepare one.']
      : body.slice(shownOffset, shownOffset + bodyHeight)

  useCoralInput(
    (input, key) =>
    {
      if (key.escape || (key.ctrl && input === 'c'))
      {
        back()
        return
      }
      if (busy) return
      if (screen.kind === 'list')
      {
        if (key.upArrow || key.downArrow || key.pageUp || key.pageDown)
        {
          const direction = key.upArrow || key.pageUp ? -1 : 1
          const step = key.pageUp || key.pageDown ? bodyHeight : 1
          const next = Math.min(
            Math.max(selectedIndex + direction * step, 0),
            jobs.length - 1
          )
          setSelectedId(jobs[next]?.id)
        }
        else if (key.return && jobs[selectedIndex])
          navigate({
            kind: 'detail',
            id: jobs[selectedIndex].id,
            tab: 'overview',
          })
        else if (input === 'n')
          navigate({
            kind: 'create',
            fields: {
              cwd,
              model,
              objective: '',
              ref: '',
              minutes: '120',
              repairs: '3',
            },
            field: 0,
            editing: false,
          })
        return
      }
      if (screen.kind === 'create')
      {
        if (key.upArrow || key.downArrow)
          setScreen({
            ...screen,
            field: Math.min(
              Math.max(screen.field + (key.upArrow ? -1 : 1), 0),
              CREATE_FIELDS.length - 1
            ),
          })
        else if (key.return) setScreen({ ...screen, editing: true })
        else if (input === 'p') create()
        return
      }
      if (
        key.upArrow ||
        key.downArrow ||
        key.pageUp ||
        key.pageDown ||
        key.wheelUp ||
        key.wheelDown
      )
      {
        const direction = key.upArrow || key.pageUp || key.wheelUp ? -1 : 1
        const step = key.pageUp || key.pageDown ? bodyHeight : 1
        setOffset(
          Math.min(Math.max(shownOffset + direction * step, 0), maxOffset)
        )
        return
      }
      if (screen.kind === 'cancel')
      {
        if (input === 'y') cancel()
        else if (input === 'n') back()
        return
      }
      if (screen.kind === 'resume')
      {
        if (input === 'e') setScreen({ ...screen, editing: true })
        else if (input === 'r' && current?.pendingCommand?.phase === 'setup')
          setScreen({ ...screen, setupResolution: 'retry' })
        else if (input === 'k' && current?.pendingCommand?.phase === 'setup')
          setScreen({ ...screen, setupResolution: 'skip' })
        else if (
          input === 'c' &&
          current?.unsettledShells?.some((shell) => !shell.result)
        )
          setScreen({ ...screen, shellResolution: 'continue' })
        else if (
          input === 't' &&
          (current?.unsettledShells?.some((shell) => !shell.result) ||
            current?.pendingCommand?.phase === 'checks')
        )
          setScreen({ ...screen, shellResolution: 'retry' })
        else if (key.return) resume()
        return
      }
      if (key.tab || key.leftArrow || key.rightArrow || /^[1-5]$/.test(input))
      {
        const index = JOB_TABS.indexOf(screen.tab)
        const next = /^[1-5]$/.test(input)
          ? Number(input) - 1
          : (index + (key.leftArrow || key.shift ? -1 : 1) + JOB_TABS.length) %
            JOB_TABS.length
        setScreen({ ...screen, tab: JOB_TABS[next] })
        setOffset(0)
      }
      else if (input === 'g') setOffset(0)
      else if (input === 'G') setOffset(maxOffset)
      else if (input === 'e') editDraft()
      else if (input === ' ' && current?.status === 'draft')
        setAcknowledgedDigest(acknowledged ? undefined : digest)
      else if (input === 's') start()
      else if (
        input === 'c' &&
        current &&
        ['draft', 'queued', 'running', 'interrupted', 'needs_input'].includes(
          current.status
        )
      )
        navigate({ kind: 'cancel', id: current.id })
      else if (
        input === 'r' &&
        current &&
        current.approval &&
        !['draft', 'queued', 'running'].includes(current.status)
      )
        navigate({
          kind: 'resume',
          id: current.id,
          instructions: '',
          editing: true,
        })
    },
    { isActive: active && !editing && !externalEditorOpen }
  )

  const inputValue =
    screen.kind === 'create'
      ? screen.fields[CREATE_FIELDS[screen.field].key]
      : screen.kind === 'resume'
        ? screen.instructions
        : ''
  const changeInput = (value: string) =>
  {
    if (screen.kind === 'create')
      setScreen({
        ...screen,
        fields: { ...screen.fields, [CREATE_FIELDS[screen.field].key]: value },
      })
    else if (screen.kind === 'resume')
      setScreen({ ...screen, instructions: value })
  }
  const submitInput = (value: string) =>
  {
    if (screen.kind === 'create')
      setScreen({
        ...screen,
        fields: { ...screen.fields, [CREATE_FIELDS[screen.field].key]: value },
        editing: false,
      })
    else if (screen.kind === 'resume')
      setScreen({ ...screen, instructions: value, editing: false })
  }
  // PromptInput applies the returned text itself; null leaves the draft as-is
  const editInput = async (draft: string): Promise<string | null> =>
  {
    const outcome: { text: string | null } = { text: null }
    await perform(
      'Editing instructions…',
      async () =>
      {
        await suspendTerminal(async () =>
        {
          outcome.text = (await runInExternalEditor(draft)).text
        })
      },
      true
    )
    return mounted.current ? outcome.text : null
  }

  const heading =
    screen.kind === 'list'
      ? `Durable coding tasks · ${jobs.length}`
      : screen.kind === 'create'
        ? 'Prepare a durable coding task'
        : `${detailId} · ${current?.status ?? 'loading'}${current?.phase ? ` · ${current.phase}` : ''}`
  const tabs =
    screen.kind === 'detail'
      ? JOB_TABS.map((name, index) =>
          name === screen.tab
            ? style('accent').bold(`${index + 1} ${name}`)
            : style('muted')(`${index + 1} ${name}`)
        ).join('  ')
      : style('muted')(
          'Closing this viewer leaves queued and running tasks intact.'
        )
  const hint = editing
    ? 'enter accepts · esc finishes editing · ctrl+g editor'
    : screen.kind === 'list'
      ? '↑↓ select · enter inspect · n new · esc close'
      : screen.kind === 'create'
        ? '↑↓ field · enter edit · p propose plan · esc back'
        : screen.kind === 'cancel'
          ? 'y cancel task · n / esc return'
          : screen.kind === 'resume'
            ? `e edit ·${current?.pendingCommand?.phase === 'setup' ? ' r retry setup / k skip ·' : ''}${current?.unsettledShells?.some((shell) => !shell.result) ? ' c accept effects / t permit retry ·' : ''}${current?.pendingCommand?.phase === 'checks' ? ' t retry checks ·' : ''} enter continue · ↑↓ scroll · esc back`
            : current?.status === 'draft'
              ? 'e edit JSON · space acknowledge · s start · c cancel · tab view · ↑↓ scroll · esc back'
              : `tab view · ↑↓ / pgup pgdn scroll · g/G top/end${current && ['queued', 'running', 'interrupted', 'needs_input'].includes(current.status) ? ' · c cancel' : ''}${current?.approval && !['draft', 'queued', 'running'].includes(current.status) ? ' · r continue' : ''} · esc back`
  return (
    <Box flexDirection="column" height={height} overflowY="hidden">
      <LineList
        lines={[
          style('primary').bold(truncateLine(heading, width)),
          truncateLine(tabs, width),
        ]}
      />
      <Box flexDirection="column" height={bodyHeight} overflowY="hidden">
        <LineList lines={visible} />
      </Box>
      {editing && (
        <Box height={promptRows} flexShrink={0}>
          <PromptInput
            key={
              screen.kind === 'create'
                ? CREATE_FIELDS[screen.field].key
                : 'continuation'
            }
            value={inputValue}
            width={width}
            maxHeight={promptRows}
            allocatedHeight={promptRows}
            focus={active && !busy}
            completionCommands={EMPTY_COMPLETIONS}
            onChange={changeInput}
            onSubmit={submitInput}
            onEscape={back}
            onInterrupt={close}
            onPageUp={NO_ACTION}
            onPageDown={NO_ACTION}
            onJumpTop={NO_ACTION}
            onJumpBottom={NO_ACTION}
            onHalfPageUp={NO_ACTION}
            onHalfPageDown={NO_ACTION}
            onToggleToolOutput={NO_ACTION}
            onScrollUp={NO_ACTION}
            onScrollDown={NO_ACTION}
            onToggleThinking={NO_ACTION}
            onTogglePermissions={NO_ACTION}
            onOpenPalette={NO_ACTION}
            onHistoryUp={NO_ACTION}
            onHistoryDown={NO_ACTION}
            onOpenEditor={editInput}
          />
        </Box>
      )}
      {current?.status === 'draft' && screen.kind === 'detail' && (
        <LineList
          lines={[
            truncateLine(
              `${acknowledged ? '[x]' : '[ ]'} Shell commands run on this host. Worktrees are not sandboxes.`,
              width
            ),
          ]}
        />
      )}
      <LineList
        lines={[
          truncateLine(
            busy
              ? style('accent')(busy)
              : error
                ? style('error')(sanitizeUntrustedText(error))
                : style('muted')(
                    sanitizeUntrustedText(
                      notice ||
                        (screen.kind === 'detail'
                          ? `${shownOffset + 1}-${Math.min(shownOffset + bodyHeight, body.length)} / ${body.length} rows`
                          : unreadable > 0
                            ? `${unreadable} unreadable task record${unreadable === 1 ? '' : 's'} skipped · coral jobs list names them`
                            : 'FIFO queue · one active worker · manual worktree review')
                    )
                  ),
            width
          ),
          style('muted')(truncateLine(hint, width)),
          style('muted')(
            truncateLine(
              busy
                ? 'esc closes the viewer; accepted background work keeps running'
                : 'Task controls do not change the current chat session.',
              width
            )
          ),
        ]}
      />
    </Box>
  )
}
