export type { Phase, BaseState } from '@magnitudedev/harness'
export type { EditDiff } from './edit-diff'

import type { Toolkit, ToolkitKeys } from '@magnitudedev/harness'
import { leaderToolkit } from '../tools/toolkits'

type ToolStateFromToolkit<T extends Toolkit> = {
  [K in ToolkitKeys<T>]: T['entries'][K] extends { state: { initial: infer S } } ? S : never
}[ToolkitKeys<T>]

export type ToolState = ToolStateFromToolkit<typeof leaderToolkit>

export { fileReadModel, type FileReadState } from './file-read'
export { fileWriteModel, type FileWriteState } from './file-write'
export { fileEditModel, type FileEditState } from './file-edit'
export { fileTreeModel, type FileTreeState } from './file-tree'
export { fileSearchModel, type FileSearchState } from './file-search'
export { webFetchModel, type WebFetchState } from './web-fetch'
export { webSearchModel, type WebSearchState } from './web-search'

export { createTaskModel, type CreateTaskState } from './create-task'
export { updateTaskModel, type UpdateTaskState } from './update-task'
export { spawnWorkerModel, type SpawnWorkerState } from './spawn-worker'
export { killWorkerModel, type KillWorkerState } from './kill-worker'
export { yieldModel, type YieldState } from './yield'
export { workerYieldModel, type WorkerYieldState } from './yield'

export { shellModel, type ShellState } from './shell'
export { skillActivationModel, type SkillActivationState } from './skill-activation'
export { fileViewModel, type FileViewState } from './file-view'
export {
  createBrowserActionModel,
  type BrowserActionState,
  clickModel,
  doubleClickModel,
  rightClickModel,
  typeModel,
  scrollModel,
  dragModel,
  navigateModel,
  goBackModel,
  switchTabModel,
  newTabModel,
  screenshotModel,
  evaluateModel,
} from './browser-action'
export { isToolKey, type ToolKey } from '../tools/toolkits'

// Aliases for display compatibility
export { fileWriteModel as contentModel, type FileWriteState as ContentState } from './file-write'
export { fileEditModel as diffModel, type FileEditState as DiffState } from './file-edit'
