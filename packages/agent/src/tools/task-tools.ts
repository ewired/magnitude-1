import { Effect, Schema } from 'effect'
import { defineHarnessTool, StreamValidationError } from '@magnitudedev/harness'
import { Fork } from '@magnitudedev/event-core'
import { ExecutionManager } from '../execution/types'
import { TaskGraphStateReaderTag } from './task-reader'
import { AgentStateReaderTag } from './fork'
import { handleTaskDirective } from '../tasks/operations'
import type { TaskOperationGraphSnapshot } from '../tasks/operations/types'
import { formatTaskOutsideSubtreeError } from '../prompts/error-states'
import type { TaskRecord } from '../projections/task-graph'
import { AmbientServiceTag } from '@magnitudedev/event-core'
import { SkillsAmbient } from '../ambient/skills-ambient'
import { isSpawnableRole, getSpawnableRoles, type RoleId } from '../agents/role-validation'
import { ToolErrorSchema } from './errors'

const TaskToolErrorSchema = ToolErrorSchema('TaskToolError', {})

const { ForkContext } = Fork

const toGraphSnapshot = (tasks: ReadonlyMap<string, TaskRecord>): TaskOperationGraphSnapshot => ({
  tasks: new Map(
    [...tasks.entries()].map(([id, task]) => [id, {
      id,
      status: task.status,
      parentId: task.parentId,
      childIds: task.childIds,
      worker: task.worker
        ? { agentId: task.worker.agentId, forkId: task.worker.forkId, role: task.worker.role }
        : null,
    }]),
  ),
})

const isTaskInAssignedSubtree = (
  tasks: ReadonlyMap<string, { parentId: string | null }>,
  candidateParentId: string,
  assignedTaskId: string,
): boolean => {
  let current: string | null = candidateParentId
  while (current !== null) {
    if (current === assignedTaskId) return true
    current = tasks.get(current)?.parentId ?? null
  }
  return false
}

const runDirective = (directive: Parameters<typeof handleTaskDirective>[0]) =>
  Effect.gen(function* () {
    const taskReader = yield* TaskGraphStateReaderTag
    const state = yield* taskReader.getState()
    const { forkId } = yield* ForkContext

    // Worker subtree guard for task creation
    if (directive.kind === 'create' && forkId !== null) {
      const agentStateReader = yield* AgentStateReaderTag
      const agentState = yield* agentStateReader.getAgentState()
      const agentId = agentState.agentByForkId.get(forkId)
      const assignedTaskId = agentId ? agentState.agents.get(agentId)?.taskId?.trim() : null

      if (assignedTaskId) {
        const parentId = directive.parentId ?? null
        const allowed =
          parentId !== null && isTaskInAssignedSubtree(state.tasks, parentId, assignedTaskId)

        if (!allowed) {
          const attemptedParent = parentId ?? '(none)'
          return yield* Effect.fail({
            _tag: 'TaskToolError' as const,
            message: formatTaskOutsideSubtreeError(directive.taskId, attemptedParent, assignedTaskId),
          })
        }
      }
    }

    const ambientService = yield* AmbientServiceTag
    const skills = ambientService.getValue(SkillsAmbient)
    const result = yield* handleTaskDirective(directive, {
      forkId,
      timestamp: Date.now(),
      graph: toGraphSnapshot(state.tasks),
      skills,
    })

    if (result.success === false) {
      return yield* Effect.fail({
        _tag: 'TaskToolError' as const,
        message: result.error,
      })
    }

    return result
  })

const UpdateTaskStatusSchema = Schema.Literal('pending', 'completed', 'cancelled')

