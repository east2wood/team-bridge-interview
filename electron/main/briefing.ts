import type { Interview, Recruitment } from '@shared/api-types'

/**
 * The first message to the assistant app: who the candidate is, what the job
 * is, and the resume, followed by how to treat the questions that come next.
 *
 * Contact details are left out on purpose. The assistant needs to know who the
 * candidate is and what they have done, not how to reach them.
 */
export function buildBriefing(interview: Interview, recruitment: Recruitment | null): string {
  const candidate = recruitment?.candidate ?? interview.candidate ?? null
  const jobTitle = recruitment?.job?.title ?? recruitment?.jobTitle ?? interview.position.title
  const company = recruitment?.companyName ?? interview.company.name

  const candidateLines = [
    field('Name', candidate?.name),
    field('Headline', recruitment?.candidate?.headline),
    field('Location', recruitment?.candidate?.location),
  ]

  const job = recruitment?.job
  const jobLines = [
    field('Title', jobTitle),
    field('Company', company),
    field('Posting', job?.postingUrl),
  ]
  const description = job?.description?.trim()

  const resume = recruitment?.resume
  const resumeText = resume?.text?.trim() || (resume?.url ? `Resume link: ${resume.url}` : '')

  return [
    'I am in a job interview and want your help answering the interviewer’s questions.',
    'Below are the candidate, the job description, and the resume. Read them and reply only “Ready”.',
    'After that, every message I send is a question the interviewer asked. Answer it as the candidate, in the first person, briefly and naturally, grounded in the resume and the job.',
    section('Candidate', candidateLines),
    section('Job', jobLines, description ? `Description:\n${description}` : undefined),
    section('Resume', [], resumeText || 'No resume is on file for this round.'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function field(label: string, value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? `${label}: ${text}` : null
}

function section(title: string, lines: (string | null)[], body?: string): string | null {
  const parts = [...lines.filter((line): line is string => line !== null), ...(body ? [body] : [])]
  return parts.length > 0 ? `## ${title}\n${parts.join('\n')}` : null
}
