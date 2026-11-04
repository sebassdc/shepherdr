import { Refusal } from './client.ts'
import { randomUUID } from 'node:crypto'
import type { Action, Message, Question } from '../../shared/types.ts'
import { askText, quickChoices } from '../../shared/alerts.ts'
import { one, parseArgs } from '../common/args.ts'
import { tag } from '../common/chatlines.ts'
import type { Grant } from './mailbox.ts'
import type { CoreSource } from './source.ts'

interface SavedQuestion { id: string; chat: string; grant: string; question: Question; answered: boolean }
export class CoreQuestions {
  constructor(private readonly source: CoreSource) {}
  open(chat?: string) { return this.source.store.all<SavedQuestion>('question').filter(row => !row.answered && (!chat || row.chat === chat) && this.source.agents.get(row.chat)?.grant === row.grant) }
  reconcile(chat: string) {
    for (const row of this.source.store.all<SavedQuestion>('question')) {
      if (row.chat !== chat || row.answered) continue
      const replaced = this.source.agents.get(chat)?.grant !== row.grant, done = this.source.tasks.finished(chat)
      if (!replaced && !done) continue
      this.close(row, replaced ? 'Session replaced; ask the agent for a fresh card' : 'The task is done', replaced ? 'Session replaced' : 'No longer waiting')
    }
  }
  private close(row: SavedQuestion, said: string, outcome: string) {
    row.answered = true; row.question.sent = -1; row.question.said = said; row.question.closed = said
    this.source.store.set('question', row.id, row)
    this.source.post(row.chat, { id: row.id, who: 'agent', question: row.question, at: Date.now() })
    this.source.forwardQuestion(row.chat, row.question, said, outcome)
    this.source.clearAlert(row.chat, said)
  }
  /** ask and plan, or ask withdraw [TASK|CARD] [--why TEXT]: close open ask and plan cards nobody needs answered any more. */
  cli(grant: Grant, args: string[]) {
    const p = parseArgs(args)
    if (p.words[1] !== 'withdraw' || p.opts.choice || p.opts.step || p.flags.has('other')) return `Asked: ${this.create(grant, args)}`
    return this.withdraw(grant, p.words[2], one(p, 'why'))
  }
  /** Only shepherdr ask and plan cards: a merge card, a permission or a secret box never goes this way. */
  private withdraw(grant: Grant, target?: string, why?: string) {
    const caller = this.source.agents.get(grant.chat)
    if (!caller || caller.grant !== grant.id || caller.role === 'reviewer') throw new Refusal('This session cannot withdraw cards')
    const card = target && this.source.store.get<SavedQuestion>('question', target)
    const chat = !target ? grant.chat : card ? card.chat : this.source.tasks.resolve(grant, target)?.chat
    if (!chat) throw new Refusal('No such task or card')
    const task = this.source.tasks.forChat(chat)
    const coordinator = caller.role === 'coordinator' && !!task && task.chat === chat && caller.space === task.place && caller.machine === task.machine
    if (chat !== grant.chat && !coordinator) throw new Refusal('Only the agent that asked, or its space coordinator, withdraws a card')
    const rows = this.open(chat).filter(row => !card || row.id === card.id)
    if (!rows.length) return card ? 'That card is not open' : 'No open card to withdraw'
    const said = why?.trim() || (chat === grant.chat ? 'Withdrawn: no longer needed' : 'Withdrawn by the coordinator')
    for (const row of rows) {
      this.close(row, said, 'Withdrawn')
      // the asking agent may be waiting for this answer: tell it the card is gone
      if (chat !== grant.chat) this.source.saveAndDeliver(chat, `withdrawn-${row.id}`, tag('withdrawn', { question: row.question.title }, said), () => {}, true)
    }
    this.source.emit('snapshot')
    return `Withdrew ${rows.length} card${rows.length > 1 ? 's' : ''}: ${rows.map(row => row.question.title).join('; ')}`
  }
  create(grant: Grant, args: string[]) {
    const agent = this.source.agents.get(grant.chat)
    if (!agent || agent.role === 'reviewer') throw new Refusal('This session cannot ask workflow questions')
    const p = parseArgs(args), plan = p.words[0] === 'plan'
    const choices = p.opts.choice ?? []
    const steps = p.opts.step ?? []
    if (!plan && !choices.length && !p.flags.has('other')) throw new Refusal('Give the question at least one --choice or --other')
    const question: Question = { id: randomUUID(), title: plan ? one(p, 'title') || 'Plan to approve' : p.words.slice(1).join(' '), kind: plan ? 'Plan' : 'Question',
      multi: p.flags.has('multi') || undefined, other: p.flags.has('other') || undefined,
      choices: plan ? [{ label: 'Approve the plan' }, { label: 'Send it back with a note' }] : choices.map(label => ({ label, description: p.opts.desc?.find(description => description.startsWith(label + '='))?.slice(label.length + 1) })),
      steps: plan ? steps : undefined, noteRequiredFor: plan ? 1 : undefined, to: grant.chat }
    if (!question.title.trim() || plan && !steps.length) throw new Refusal('Give the card its question or plan steps')
    this.source.store.set('question', question.id, { id: question.id, chat: grant.chat, grant: grant.id, question, answered: false } satisfies SavedQuestion)
    this.source.post(grant.chat, { id: question.id, who: 'agent', question, at: Date.now() })
    const task = this.source.tasks.forChat(grant.chat)
    if (plan && task) { task.plan = steps; this.source.store.set('task', task.id, task) }
    this.source.forwardQuestion(grant.chat, question)
    const words = askText(task?.id || this.source.space(agent.space)?.name || 'Shepherdr', question)
    this.source.emit('alert', { id: question.id, from: 'Shepherdr', ...words, go: { place: agent.space, task: task?.id, focus: question.id }, tag: task?.id || `ask:${agent.space}`,
      task: task ? true : undefined, card: { chat: grant.chat, question: question.id, choices: quickChoices(question) } })
    this.source.emit('snapshot')
    return question.id
  }
  async answer(action: Extract<Action, { type: 'answer' }>): Promise<boolean> {
    const row = this.source.store.get<SavedQuestion>('question', action.question)
    if (!row) return false
    if (row.answered || row.chat !== action.chat) throw new Refusal('This card has already been answered or belongs to another chat')
    if (this.source.agents.get(row.chat)?.grant !== row.grant) throw new Refusal('This card belongs to a replaced agent session; ask it for a fresh card')
    const selected = action.choices ?? [action.choice]
    const question = row.question
    if (!selected.length || selected.some(index => !Number.isInteger(index) || index < 0 || index >= question.choices.length) || !question.multi && selected.length !== 1) {
      if (!(question.other && action.other?.trim())) throw new Refusal('Choose one of the card’s answers')
    }
    if (question.noteRequiredFor !== undefined && selected.includes(question.noteRequiredFor) && !action.note?.trim()) throw new Refusal('Add the note this choice asks for')
    const words = action.other || [...selected.map(index => question.choices[index]?.label).filter(Boolean), action.note].filter(Boolean).join('\n')
    row.answered = true; question.sent = action.other ? -1 : selected[0]; question.said = words
    this.source.saveAndDeliver(row.chat, `answer-${row.id}`, tag('answer', { from: this.source.snapshot().user, question: question.title }, words), () => this.source.store.set('question', row.id, row))
    const message = this.source.store.get<Message>(`message:${row.chat}`, row.id)
    this.source.post(row.chat, { ...message, id: row.id, who: 'agent', question, at: message?.at ?? Date.now() })
    this.source.forwardQuestion(row.chat, question, words)
    return true
  }
}