export const createTaskTool = defineHarnessTool({
  definition: {
    name: 'create_task',
    description: 'Create a task.',
    inputSchema: Schema.Struct({
      taskId: Schema.String.annotations({ description: 'Unique task identifier' }),
      title: Schema.String.annotations({ description: 'Task title' }),
      parent: Schema.optional(Schema.String.annotations({ description: 'Parent task ID to nest under; omit if no parent' })),
    }),
    outputSchema: Schema.Struct({ taskId: Schema.String }),
  },
  errorSchema: TaskToolErrorSchema,
  stream: {
    initial: {},
    onInput: (input, _state, _ctx) => Effect.gen(function* () {
      if (!input.parent?.isFinal || !input.parent.value) return {}
      const taskReader = yield* TaskGraphStateReaderTag
      const graphState = yield* taskReader.getState()
      if (!graphState.tasks.has(input.parent.value)) {
        const validIds = [...graphState.tasks.keys()].slice(0, 20).join(', ')
        return yield* new StreamValidationError({
          message: `Parent task not found: ${input.parent.value}. Valid IDs: ${validIds}`,
        })
      }
      return {}
    }),
  },
  execute: (input, _ctx) =>
    Effect.gen(function* () {
      yield* runDirective({
        kind: 'create',
        taskId: input.taskId,
        parentId: input.parent?.trim() || null,
        title: input.title,
      })
      return { taskId: input.taskId }
    }),
})

export const updateTaskTool = defineHarnessTool({
  definition: {
    name: 'update_task',
    description: 'Update task status.',
    inputSchema: Schema.Struct({
      taskId: Schema.String.annotations({ description: 'Task ID to update' }),
      status: UpdateTaskStatusSchema.annotations({ description: 'New status: pending, completed, or cancelled' }),
    }),
    outputSchema: Schema.Struct({
      taskId: Schema.String,
      status: UpdateTaskStatusSchema,
    }),
  },
  errorSchema: TaskToolErrorSchema,
  stream: {
    initial: {},
    onInput: (input, _state, _ctx) => Effect.gen(function* () {
      if (!input.taskId?.isFinal) return {}
      const taskReader = yield* TaskGraphStateReaderTag
      const graphState = yield* taskReader.getState()
      if (!graphState.tasks.has(input.taskId.value)) {
        const validIds = [...graphState.tasks.keys()].slice(0, 20).join(', ')
        return yield* new StreamValidationError({
          message: `Task not found: ${input.taskId.value}. Valid IDs: ${validIds}`,
        })
      }
      return {}
    }),
  },
  execute: (input, _ctx) =>
    Effect.gen(function* () {
      yield* runDirective({
        kind: 'update',
        taskId: input.taskId,
        status: input.status,
      })
      return { taskId: input.taskId, status: input.status }
    }),
})

export const spawnWorkerTool = defineHarnessTool({
  definition: {
    name: 'spawn_worker',
    description: 'Spawn a worker for a task id. The body is the worker\'s initial instruction (same mechanics as a normal message). Use <magnitude:message to="task-id"> for follow-up communications. Only use spawn_worker to create a new worker or replace the current one.',
    inputSchema: Schema.Struct({
      taskId: Schema.String.annotations({ description: 'Task ID to spawn a worker for' }),
      role: Schema.String.annotations({ description: 'Worker role (e.g., engineer, scout, architect, critic, scientist, artisan).' }),
      agentId: Schema.String.annotations({ description: 'Unique agent ID for this worker. Use this ID to message or reassign the worker later.' }),
      message: Schema.String.annotations({ description: 'Initial instruction message for the worker' }),
      yield: Schema.optional(Schema.Boolean.annotations({ description: 'Set true to wait for this worker to respond before doing anything else.' })),
    }),
    outputSchema: Schema.Struct({
      taskId: Schema.String,
      agentId: Schema.String,
      title: Schema.String,
      yield: Schema.optional(Schema.Boolean),
    }),
  },
  errorSchema: TaskToolErrorSchema,
  stream: {
    initial: {},
    onInput: (input, _state, _ctx) => Effect.gen(function* () {
      if (!input.taskId?.isFinal) return {}

      const taskReader = yield* TaskGraphStateReaderTag
      const graphState = yield* taskReader.getState()

      if (!graphState.tasks.has(input.taskId.value)) {
        const validIds = [...graphState.tasks.keys()].slice(0, 20).join(', ')
        return yield* new StreamValidationError({
          message: `Task not found: ${input.taskId.value}. Valid IDs: ${validIds}`,
        })
      }

      if (input.agentId?.isFinal) {
        const agentStateReader = yield* AgentStateReaderTag
        const agentState = yield* agentStateReader.getAgentState()
        if (agentState.agents.has(input.agentId.value)) {
          return yield* new StreamValidationError({
            message: `Agent ${input.agentId.value} already exists. Use a unique agentId.`,
          })
        }
      }

      return {}
    }),
  },
  execute: (input, _ctx) =>
    Effect.gen(function* () {
      if (!isSpawnableRole(input.role)) {
        return yield* Effect.fail({
          _tag: 'TaskToolError' as const,
          message: `Invalid worker role "${input.role}". Valid roles: ${getSpawnableRoles().join(', ')}`,
        })
      }
      const role: RoleId = input.role

      const execManager = yield* ExecutionManager
      const result = yield* runDirective({
        kind: 'spawn_worker',
        id: input.taskId,
        agentId: input.agentId,
        message: input.message,
        role,
        spawnWorker: (params): ReturnType<typeof execManager.fork> =>
          execManager.fork({
            parentForkId: params.parentForkId,
            name: params.name,
            agentId: params.agentId,
            prompt: params.prompt,
            message: params.message,
            mode: 'spawn',
            role,
            taskId: params.taskId,
          }),
      })

      if ('title' in result) {
        return { taskId: input.taskId, agentId: input.agentId, title: result.title, yield: input.yield || undefined }
      }

      return { taskId: input.taskId, agentId: input.agentId, title: '', yield: input.yield || undefined }
    }),
})

