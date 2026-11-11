import type { FaceValue, Interview, Recruitment } from '@shared/api-types'

/**
 * The first message to the assistant app: who the candidate is, what the job
 * is, and the resume, followed by how to treat the questions that come next.
 *
 * The candidate is their whole profile, as the server sends it: contact
 * details, location, work authorisation, links, and the longer writing
 * (bio, skills, experience, education). An interviewer's question the resume
 * does not answer — where are you based, do you need sponsorship — very often
 * is answered there.
 */
export function buildBriefing(interview: Interview, recruitment: Recruitment | null): string {
  const candidate = recruitment?.candidate ?? interview.candidate ?? null
  const jobTitle = recruitment?.job?.title ?? recruitment?.jobTitle ?? interview.position.title
  const company = recruitment?.companyName ?? interview.company.name

  const fields = recruitment?.candidate?.fields
  const profile = fields ? profileOf(fields) : { lines: [], blocks: [] }
  const candidateLines = [
    field('Name', candidate?.name),
    field('Headline', recruitment?.candidate?.headline),
    // A server that sends the whole profile has the location in it; an older
    // one sends only this.
    ...(fields ? profile.lines : [field('Location', recruitment?.candidate?.location)]),
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
    section('Candidate', candidateLines, profile.blocks.join('\n\n') || undefined),
    section('Job', jobLines, description ? `Description:\n${description}` : undefined),
    section('Resume', [], resumeText || 'No resume is on file for this round.'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Profile fields, in the order a person reads a profile, by the label a person
 * would give them. Anything the server sends that is not named here still goes,
 * after these, under a label made from its name: a field added to the profile
 * later should reach ChatGPT without waiting for this list.
 */
const PROFILE_FIELDS: [key: string, label: string][] = [
  ['first_name', 'First name'],
  ['middle_name', 'Middle name'],
  ['last_name', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['address', 'Address'],
  ['street', 'Street'],
  ['city', 'City'],
  ['location_state', 'State'],
  ['zip_code', 'ZIP code'],
  ['professional_years', 'Years of professional experience'],
  ['disciplines', 'Disciplines'],
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['work_authorization_country', 'Work authorization country'],
  ['authorized_to_work', 'Authorized to work'],
  ['us_person', 'US person'],
  ['citizenship_status', 'Citizenship status'],
  ['sponsorship_required', 'Sponsorship required'],
  ['requires_future_sponsorship', 'Requires future sponsorship'],
  ['dob', 'Date of birth'],
  ['gender', 'Gender'],
  ['race', 'Race'],
  ['disability', 'Disability'],
  ['veteran_status', 'Veteran status'],
]

/** The longer writing, given a paragraph each rather than a line. */
const PROFILE_BLOCKS: [key: string, label: string][] = [
  ['bio', 'Bio'],
  ['description', 'Description'],
  ['skills', 'Skills'],
  ['experience', 'Experience'],
  ['education', 'Education'],
]

/** Already said above the profile, from the same record. */
const SAID_ALREADY = new Set(['resume_title'])

function profileOf(fields: Record<string, FaceValue>): { lines: string[]; blocks: string[] } {
  const named = new Set([...PROFILE_FIELDS, ...PROFILE_BLOCKS].map(([key]) => key))
  const rest = Object.keys(fields)
    .filter((key) => !named.has(key) && !SAID_ALREADY.has(key))
    .sort()
    .map((key): [string, string] => [key, labelFor(key)])

  const lines = [...PROFILE_FIELDS, ...rest]
    .map(([key, label]) => field(label, show(fields[key])))
    .filter((line): line is string => line !== null)
  const blocks = PROFILE_BLOCKS.flatMap(([key, label]) => {
    const text = show(fields[key])
    return text ? [`${label}:\n${text}`] : []
  })
  return { lines, blocks }
}

function show(value: FaceValue | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || null
  return String(value).trim() || null
}

/** "work_authorization_country" → "Work authorization country". */
function labelFor(key: string): string {
  const words = key.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function field(label: string, value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? `${label}: ${text}` : null
}

function section(title: string, lines: (string | null)[], body?: string): string | null {
  const parts = [...lines.filter((line): line is string => line !== null), ...(body ? [body] : [])]
  return parts.length > 0 ? `## ${title}\n${parts.join('\n')}` : null
}
