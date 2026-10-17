import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
}

const NOW = Date.parse('2026-10-03T03:00:00Z')

const cache = (session: number, weekly: number, weeklyReset = '2026-10-09T08:00:00Z') =>
  JSON.stringify({
    limits: [
      { kind: 'session', percent: session, resets_at: '2026-10-03T05:00:00Z', scope: null },
      { kind: 'weekly_all', percent: weekly, resets_at: weeklyReset, scope: null },
    ],
  })

const files = (p1: number, p2: number, p3: number): Record<string, string> => ({
  '/h/.config/ccseats/config.json': JSON.stringify({
    seats: { p1: { dir: '~/.claude' }, p2: { dir: '~/.claude-p2' }, p3: { dir: '~/.claude-p3', maxWeekly: 10 } },
    thresholds: { session: 90, weekly: 90, model: 85 },
  }),
  '/h/.claude/usage-cache.json': cache(p1, 40),
  '/h/.claude-p2/usage-cache.json': cache(p2, 60),
  '/h/.claude-p3/usage-cache.json': cache(p3, 5),
})

// `exits` sets a command's exit code by executable; 'missing' makes it fail to start.
function world(
  on: On,
  fs: Record<string, string>,
  env: Record<string, string> = { HERDR_WORKSPACE_ID: 'w3' },
  exits: Record<string, number | 'missing'> = {},
) {
  const runs: string[][] = []
  const toasts: string[] = []
  const logs: string[] = []
  const stdins: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/h', ...env })
  on('fs.read', async (_, e) => {
    const text = fs[e.path]
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_, e) => {
    fs[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.render', async () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.close', async (_, e) => {
    runs.push(['ui.close', e.id])
    return { value: undefined }
  })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    const exit = exits[e.argv[0]!] ?? 0
    if (exit === 'missing') throw new Error(`${e.argv[0]}: not found`)
    if (e.init?.stdin !== undefined) stdins.push(e.init.stdin)
    const stdout = JSON.stringify({ result: { root_pane: { pane_id: 'w3:p9' } } })
    return { value: { exitCode: exit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, toasts, stdins, logs, clock }
}

test('a low seat offers handoff to the best seat and resumes there in a new herdr tab', async ($, on) => {
  const { runs } = world(on, files(95, 10, 0))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ccseats', surface, component: 'AbovePrompt', props: BAND })
    // p2 beats p3, though p3 has used less of its week: p3 is near its maxWeekly.
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /p1 is low.*p2 has/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'handoff' })
  expect(runs).toEqual([
    ['ui.close', 'ccseats'],
    ['herdr', 'tab', 'create', '--workspace', 'w3', '--cwd', '/work', '--label', 'p2', '--focus'],
    ['herdr', 'pane', 'run', 'w3:p9', 'ccseats p2 --resume sess-1 --fork-session'],
  ])
})

test('a seat whose week resets sooner wins, though it has used more of its week', async ($, on) => {
  const fs = files(95, 10, 0)
  fs['/h/.config/ccseats/config.json'] = JSON.stringify({ seats: { p1: { dir: '~/.claude' }, p2: { dir: '~/.claude-p2' }, p3: { dir: '~/.claude-p3' } } })
  fs['/h/.claude-p2/usage-cache.json'] = cache(10, 20)
  fs['/h/.claude-p3/usage-cache.json'] = cache(0, 70, '2026-10-04T03:00:00Z')
  world(on, fs)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // p3: 20% left over 1 day. p2: 70% left over about 6 days.
  expect(await ui.find({ type: 'Text', text: /p1 is low.*p3 has/ })).toBeDefined()
})

test('with every seat low, codex gets a brief written over the transcript', async ($, on) => {
  const fs = files(95, 95, 95)
  const { runs } = world(on, fs)
  const prompts: string[] = []
  on('model.fork', async (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: '# Brief', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  await ui.press({ key: 'agent-codex' })
  expect(prompts.length).toBe(1)
  expect(fs['/h/.cache/ccseats/handoffs/sess-1.md']).toBe('# Brief')
  expect(runs.at(-1)).toEqual(['herdr', 'pane', 'run', 'w3:p9', "codex 'Read /h/.cache/ccseats/handoffs/sess-1.md and continue the work it describes.'"])
})

test('inside tmux the seat handoff opens a tmux window', async ($, on) => {
  const { runs } = world(on, files(95, 10, 0), { TMUX: '/tmp/tmux-501/default,1,0' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'handoff' })
  expect(runs).toEqual([['ui.close', 'ccseats'], ['tmux', 'new-window', '-c', '/work', '-n', 'p2', 'ccseats p2 --resume sess-1 --fork-session']])
})

test('with no known terminal the command goes to the clipboard', async ($, on) => {
  const { runs, toasts, stdins } = world(on, files(95, 10, 0), {})
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'handoff' })
  expect(runs).toEqual([['ui.close', 'ccseats'], ['pbcopy']])
  expect(stdins).toEqual(['ccseats p2 --resume sess-1 --fork-session'])
  expect(toasts).toEqual(['Copied: ccseats p2 --resume sess-1 --fork-session'])
})

const COMMAND = 'ccseats p2 --resume sess-1 --fork-session'

async function pressHandoff($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'handoff' })
}