export const killWorkerTool = defineHarnessTool({
  definition: {
    name: 'kill_worker',
    description: 'Kill worker for a task id.',
    inputSchema: Schema.Struct({
      taskId: Schema.String.annotations({ description: 'Task ID whose worker to kill' }),
    }),
    outputSchema: Schema.Struct({
      taskId: Schema.String,
    }),
  },
  errorSchema: TaskToolErrorSchema,
  stream: {
    initial: {},
    onInput: (input, _state, _ctx) => Effect.gen(function* () {
      if (!input.taskId?.isFinal) return {}
      const taskReader = yield* TaskGraphStateReaderTag
      const graphState = yield* taskReader.getState()
      if (!graphState.tasks.has(input.taskId.value)) {
        const validIds = [...graphState.tasks.keys()].slice(0, 20).join(', ')
        return yield* new StreamValidationError({
          message: `Task not found: ${input.taskId.value}. Valid IDs: ${validIds}`,
        })
      }
      return {}
    }),
  },
  execute: (input, _ctx) =>
    Effect.gen(function* () {
      yield* runDirective({
        kind: 'kill_worker',
        id: input.taskId,
      })
      return { taskId: input.taskId }
    }),
})

export const reassignWorkerTool = defineHarnessTool({
  definition: {
    name: 'reassign_worker',
    description: 'Reassign a worker from its current task to a different task. The worker keeps its identity and conversation history.',
    inputSchema: Schema.Struct({
      agentId: Schema.String.annotations({ description: 'Agent ID of the worker to reassign' }),
      taskId: Schema.String.annotations({ description: 'Task ID to reassign the worker to' }),
    }),
    outputSchema: Schema.Struct({
      agentId: Schema.String,
      taskId: Schema.String,
    }),
  },
  errorSchema: TaskToolErrorSchema,
  stream: {
    initial: {},
    onInput: (input, _state, _ctx) => Effect.gen(function* () {
      if (input.agentId?.isFinal) {
        const agentStateReader = yield* AgentStateReaderTag
        const agentState = yield* agentStateReader.getAgentState()
        if (!agentState.agents.has(input.agentId.value)) {
          const validIds = [...agentState.agents.keys()].slice(0, 20).join(', ')
          return yield* new StreamValidationError({
            message: `Agent not found: ${input.agentId.value}. Valid IDs: ${validIds}`,
          })
        }
      }

      if (input.taskId?.isFinal) {
        const taskReader = yield* TaskGraphStateReaderTag
        const graphState = yield* taskReader.getState()
        if (!graphState.tasks.has(input.taskId.value)) {
          const validIds = [...graphState.tasks.keys()].slice(0, 20).join(', ')
          return yield* new StreamValidationError({
            message: `Task not found: ${input.taskId.value}. Valid IDs: ${validIds}`,
          })
        }
      }

      return {}
    }),
  },
  execute: (input, _ctx) =>
    Effect.gen(function* () {
      yield* runDirective({
        kind: 'reassign_worker',
        agentId: input.agentId,
        targetTaskId: input.taskId,
      })
      return { agentId: input.agentId, taskId: input.taskId }
    }),
})
