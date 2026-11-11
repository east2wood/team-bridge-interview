import type { AssistMessage } from './api-types'

/**
 * Whether this app's user wrote a message. The interviewer writes from the
 * desktop side; an assistant writes from the support side, beside everybody
 * else on it, so theirs are told apart by who sent them.
 */
export function isMine(
  message: AssistMessage,
  role: 'interviewer' | 'assistant',
  meId: number | null,
): boolean {
  if (role === 'interviewer') return message.source === 'desktop'
  return message.source === 'web' && meId !== null && message.sender.id === meId
}
