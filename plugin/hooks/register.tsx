import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Seat, Seats } from '../types'

const PANE = 'ccseats'
const BAR = 16
const TRACK = 0x2a2a36
const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']

const seats = atom({ plugin: 'ccseats', key: 'seats' } as const, {
  list: [],
  thresholds: { session: 90, weekly: 90, model: 85 },
  model: 'Fable',
} as Seats)
const isDismissed = atom({ plugin: 'ccseats', key: 'isDismissed' } as const, false)

type Limit = { kind: string; percent: number; resets_at: string | null; scope: { model?: { display_name?: string } } | null }

const epoch = (iso: string | null) => (iso ? Date.parse(iso) / 1000 : null)

// Mirrors ccseats usage_fields: a window whose reset has passed counts as empty.
function usage(limit: Limit | undefined, now: number) {
  if (!limit) return { used: null, reset: null }
  const reset = epoch(limit.resets_at)
  if (reset !== null && reset < now) return { used: 0, reset: null }
  return { used: limit.percent, reset }
}

function overThreshold(seat: Seat, t: Seats['thresholds']) {
  return (seat.session ?? 0) >= t.session || (seat.weekly ?? 0) >= t.weekly || (seat.model ?? 0) >= t.model
}

// Mirrors the ccseats picker: weekly headroom per day left until the weekly reset, measured to the
// tighter of the week (or maxWeekly) and the model bucket.
function roomPerDay(seat: Seat, t: Seats['thresholds'], now: number) {
  const cap = seat.maxWeekly !== null && seat.maxWeekly < t.weekly ? seat.maxWeekly : t.weekly
  const room = Math.min(cap - (seat.weekly ?? 0), t.model - (seat.model ?? 0))
  const days = seat.resetWeekly === null ? 7 : (seat.resetWeekly - now) / 86400
  return room / Math.max(days, 1 / 1440)
}

// Same order as the ccseats picker: most headroom per day, then 5h.
function pickTarget({ list, thresholds }: Seats, now: number) {
  return list
    .filter(s => !s.isCurrent && !s.locked && s.session !== null && !overThreshold(s, thresholds))
    .filter(s => s.maxWeekly === null || (s.weekly ?? 0) < s.maxWeekly)
    .sort((a, b) => roomPerDay(b, thresholds, now) - roomPerDay(a, thresholds, now) || (a.session ?? 0) - (b.session ?? 0))[0]
}

function usedColor(used: number) {
  return used < 50 ? 0x22c55e : used < 80 ? 0xeab308 : 0xef4444
}

