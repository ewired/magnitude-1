/** Thinking lens definition for protocol prompt construction. */
export interface ThinkingLens {
  readonly name: string
  readonly trigger: string
  readonly description: string
}

// Protocol constants — inlined from xml-act to eliminate the live dependency.
const P = 'magnitude:'
const YIELD_USER     = '<' + P + 'yield_user/>'
const YIELD_INVOKE   = '<' + P + 'yield_invoke/>'
const YIELD_WORKER   = '<' + P + 'yield_worker/>'
const YIELD_PARENT   = '<' + P + 'yield_parent/>'
const LEAD_YIELD_TAGS    = [P + 'yield_user', P + 'yield_invoke', P + 'yield_worker'] as const
const WORKER_YIELD_TAGS = [P + 'yield_parent', P + 'yield_invoke'] as const
const TAG_THINK     = P + 'think'
const TAG_MESSAGE   = P + 'message'
const TAG_INVOKE    = P + 'invoke'
const TAG_PARAMETER = P + 'parameter'
import protocolRaw from './protocol/xml-act-protocol.txt'
import turnControlLeadRaw from './protocol/turn-control-lead.txt'
import turnControlSubagentRaw from './protocol/turn-control-subagent.txt'
import taskRoutingLeadRaw from './protocol/task-routing-lead.txt'
import taskRoutingWorkerRaw from './protocol/task-routing-worker.txt'

const PROTOCOL_RAW = protocolRaw
const TURN_CONTROL_LEAD_RAW = turnControlLeadRaw
const TURN_CONTROL_SUBAGENT_RAW = turnControlSubagentRaw
const TASK_ROUTING_LEAD_RAW = taskRoutingLeadRaw
const TASK_ROUTING_WORKER_RAW = taskRoutingWorkerRaw

function renderThinkingLenses(lenses: ThinkingLens[]): string {
  return lenses.map((lens) => `#### ${lens.name}
> When to use: ${lens.trigger}

${lens.description}`).join('\n\n')
}

function renderLensesExample(lenses: ThinkingLens[]): string {
  return lenses
    .map((lens) => `<magnitude:think about="${lens.name}">...${lens.name} thinking if relevant</magnitude:think>`)
    .join('\n')
}

/**
 * Generate the protocol prompt for an agent.
 */
export function getProtocol(
  lenses: ThinkingLens[],
  role: 'lead' | 'worker' = 'lead',
  defaultRecipient: 'user' | 'parent' = 'user',
): string {
  const turnControlSection = role === 'worker'
    ? TURN_CONTROL_SUBAGENT_RAW
    : TURN_CONTROL_LEAD_RAW
  const taskAndRoutingSection = role === 'worker'
    ? TASK_ROUTING_WORKER_RAW
    : TASK_ROUTING_LEAD_RAW

  const yieldTags = role === 'worker'
    ? WORKER_YIELD_TAGS
    : LEAD_YIELD_TAGS
  const yieldOptions = yieldTags.map(t => `<${t}/>`).join(' | ')

  return PROTOCOL_RAW
    .replaceAll('{{TAG_THINK}}', 'magnitude:think')
    .replaceAll('{{TAG_MESSAGE}}', 'magnitude:message')
    .replaceAll('{{TAG_INVOKE}}', 'magnitude:invoke')
    .replaceAll('{{TAG_PARAMETER}}', 'magnitude:parameter')
    .replaceAll('{{TAG_FILTER}}', 'magnitude:filter')
    .replaceAll('{{YIELD_OPTIONS}}', yieldOptions)
    .replaceAll('{{TURN_CONTROL_SECTION}}', turnControlSection)
    .replaceAll('{{TASK_AND_ROUTING_SECTION}}', taskAndRoutingSection)
    .replaceAll('{{LENSES_EXAMPLE}}', renderLensesExample(lenses))
    .replaceAll('{{THINKING_LENSES}}', renderThinkingLenses(lenses))
    .replaceAll('{{DEFAULT_RECIPIENT}}', defaultRecipient)
    .replaceAll('{{YIELD_USER}}', YIELD_USER)
    .replaceAll('{{YIELD_INVOKE}}', YIELD_INVOKE)
    .replaceAll('{{YIELD_WORKER}}', YIELD_WORKER)
    .replaceAll('{{YIELD_PARENT}}', YIELD_PARENT)
}

export interface AckTurnMessage {
  role: 'user' | 'assistant'
  content: string[]
}
