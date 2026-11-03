import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreSource } from '../server/core/source.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'
import type { Grant } from '../server/core/mailbox.ts'
import { runChild } from './child.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 'Core test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Core test', GIT_COMMITTER_EMAIL: 'test@localhost' }

/** A folder of repos on real git: a (committed, on trunk), b (no commit yet), c (no repo), and a repo outside it. */
async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'shep-repos-space-')), f = await setup(root)
  try { await work(f) } finally { f.source.stop(); await f.source.pilots.lifecycle.drain(); f.source.mailbox.close(); f.source.store.close(); rmSync(root, { recursive: true, force: true }) }
}
async function setup(root: string) {
  const work = join(root, 'work'), outside = join(root, 'outside')
  for (const [repo, commit] of [[join(work, 'a'), true], [join(work, 'b'), false], [outside, true]] as const) {
    await runChild(['git', 'init', '--initial-branch=trunk', repo], { env })
    if (commit) await runChild(['git', 'commit', '--allow-empty', '-m', 'first'], { cwd: repo, env })
  }
  mkdirSync(join(work, 'c')); writeFileSync(join(work, 'c', 'notes.txt'), 'plain\n')
  const source = new CoreSource({ home: join(root, 'home'), socket: '/unused', session: 'test', binary: 'hc', port: 0 }), machine = source.localMachineId()
  source.core.current.connected = true; source.machineConnected = () => true
  source.files.exec = async (_machine, argv, cwd) => runChild(argv, { cwd, env })
  source.folders = async (_machine, path) => {
    const repo = await runChild(['git', 'rev-parse', '--show-toplevel'], { cwd: path, env }).then(out => out.toString().trim(), () => null)
    return { path, exists: true, dir: !path.endsWith('.txt'), repo, entries: [] }
  }
  source.agents.worktreeRoot = async () => join(root, 'worktrees')
  const started: { repo: string; folder: string; base: string }[] = []
  source.tasks.git.addWorktree = async (repo, folder, _branch, base) => { started.push({ repo: repo.folder, folder, base }); throw Error('Stopped before the agent') }
  const coordinator: CoreAgent = { chat: `p:${machine}:~`, space: `p:${machine}:~`, machine, role: 'coordinator', kind: 'claude', launch: 'launch', grant: 'grant', hook: '/unused', started: 1, state: 'idle', pid: 41 }
  return { source, machine, root, work, outside, started, coordinator }
}

test('a repos space is any folder in the home, saved without a base, and never the same folder as a repo space', () => fixture(async f => {
  const place = (await f.source.addSpace({ machine: f.machine, path: f.work, repos: true })).place
  expect(f.source.space(place)).toMatchObject({ name: 'work', folder: realpathSync(f.work), repos: true, base: '' })
  expect(await f.source.addSpace({ machine: f.machine, path: f.work, repos: true })).toEqual({ place })
  // a repo inside it can be a space of its own
  const nested = f.source.space((await f.source.addSpace({ machine: f.machine, path: join(f.work, 'a') })).place)!
  expect(nested.base).toBe('trunk'); expect(nested.repos).toBeUndefined()
  await expect(f.source.addSpace({ machine: f.machine, path: join(f.work, 'a'), repos: true })).rejects.toThrow('a repository space already')
  await f.source.addSpace({ machine: f.machine, path: f.outside, repos: true })
  await expect(f.source.addSpace({ machine: f.machine, path: f.outside })).rejects.toThrow('a repos space already')
  await expect(f.source.addSpace({ machine: f.machine, path: f.work })).rejects.toThrow('Choose a git repository')
  await expect(f.source.addSpace({ machine: f.machine, path: join(f.work, 'c', 'notes.txt'), repos: true })).rejects.toThrow('existing folder')
  await expect(f.source.addSpace({ machine: f.machine, path: homedir(), repos: true })).rejects.toThrow('home space')
}))