// Each filled cell takes the colour its own position would have, so a bar shades green to red.
// Eighth blocks on a track background give the bar sub-cell precision.
function barCells(used: number | null) {
  const eighths = Math.round(((used ?? 0) / 100) * BAR * 8)
  const words: number[] = []
  for (let i = 0; i < BAR; i++) {
    const left = eighths - i * 8
    const char = left >= 8 ? '█' : left > 0 ? EIGHTHS[left - 1]! : ' '
    words.push(char.codePointAt(0)!, usedColor(((i + 1) / BAR) * 100), TRACK)
  }
  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

function textBar(used: number | null) {
  const eighths = Math.round(((used ?? 0) / 100) * BAR * 8)
  const tail = eighths % 8 ? EIGHTHS[(eighths % 8) - 1] : ''
  return ('█'.repeat(Math.floor(eighths / 8)) + tail).padEnd(BAR, ' ')
}

function until(reset: number | null, now: number) {
  if (reset === null) return ''
  const mins = Math.max(0, Math.round((reset - now) / 60))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
}

const pct = (n: number | null) => (n === null ? '   -' : `${String(Math.round(n)).padStart(3)}%`)
const pctColor = (n: number | null) => (!n ? undefined : n < 50 ? 'green' : n < 80 ? 'yellow' : 'red')

async function load($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const expand = (p: string) => p.replace(/^~/, home).replace(/\/$/, '')
  const configHome = (await $.env.get('XDG_CONFIG_HOME')) || `${home}/.config`
  const configPath = (await $.env.get('CCSEATS_CONFIG')) || `${configHome}/ccseats/config.json`
  // Before `ccseats init` there is no config; the meters stay empty and the timer retries.
  const text = await $.fs.read(configPath).catch(() => null)
  if (typeof text !== 'string') return
  const config = JSON.parse(text)
  const model: string = config.model ?? 'Fable'
  const now = (await $.clock.now()) / 1000
  const list: Seat[] = []
  for (const [name, seat] of Object.entries<{ dir: string; maxWeekly?: number }>(config.seats)) {
    const dir = expand(seat.dir)
    let cache: { limits?: Limit[]; five_hour?: { locked_reason: string | null }; seven_day?: { locked_reason: string | null } } = {}
    try {
      cache = JSON.parse(await $.fs.read(`${dir}/usage-cache.json`))
    } catch {}
    const limits = cache.limits ?? []
    const session = usage(limits.find(l => l.kind === 'session'), now)
    const weekly = usage(limits.find(l => l.kind === 'weekly_all'), now)
    const scoped = usage(limits.find(l => l.kind === 'weekly_scoped' && l.scope?.model?.display_name === model), now)
    list.push({
      name,
      dir,
      maxWeekly: seat.maxWeekly ?? null,
      session: session.used,
      weekly: weekly.used,
      model: scoped.used,
      resetSession: session.reset,
      resetWeekly: weekly.reset,
      locked: Boolean(cache.five_hour?.locked_reason || cache.seven_day?.locked_reason),
      isCurrent: dir === expand(configDir),
    })
  }
  const thresholds = { session: 90, weekly: 90, model: 85, ...config.thresholds }
  await update($, seats, () => ({ list, thresholds, model }))
  // A dismissal lasts for one low spell: once this seat is back under every threshold, the band may show again.
  const current = list.find(s => s.isCurrent)
  if (current && !overThreshold(current, thresholds)) {
    await update($, isDismissed, () => false)
  }
}

const AGENTS = [
  { name: 'codex', hotkey: 'c' },
  { name: 'grok', hotkey: 'g' },
] as const

const BRIEF_PROMPT = `Write a handoff brief for another coding agent that takes over this work in the same directory. It cannot see this conversation. Cover: the goal, what is done, the files touched (paths), decisions and constraints the user set, open problems, and the exact next steps. Markdown. Output only the brief.`

// Opens a tab in the first terminal multiplexer this session runs inside. WezTerm and kitty run the
// command in a login shell so ~/.local/bin, where ccseats installs, is on PATH.
async function openTab($: EngineInterface, label: string, command: string) {
  const cwd = await $.session.cwd()
  const shell = (await $.env.get('SHELL')) ?? 'sh'
  const workspace = await $.env.get('HERDR_WORKSPACE_ID')
  if (workspace) {
    const created = await $.process.run(['herdr', 'tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--focus'])
    const pane = JSON.parse(created.stdout).result.root_pane.pane_id
    return (await $.process.run(['herdr', 'pane', 'run', pane, command])).exitCode === 0
  }
  if (await $.env.get('TMUX')) {
    return (await $.process.run(['tmux', 'new-window', '-c', cwd, '-n', label, command])).exitCode === 0
  }
  if (await $.env.get('WEZTERM_PANE')) {
    return (await $.process.run(['wezterm', 'cli', 'spawn', '--cwd', cwd, '--', shell, '-lc', command])).exitCode === 0
  }
  // kitty refuses unless the user's kitty.conf sets allow_remote_control; a refusal falls through to the clipboard.
  if (await $.env.get('KITTY_WINDOW_ID')) {
    return (await $.process.run(['kitty', '@', 'launch', '--type=tab', `--cwd=${cwd}`, `--tab-title=${label}`, shell, '-lc', command])).exitCode === 0
  }
  return false
}

const CLIPBOARDS = [['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]

// Quotes one argument for the shell the terminal runs the command in; plain words stay bare so the command reads cleanly.
const shq = (arg: string) => (/^[\w./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)

async function launch($: EngineInterface, label: string, command: string) {
  // A multiplexer CLI missing from PATH, or a herdr error, falls through to the clipboard too.
  if (await openTab($, label, command).catch(() => false)) {
    $.ui.toast(`Handed off to ${label} in a new tab. Exit this one when ready.`)
    return
  }
  for (const argv of CLIPBOARDS) {
    try {
      if ((await $.process.run(argv, { stdin: command })).exitCode === 0) {
        $.ui.toast(`Copied: ${command}`)
        return
      }
    } catch {}
  }
  // A toast fades, so the command goes in the transcript on a line of its own for a clean copy.
  $.ui.log('ccseats: no clipboard tool found. Run this in a new terminal:')
  $.ui.log(command)
  $.ui.toast('Handoff command is in the transcript')
}

// Resumes this conversation on another seat. The seats share projects/, so the transcript is
// there; --fork-session gives the new seat its own session id so two processes never write one file.
async function handoff($: EngineInterface, seat: Seat) {
  await $.ui.close({ id: PANE })
  await update($, isDismissed, () => true)
  await launch($, seat.name, `ccseats ${shq(seat.name)} --resume ${shq(await $.session.id())} --fork-session`)
}

// Other CLIs cannot read a Claude transcript, so the model writes a brief over its own cached
// transcript. The brief lives outside the repo so the handoff leaves git status clean.
async function handoffAgent($: EngineInterface, agent: string) {
  // Pane closed and band dismissed before the brief is written, so a second press cannot start a second brief.
  await $.ui.close({ id: PANE })
  await update($, isDismissed, () => true)
  $.ui.toast(`Writing the handoff brief for ${agent}…`)
  const brief = await $.model.fork({ prompt: BRIEF_PROMPT })
  if (!brief.isAnswered) {
    $.ui.toast(`No brief: ${brief.reason}`)
    return
  }
  const path = `${await $.env.get('HOME')}/.cache/ccseats/handoffs/${await $.session.id()}.md`
  await $.fs.write(path, brief.text)
  await launch($, agent, `${agent} ${shq(`Read ${path} and continue the work it describes.`)}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'seats', description: 'Usage meters for every ccseats seat, with handoff' })
    // Reads local cache files only; the ccseats statusline already refreshes them from the API.
    $.clock.every(30_000, () => load($))
    await load($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await load($)
    return next(e)
  })

  on('command.run', { command: 'seats' }, async $ => {
    await load($)
    await $.ui.open({ id: PANE, title: 'Seats', focus: true, closeOnEscape: true, columns: 44 })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const state = await read($, seats)
    const now = (await $.clock.now()) / 1000
    const target = pickTarget(state, now)

    const label = state.model.toLowerCase()
    const meter = (seat: Seat, name: string, used: number | null, reset: number | null) => (
      <Box flexDirection="row" columnGap={1} paddingLeft={2}>
        <Text dimColor>{name.padEnd(5)}</Text>
        {'Raster' in ui ? (
          <ui.Raster key={`${seat.name}-${name}`} columns={BAR} rows={1} cells={barCells(used)} />
        ) : (
          <Text color={pctColor(used)}>{textBar(used)}</Text>
        )}
        <Text color={pctColor(used)} dimColor={!used}>
          {pct(used)}
        </Text>
        <Text dimColor>{until(reset, now)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1} paddingLeft={1} paddingTop={1}>
        {state.list.map((seat, i) => (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text bold color={seat.isCurrent ? 'magenta' : undefined}>
                {seat.isCurrent ? '●' : '○'} {seat.name}
              </Text>
              {seat.locked && <Text color="red">locked</Text>}
              {seat === target && <Text color="cyan">★</Text>}
              {seat.isCurrent && <Text dimColor>this session</Text>}
              {!seat.isCurrent && !seat.locked && (
                <Button key={`go-${seat.name}`} label="hand off" hotkey={i < 9 ? String(i + 1) : undefined} plain onPress={() => handoff($, seat)} />
              )}
            </Box>
            {meter(seat, '5h', seat.session, seat.resetSession)}
            {meter(seat, '7d', seat.weekly, seat.resetWeekly)}
            {seat.model !== null && meter(seat, label, seat.model, null)}
          </Box>
        ))}
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>elsewhere</Text>
          {AGENTS.map(a => (
            <Button key={`agent-${a.name}`} label={a.name} hotkey={a.hotkey} plain onPress={() => handoffAgent($, a.name)} />
          ))}
        </Box>
        <Button key="close" label="close" hotkey="q" plain onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
  })

  // Shows only while this seat is over a picker threshold. With every seat low, only the other agents are offered.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, seats)
    const current = state.list.find(s => s.isCurrent)
    const target = pickTarget(state, (await $.clock.now()) / 1000)
    const label = state.model.toLowerCase()
    if (!current || !overThreshold(current, state.thresholds) || (await read($, isDismissed))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={2}>
        <Text color="yellow">
          {current.name} is low: 5h {pct(current.session).trim()}, 7d {pct(current.weekly).trim()}
          {current.model !== null ? `, ${label} ${pct(current.model).trim()}` : ''} used.
          {target ? ` ${target.name} has 5h ${pct(target.session).trim()}, 7d ${pct(target.weekly).trim()}.` : ' No seat has room.'}
        </Text>
        {target && <Button key="handoff" label={`hand off to ${target.name}`} plain onPress={() => handoff($, target)} />}
        {AGENTS.map(a => (
          <Button key={`agent-${a.name}`} label={a.name} hotkey={a.hotkey} plain onPress={() => handoffAgent($, a.name)} />
        ))}
        <Button key="dismiss" label="dismiss" hotkey="x" plain onPress={() => update($, isDismissed, () => true)} />
      </Box>
    )
  })
}
