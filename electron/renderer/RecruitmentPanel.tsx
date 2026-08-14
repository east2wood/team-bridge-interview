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
  const [copied, setCopied] = useState(false)

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
              <h3>Candidate</h3>
              {recruitment.candidate ? (
                <>
                  <p className="panel__name">{recruitment.candidate.name}</p>
                  {recruitment.candidate.headline && (
                    <p className="panel__headline">{recruitment.candidate.headline}</p>
                  )}
                  {/* Only what is there: a column of dashes says nothing except
                      that somebody left the fields in. */}
                  <dl className="panel__facts">
                    <Fact label="Location" value={recruitment.candidate.location} />
                    <Fact label="Email" value={recruitment.candidate.email} />
                    <Fact label="Phone" value={recruitment.candidate.phone} />
                  </dl>
                </>
              ) : (
                <p className="muted">Not shown for this round.</p>
              )}
            </section>

            <section className="panel__section">
              <h3>Job</h3>
              <p className="panel__name">{recruitment.job?.title ?? recruitment.jobTitle ?? '—'}</p>
              {recruitment.companyName && (
                <p className="panel__headline">{recruitment.companyName}</p>
              )}
              {recruitment.job?.postingUrl && (
                <p className="panel__facts">
                  <a href={recruitment.job.postingUrl} target="_blank" rel="noreferrer">
                    Open the posting
                  </a>
                </p>
              )}

              <h4 className="panel__sub">Job Description</h4>
              {recruitment.job?.description ? (
                <div className="md">
                  <Markdown text={recruitment.job.description} />
                </div>
              ) : (
                <p className="muted">No job description available.</p>
              )}
            </section>

            <section className="panel__section">
              <h3>
                Resume
                {resumeText && (
                  <button
                    className="link"
                    onClick={() => {
                      void navigator.clipboard.writeText(resumeText)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
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

function Fact({ label, value }: { label: string; value?: string | null }) {
  if (!value?.trim()) return null
  return (
    <>
      <dt className="muted small">{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
