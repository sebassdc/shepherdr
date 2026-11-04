import { expect, test } from 'bun:test'
import { CoreGit, approvalGaps, githubRemote, type ApprovalRead } from '../server/core/git.ts'
import type { CoreFiles } from '../server/core/files.ts'

test('GitHub remote forms retain their explicit host including legacy enterprise and rewritten hosts', () => {
  for (const url of ['git@github.company.test:owner/repo.git', 'ssh://git@github.company.test:2222/owner/repo.git', 'https://github.company.test/owner/repo.git/']) expect(githubRemote(url)).toBe('github.company.test/owner/repo')
  expect(githubRemote('http://github.localhost/owner/repo.git')).toBe('github.localhost/owner/repo')
  expect(githubRemote('/tmp/local.git')).toBeUndefined()
  expect(githubRemote('https://gitlab.com/owner/repo')).toBeUndefined()
})

test('GitHub routing checks effective and written origin and refuses uncertain reads before local fallback', async () => {
  let used = 'git@ssh-alias:owner/repo.git', written = 'https://github.com/owner/repo.git', fail = false, origin = true
  const calls: string[][] = []
  const files = { exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'remote' && argv.length === 2) return Buffer.from(origin ? 'origin\n' : '')
    if (fail) throw Error('Core machine disconnected')
    if (argv[1] === 'remote') return Buffer.from(used)
    if (argv[1] === 'config') return Buffer.from(written)
    if (argv[0] === 'gh') return Buffer.from('{}')
    throw Error('Unexpected command')
  } } as unknown as CoreFiles
  const git = new CoreGit(files), repo = { machine: 'remote', folder: '/repo' }
  expect(await git.remote(repo)).toBe('github.com/owner/repo')
  used = 'http://github.localhost/owner/repo.git'
  expect(await git.remote(repo)).toBe('github.localhost/owner/repo')
  await git.pullRequest(repo, 'work/one')
  expect(calls.at(-1)).toContain('--repo')
  expect(calls.at(-1)).toContain('github.localhost/owner/repo')
  fail = true
  await expect(git.remote(repo)).rejects.toThrow('Core machine disconnected')
  fail = false; origin = false
  expect(await git.remote(repo)).toBeUndefined()
})

test('reopening a task checkout checks the saved branch/location and preserves occupied paths', async () => {
  let listing = 'worktree /tasks/one\nbranch refs/heads/work/one', branch = true
  const calls: string[][] = []
  const git = new CoreGit({ exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'worktree' && argv[2] === 'list') return Buffer.from(listing)
    if (argv[1] === 'symbolic-ref') return Buffer.from('refs/heads/work/one')
    if (argv[1] === 'for-each-ref') return Buffer.from(branch ? 'refs/heads/work/one ' + 'a'.repeat(40) : '')
    if (argv[1] === 'rev-parse') return Buffer.from('a'.repeat(40))
    if (argv[1] === 'worktree' && argv[2] === 'add') return Buffer.alloc(0)
    throw Error('Unexpected command')
  } } as unknown as CoreFiles)
  const repo = { machine: 'remote', folder: '/repo' }
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.some(args => args.includes('add'))).toBe(false)
  listing = 'worktree /tasks/one\nbranch refs/heads/other'
  await expect(git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')).rejects.toThrow('another branch')
  listing = 'worktree /tasks/elsewhere\nbranch refs/heads/work/one'
  await expect(git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')).rejects.toThrow('elsewhere')
  listing = ''
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.at(-1)).toEqual(['git', 'worktree', 'add', '/tasks/one', 'work/one'])
  branch = false
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.at(-1)).toEqual(['git', 'worktree', 'add', '-b', 'work/one', '/tasks/one', 'main'])
})

test('basic PR identity omits restricted checks and open lookup refuses ambiguous or failed snapshots', async () => {
  let rows: unknown = [], fail = false
  const calls: string[][] = [], git = new CoreGit({} as CoreFiles), repo = { machine: 'remote', folder: '/repo' }
  git.remote = async () => 'github.test/o/r'
  git.gh = async (_repo, args) => { calls.push(args); if (fail) throw Error('GitHub unavailable'); return (args[1] === 'list' ? rows : { number: 1 }) as never }
  await git.pullRequest(repo, 'work/one', false)
  expect(calls.at(-1)?.at(-1)).not.toContain('statusCheckRollup')
  await git.pullRequest(repo, 'work/one')
  expect(calls.at(-1)?.at(-1)).toContain('statusCheckRollup')
  expect(await git.findPullRequest(repo, 'work/one', 'main')).toBeUndefined()
  rows = [{ number: 1, headRefName: 'work/one', baseRefName: 'main' }, { number: 2, headRefName: 'work/one', baseRefName: 'main' }]
  await expect(git.findPullRequest(repo, 'work/one', 'main')).rejects.toThrow('unambiguous')
  fail = true
  await expect(git.findPullRequest(repo, 'work/one', 'main')).rejects.toThrow('GitHub unavailable')
})

test('a lost push reply only settles when the remote confirms the exact captured task commit', async () => {
  const sha = 'a'.repeat(40), ref = 'refs/heads/work/one', calls: string[][] = [], git = new CoreGit({} as CoreFiles)
  let confirmed = true
  git.run = async (_repo, args) => { calls.push(args); if (args[0] === 'symbolic-ref') return ref; if (args[0] === 'rev-parse') return sha; if (args[0] === 'push') throw Error('Reply lost'); if (args[0] === 'ls-remote') return `${confirmed ? sha : 'b'.repeat(40)}\t${ref}`; throw Error('Unexpected command') }
  expect(await git.pushTaskBranch({ machine: 'machine', folder: '/work' }, 'work/one', 'c'.repeat(40))).toBe(sha)
  expect(calls.find(args => args[0] === 'push')).toEqual(['push', '--force-with-lease=refs/heads/work/one:' + 'c'.repeat(40), 'origin', `${sha}:${ref}`])
  confirmed = false
  await expect(git.pushTaskBranch({ machine: 'machine', folder: '/work' }, 'work/one', 'c'.repeat(40))).rejects.toThrow('Reply lost')
})

