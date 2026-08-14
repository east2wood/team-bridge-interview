import { useEffect, useState } from 'react'
import type { Interview, Recruitment } from '@shared/api-types'
import { Markdown } from './markdown'

/**
 * Who the round is with and what it is about, beside the interview.
 *
 * A reference surface, not a second application: read-only, opened and closed
 * without touching anything, and deliberately one scroll rather than tabs —
 * during a round, switching tabs to find a line of a resume is slower than
 * scrolling past a heading you recognise.
 *
 * Nothing here is on the path of anything live. Capture, transcription, upload
 * and answers carry on behind it, and the only work it causes is one request
 * the first time it is opened.
 */
export function RecruitmentPanel({
  interview,
  onClose,
}: {
  interview: Interview
  onClose: () => void
}) {
  const [recruitment, setRecruitment] = useState<Recruitment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState<'resume' | 'job' | null>(null)
  const [wholeJob, setWholeJob] = useState(false)

  const id = interview.recruitmentId

  useEffect(() => {
    if (id === null) return
    let live = true
    setLoading(true)
    setError(null)
    void window.tb
      .getRecruitment(id)
      .then((data) => live && setRecruitment(data))
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [id, attempt])

  // Escape closes it. Listening is not interrupted — this was never part of it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const resume = recruitment?.resume
  const resumeText = resume?.text?.trim()
  const description = recruitment?.job?.description?.trim()
  // Worth an excerpt only when there is more than an excerpt. A three-line
  // posting with a Show more under it is a control that does nothing.
  const longJob =
    !!description &&
    (description.split('\n').filter(Boolean).length > 8 || description.length > 420)

  const flash = (what: 'resume' | 'job', text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <aside className="panel" aria-label="Recruitment details">
      <header className="panel__head">
        <div className="panel__title">
          <strong>Recruitment Details</strong>
          <span className="muted small">
            {[recruitment?.jobTitle ?? interview.position.title, recruitment?.companyName ?? interview.company.name]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <button className="link panel__close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>

      <div className="panel__body">
        {id === null && <p className="muted">This round has no recruitment behind it.</p>}

        {loading && <p className="muted">Loading candidate and resume…</p>}

        {error && (
          <div className="panel__error">
            <p className="muted">Recruitment details unavailable.</p>
            <p className="muted small">{error}</p>
            <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
          </div>
        )}

        {recruitment && (
          <>
            <section className="panel__section">
              <h3>Job{description && (
                  <button className="link" onClick={() => flash('job', description)}>
                    {copied === 'job' ? 'Copied' : 'Copy'}
                  </button>
                )}</h3>
              <p className="panel__name">{recruitment.job?.title ?? recruitment.jobTitle ?? '—'}</p>
              {description ? (
                <>
                  {/* An excerpt by default: the posting is reference, and a
                      screen of it between the role and the resume buries both. */}
                  <div className={`md ${longJob && !wholeJob ? 'md--excerpt' : ''}`}>
                    <Markdown text={description} />
                  </div>
                  {longJob && (
                    <button className="link" onClick={() => setWholeJob((open) => !open)}>
                      {wholeJob ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </>
              ) : (
                <p className="muted">No job description available.</p>
              )}
            </section>

            <section className="panel__section">
              <h3>
                Resume
                {resumeText && (
                  <button className="link" onClick={() => flash('resume', resumeText)}>
                    {copied === 'resume' ? 'Copied' : 'Copy'}
                  </button>
                )}
              </h3>

              {resume?.kind === 'link' && resume.url && (
                <p>
                  <a href={resume.url} target="_blank" rel="noreferrer">
                    The resume is kept elsewhere — open it
                  </a>
                </p>
              )}

              {resumeText ? (
                <div className="md">
                  <Markdown text={resumeText} />
                </div>
              ) : (
                resume?.kind !== 'link' && <p className="muted">No resume available.</p>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  )
}
