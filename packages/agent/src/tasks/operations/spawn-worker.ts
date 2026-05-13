import { Effect } from 'effect'
import { Fork, WorkerBusTag, type WorkerBusService } from '@magnitudedev/event-core'
import type { AppEvent } from '../../events'
import { ConversationStateReaderTag } from '../../tools/memory-reader'
import { TaskGraphStateReaderTag } from '../../tools/task-reader'
import { buildAgentContext, buildConversationSummary } from '../../prompts'
import { buildTaskAssignedValidated } from './builders'
import { taskNotFound, taskHasWorker } from './errors'
import type { TaskDirectiveContext } from './handler'
import type { RoleId } from '../../agents/role-validation'

const { ForkContext } = Fork

export interface SpawnWorkerDirective<R = never> {
  readonly kind: 'spawn_worker'
  readonly id: string
  readonly agentId: string
  readonly message: string
  readonly role: RoleId
  readonly spawnWorker: (params: {
    parentForkId: string | null
    name: string
    agentId: string
    prompt: string
    message: string
    taskId: string
  }) => Effect.Effect<string, never, R>
}

export const handleSpawnWorkerDirective = <R>(
  directive: SpawnWorkerDirective<R>,
  context: TaskDirectiveContext,
): Effect.Effect<
  | { readonly success: true; readonly title: string }
  | { readonly success: false; readonly code: string; readonly error: string },
  never,
  TaskGraphStateReaderTag
  | ConversationStateReaderTag
  | WorkerBusService<AppEvent>
  | Fork.ForkContextService
  | R

> =>
  Effect.gen(function* () {
    const taskReader = yield* TaskGraphStateReaderTag
    const task = yield* taskReader.getTask(directive.id)
    if (!task) {
      const err = taskNotFound(directive.id)
      return { success: false, code: err.code, error: err.message } as const
    }

    const bus = yield* WorkerBusTag<AppEvent>()
    const { forkId: parentForkId } = yield* ForkContext
    const timestamp = Date.now()

    if (task.worker) {
      const err = taskHasWorker(directive.id)
      return { success: false, code: err.code, error: err.message } as const
    }

    const conversationReader = yield* ConversationStateReaderTag
    const conversationState = yield* conversationReader.getState()
    const summary = buildConversationSummary(conversationState.entries)

    const taskContract: string | undefined = undefined

    const agentId = directive.agentId
    const prompt = buildAgentContext(task.title, summary, directive.id, taskContract)
    const forkId = yield* directive.spawnWorker({
      parentForkId,
      name: task.title,
      agentId,
      prompt,
      message: directive.message,
      taskId: directive.id,
    })

    yield* bus.publish(buildTaskAssignedValidated({
      taskId: directive.id,
      assignee: 'worker',
      workerRole: directive.role,
      message: directive.message,
      workerInfo: { agentId, forkId, role: directive.role },
    }, { forkId: parentForkId, timestamp, graph: { tasks: new Map() } }))

    return { success: true, title: task.title } as const
  })