test('a checkout switch cannot change the task ref whose captured commit is pushed', async () => {
  const saved = 'a'.repeat(40), other = 'b'.repeat(40), ref = 'refs/heads/work/one', git = new CoreGit({} as CoreFiles), pushes: string[][] = []
  git.run = async (_repo, args) => {
    if (args[0] === 'symbolic-ref') return ref // Immediately afterward another caller switches HEAD.
    if (args[0] === 'rev-parse') return args.at(-1) === ref + '^{commit}' ? saved : other
    if (args[0] === 'push') { pushes.push(args); return '' }
    throw Error('Unexpected command')
  }
  expect(await git.pushTaskBranch({ machine: 'machine', folder: '/work' }, 'work/one')).toBe(saved)
  expect(pushes[0]).toEqual(['push', `--force-with-lease=${ref}:`, 'origin', `${saved}:${ref}`])
})

test('a GitHub approval counts only on the exact head, by someone else, with green checks and no open thread', async () => {
  const head = 'a'.repeat(40), old = 'b'.repeat(40)
  const pr = (change: Partial<ApprovalRead> = {}): ApprovalRead => ({ state: 'OPEN', headRefOid: head, reviewDecision: 'APPROVED', author: { login: 'writer' },
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'ci', state: 'SUCCESS' }] } } } }] },
    reviews: { nodes: [{ state: 'APPROVED', author: { login: 'reviewer' }, commit: { oid: head } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }] }, ...change })
  expect(approvalGaps(pr(), head)).toEqual({ gaps: [], approvers: ['reviewer'] })
  expect(approvalGaps(pr({ reviews: { nodes: [{ state: 'APPROVED', author: { login: 'reviewer' }, commit: { oid: old } }] } }), head).gaps).toEqual(['no approval on this exact commit by anyone but its author'])
  expect(approvalGaps(pr({ reviews: { nodes: [{ state: 'DISMISSED', author: { login: 'reviewer' }, commit: { oid: head } }] } }), head).approvers).toEqual([])
  expect(approvalGaps(pr({ reviews: { nodes: [{ state: 'APPROVED', author: { login: 'writer' }, commit: { oid: head } }, { state: 'APPROVED', author: null, commit: { oid: head } }] } }), head).approvers).toEqual([])
  expect(approvalGaps(pr({ reviewDecision: null, reviews: { nodes: [{ state: 'APPROVED', author: { login: 'reviewer' }, commit: { oid: head } }, { state: 'CHANGES_REQUESTED', author: { login: 'reviewer' }, commit: { oid: head } }] } }), head).gaps)
    .toEqual(['no approval on this exact commit by anyone but its author', 'changes requested by reviewer'])
  expect(approvalGaps(pr({ reviewDecision: null, reviews: { nodes: [{ state: 'APPROVED', author: { login: 'reviewer' }, commit: { oid: head } }, { state: 'CHANGES_REQUESTED', author: { login: 'other' }, commit: { oid: old } }] } }), head).gaps)
    .toEqual(['changes requested by other'])
  expect(approvalGaps(pr({ reviews: { nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' }, commit: { oid: old } }, { state: 'COMMENTED', author: { login: 'reviewer' }, commit: { oid: head } }, { state: 'APPROVED', author: { login: 'reviewer' }, commit: { oid: head } }] } }), head))
    .toEqual({ gaps: [], approvers: ['reviewer'] })
  expect(approvalGaps(pr({ reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } }), head).gaps).toEqual(['1 unresolved review thread'])
  expect(approvalGaps(pr({ reviewDecision: 'CHANGES_REQUESTED' }), head).gaps).toEqual(["GitHub's review decision is changes requested"])
  const pending = pr(); pending.commits.nodes[0].commit.statusCheckRollup!.contexts.nodes[0] = { name: 'check', status: 'IN_PROGRESS', conclusion: null }
  expect(approvalGaps(pending, head).gaps).toEqual(['checks not green: check'])
  const none = pr(); none.commits.nodes[0].commit.statusCheckRollup = null
  expect(approvalGaps(none, head).gaps).toEqual(['no checks reported on it'])
  expect(approvalGaps(pr(), old).gaps).toContain('its head on GitHub is another commit')
  expect(approvalGaps(pr({ state: 'MERGED' }), head).gaps).toContain('the pull request is merged')
  expect(approvalGaps(null, head).gaps).toEqual(['GitHub found no such pull request'])
  const calls: string[][] = []
  const git = new CoreGit({ exec: async (_machine: string, argv: string[]) => { calls.push(argv); return Buffer.from(JSON.stringify({ data: { repository: { pullRequest: pr() } } })) } } as unknown as CoreFiles)
  expect(await git.approval({ machine: 'm', folder: '/repo' }, 'github.test/owner/repo', 12, head)).toEqual({ gaps: [], approvers: ['reviewer'] })
  expect(calls[0].slice(0, 5)).toEqual(['gh', 'api', 'graphql', '--hostname', 'github.test'])
  expect(calls[0]).toContain('o=owner'); expect(calls[0]).toContain('r=repo'); expect(calls[0]).toContain('n=12')
})
