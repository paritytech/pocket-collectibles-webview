import { Component, type ErrorInfo, type ReactNode } from 'react'
import { sendFlowEvent } from '../host/send'

interface Props { children: ReactNode }
interface State { hasError: boolean }

/** Last line of defence: any render/lifecycle exception (a bad entry, a future
 *  edit, an unexpected native payload that slips through) is caught here so
 *  the whole webview degrades to a calm "couldn't load" panel instead of a
 *  blank white screen. The error is reported to native via flow.error. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      sendFlowEvent({ type: 'flow.error', phase: 'render', detail: message.slice(0, 200) })
    } catch { /* never let reporting throw from the boundary */ }
    if (typeof console !== 'undefined') {
      console.error('[error-boundary]', error, info?.componentStack)
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="fatal-screen" role="alert">
        <div className="fatal-mark" aria-hidden="true">◈</div>
        <div className="fatal-copy">Your collection couldn’t be displayed.</div>
        <button
          type="button"
          className="fatal-retry"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    )
  }
}
