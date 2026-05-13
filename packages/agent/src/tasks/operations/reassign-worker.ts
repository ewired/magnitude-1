import { Effect } from 'effect'
import { WorkerBusTag, type WorkerBusService } from '@magnitudedev/event-core'
import type { AppEvent } from '../../events'
import { AgentStateReaderTag } from '../../tools/fork'
import { TaskGraphStateReaderTag } from '../../tools/task-reader'
import { agentNotFound, taskNotFound, taskHasWorker } from './errors'
import type { TaskDirectiveContext } from './handler'

export interface ReassignWorkerDirective {
  readonly kind: 'reassign_worker'
  readonly agentId: string
  readonly targetTaskId: string
}

export const handleReassignWorkerDirective = (
  directive: ReassignWorkerDirective,
  _context: TaskDirectiveContext,
) =>
  Effect.gen(function* () {
    const agentReader = yield* AgentStateReaderTag
    const agentState = yield* agentReader.getAgentState()

    // Validate agent exists
    const agent = agentState.agents.get(directive.agentId)
    if (!agent) {
      const err = agentNotFound(directive.agentId)
      return { success: false as const, code: err.code, error: err.message }
    }

    // Validate current task exists
    const taskReader = yield* TaskGraphStateReaderTag
    const currentTask = yield* taskReader.getTask(agent.taskId)
    if (!currentTask) {
      const err = taskNotFound(agent.taskId)
      return { success: false as const, code: err.code, error: err.message }
    }

    // Validate target task exists
    const targetTask = yield* taskReader.getTask(directive.targetTaskId)
    if (!targetTask) {
      const err = taskNotFound(directive.targetTaskId)
      return { success: false as const, code: err.code, error: err.message }
    }

    // Validate target task has no worker already
    if (targetTask.worker) {
      const err = taskHasWorker(directive.targetTaskId)
      return { success: false as const, code: err.code, error: err.message }
    }

    const bus = yield* WorkerBusTag<AppEvent>()

    yield* bus.publish({
      type: 'agent_task_changed',
      forkId: agent.forkId,
      agentId: directive.agentId,
      oldTaskId: agent.taskId,
      newTaskId: directive.targetTaskId,
    })

    return { success: true as const }
  })