test('on Linux the clipboard falls back to wl-copy, then xclip', async ($, on) => {
  const { runs, toasts, stdins } = world(on, files(95, 10, 0), {}, { pbcopy: 'missing', 'wl-copy': 1 })
  await pressHandoff($)
  expect(runs.slice(1)).toEqual([['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard']])
  expect(stdins).toEqual([COMMAND, COMMAND])
  expect(toasts).toEqual([`Copied: ${COMMAND}`])
})

test('a terminal that refuses the tab falls back to the clipboard', async ($, on) => {
  const { runs, toasts } = world(on, files(95, 10, 0), { KITTY_WINDOW_ID: '1' }, { kitty: 1 })
  await pressHandoff($)
  expect(runs.slice(1).map(r => r[0])).toEqual(['kitty', 'pbcopy'])
  expect(toasts).toEqual([`Copied: ${COMMAND}`])
})

test('with no clipboard tool the command stays in the transcript to copy by hand', async ($, on) => {
  const { toasts, logs } = world(on, files(95, 10, 0), {}, { pbcopy: 'missing', 'wl-copy': 'missing', xclip: 'missing' })
  await pressHandoff($)
  // The command sits alone on its last line, so selecting that line copies it whole.
  expect(logs.at(-1)).toBe(COMMAND)
  expect(toasts).toEqual(['Handoff command is in the transcript'])
})

test('a home path with a quote still yields one valid shell argument', async ($, on) => {
  const fs = files(95, 95, 95)
  for (const [path, text] of Object.entries(fs)) fs[path.replace('/h/', "/o'b/")] = text
  const { runs } = world(on, fs, { HERDR_WORKSPACE_ID: 'w3', HOME: "/o'b" })
  on('model.fork', async () => ({
    value: { isAnswered: true, text: '# Brief', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'agent-codex' })
  expect(runs.at(-1)?.at(-1)).toBe(`codex 'Read /o'\\''b/.cache/ccseats/handoffs/sess-1.md and continue the work it describes.'`)
})

test('without a ccseats config the session starts, and the timer picks the config up once it exists', async ($, on) => {
  const fs: Record<string, string> = {}
  const { clock } = world(on, fs)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const quiet = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await quiet.find({ key: 'dismiss' })).toBeUndefined()
  await quiet.unmount()

  Object.assign(fs, files(95, 10, 0))
  await clock.advance(30_000)
  const ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
})

test('a dismissed band shows again after the seat recovers and runs low once more', async ($, on) => {
  const fs = files(95, 10, 0)
  const { clock } = world(on, fs)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'dismiss' })
  await ui.unmount()

  const recheck = async (p1: number) => {
    fs['/h/.claude/usage-cache.json'] = cache(p1, 40)
    await clock.advance(30_000)
  }
  await recheck(95)
  const quiet = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await quiet.find({ key: 'dismiss' })).toBeUndefined()
  await quiet.unmount()
  await recheck(20)
  await recheck(95)
  ui = await $.ui.mount({ plugin: 'ccseats', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
})

test('q closes the seats pane on every surface', async ($, on) => {
  const { runs } = world(on, files(10, 10, 0))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ccseats',
      surface,
      component: 'Pane',
      requestId: 'ccseats',
      props: { title: 'Seats', isFocused: true, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(runs).toEqual([['ui.close', 'ccseats'], ['ui.close', 'ccseats']])
})
