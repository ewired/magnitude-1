import { Projection, Signal } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'

export interface ChatTitleGeneratedSignal {
  readonly title: string
}

export interface ChatTitleState {
  readonly chatName: string | null
}

export const ChatTitleProjection = Projection.define<AppEvent, ChatTitleState>()({
  name: 'ChatTitle',

  initial: {
    chatName: null,
  },

  signals: {
    chatTitleGenerated: Signal.create<ChatTitleGeneratedSignal>('ChatTitle/chatTitleGenerated'),
  },

  eventHandlers: {
    chat_title_generated: ({ event, state, emit }) => {
      emit.chatTitleGenerated({ title: event.title })
      return { ...state, chatName: event.title }
    },
  },
})
