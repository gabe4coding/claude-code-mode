// State the code-mode band reads while it draws.

/** Whether the band above the prompt shows the proposals. */
export type CodeModeReviewOpen = boolean

/** Which proposal the open band shows, from 0. */
export type CodeModeReviewIndex = number

declare module 'claude-code' {
  interface PluginState {
    'code-mode': { isReviewOpen: CodeModeReviewOpen; reviewIndex: CodeModeReviewIndex }
  }
}
