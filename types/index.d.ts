// State the code-mode band reads while it draws.

/** Whether the band above the prompt shows the list of proposed hints. */
export type CodeModeReviewOpen = boolean

declare module 'claude-code' {
  interface PluginState {
    'code-mode': { isReviewOpen: CodeModeReviewOpen }
  }
}