test('space add --repos from a coordinator', () => fixture(async f => {
  const place = await f.source.places.cli(f.coordinator, ['space', 'add', '--repos', f.work, '--name', 'many'])
  expect(f.source.space(place)).toMatchObject({ name: 'many', repos: true })
  await expect(f.source.places.cli(f.coordinator, ['space', 'add', f.work, '--force'])).rejects.toThrow('--repos')
}))

test('a repos space task names a committed repo inside it and starts from that repo', () => fixture(async f => {
  const space = f.source.space((await f.source.addSpace({ machine: f.machine, path: f.work, repos: true })).place)!
  const add = (repo?: string, base?: string) => f.source.tasks.addInSpace(space, { title: 'Fix it', brief: 'Full brief', repo, base })
  await expect(add()).rejects.toThrow('--repo PATH')
  await expect(add('c')).rejects.toThrow('not a git repository')
  await expect(add('missing')).rejects.toThrow('not a git repository')
  await expect(add('b')).rejects.toThrow('first commit')
  await expect(add('../outside')).rejects.toThrow('not a repository inside')
  await expect(add(f.outside)).rejects.toThrow('not a repository inside')
  expect(f.source.tasks.all()).toHaveLength(0)
  await expect(add('a')).rejects.toThrow('could not start: Stopped before the agent')
  const repo = realpathSync(join(f.work, 'a')), task = f.source.tasks.all()[0]!
  expect(task).toMatchObject({ repo, base: 'trunk' })
  expect(task.folder).toBe(join(f.root, 'worktrees', 'work', `a-${task.branch.replaceAll('/', '-')}`))
  expect(f.started).toEqual([{ repo, folder: task.folder, base: 'trunk' }])
  await expect(add(join(repo, '.'), 'next')).rejects.toThrow('could not start')
  expect(f.started[1]).toMatchObject({ repo, base: 'next' })
}))

test('--repo is refused in a repository space, through the task add command too', () => fixture(async f => {
  const space = f.source.space((await f.source.addSpace({ machine: f.machine, path: join(f.work, 'a') })).place)!
  await expect(f.source.tasks.addInSpace(space, { title: 'Fix it', brief: 'Full brief', repo: 'a' })).rejects.toThrow('only for a repos space')
  const agent = { ...f.coordinator, chat: space.id, space: space.id }
  f.source.store.set('agent', agent.chat, agent)
  const grant = { chat: agent.chat, session: agent.launch, id: agent.grant, machine: agent.machine } as Grant
  await expect(f.source.tasks.cli(grant, ['task', 'add', 'Fix it', '--brief', 'Full brief', '--repo', 'a'])).rejects.toThrow('only for a repos space')
}))

test('a repos space has no base branch, Repository settings, Autopilot or automations; its task ids still work', () => fixture(async f => {
  const space: CoreSpace = f.source.space((await f.source.addSpace({ machine: f.machine, path: f.work, repos: true })).place)!
  await expect(f.source.places.setBase(space.id, 'trunk')).rejects.toThrow('no single base branch')
  await expect(f.source.act({ type: 'setting', place: space.id, key: 'space.base', value: 'trunk' })).rejects.toThrow('no single base branch')
  const pages = f.source.snapshot().settings!.filter(page => page.level === space.id)
  expect(pages.find(page => page.name === 'Repository')).toBeUndefined()
  expect(pages.find(page => page.name === 'Task IDs')).toBeDefined()
  expect(f.source.settings.pilotBlock(space.id)).toContain('repos space')
  expect(() => f.source.pilots.lifecycle.start(space.id, { harness: { kind: 'claude' }, reviewer: { kind: 'codex' }, hosts: [], secrets: [], approvals: [], parallel: 1 })).toThrow('repos spaces')
  await expect(f.source.automations.cli(f.coordinator, ['automation', 'add', 'Nightly', '--space', space.name, '--task', 'Later', '--on', 'ready'])).rejects.toThrow('repos space')
}))
