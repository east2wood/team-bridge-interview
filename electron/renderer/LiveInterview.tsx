import { useCallback, useEffect, useState } from 'react'
import type { LiveSessionState } from '@shared/api-types'
import { InterviewList } from './InterviewList'
import { InterviewDetail } from './InterviewDetail'
import logoLight from './assets/logo-header.png'
import logoDark from './assets/logo-header-dark.png'

interface Notice {
  level: 'info' | 'warn' | 'error'
  message: string
}

/**
 * Root of the Live Interview window.
 *
 * A fixed header over two screens, chosen by whether an interview is open. The
 * selected interview is real application state held in main, so it survives
 * this window being closed and reopened — which is why the switch reads from
 * live state rather than a local flag.
 */
export function LiveInterview() {
  const [live, setLive] = useState<LiveSessionState | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [listRefresh, setListRefresh] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const off = [window.tb.onLiveState(setLive), window.tb.onNotice(setNotice)]
    void window.tb.getLive().then(setLive)
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [])

  const roundOpen = Boolean(live?.interview)

  // What Refresh means depends on the screen: the list of rounds, or the open
  // round's chat.
  const refresh = async () => {
    if (refreshing) return
    if (!roundOpen) {
      setListRefresh((n) => n + 1)
      return
    }
    setRefreshing(true)
    try {
      await window.tb.refreshChat()
    } finally {
      setRefreshing(false)
    }
  }

  const onListLoading = useCallback((loading: boolean) => setRefreshing(loading), [])

  return (
    <main className="live">
      <AppHeader refreshing={refreshing} onRefresh={() => void refresh()} />

      {notice && (
        <button className={`callout callout--${notice.level}`} onClick={() => setNotice(null)}>
          {notice.message}
        </button>
      )}

      {!live ? (
        <p className="muted loading">Loading…</p>
      ) : live.interview ? (
        <InterviewDetail live={live} />
      ) : (
        <InterviewList
          refreshKey={listRefresh}
          onLoading={onListLoading}
          onOpen={(interview) => window.tb.selectInterview(interview)}
        />
      )}
    </main>
  )
}

/**
 * The bar across the top of the window. Outside every scroller, so it stays
 * put whatever is scrolled beneath it.
 */
function AppHeader({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <header className="apphead">
      <span className="apphead__side" />
      <span className="apphead__brand">
        <img className="apphead__logo apphead__logo--light" src={logoLight} alt="TeamBridge" />
        <img className="apphead__logo apphead__logo--dark" src={logoDark} alt="TeamBridge" />
      </span>
      <span className="apphead__side apphead__side--end">
        <button className="compact" onClick={onRefresh} disabled={refreshing} title="Load the latest">
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
        <button className="compact" onClick={() => window.tb.openSettings()} title="Settings">
          ⚙ Settings
        </button>
      </span>
    </header>
  )
}
