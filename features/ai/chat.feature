Feature: Chat over a transcript

  As a user
  I want to ask questions about what was said
  So that I can interrogate a conversation instead of re-reading it

  Chat is grounded in one session's transcript. It does not reach into other
  sessions, and it does not answer from general knowledge as though the
  transcript said so.

  Background:
    Given an AI provider is configured
    And a session exists titled "Design sync" with the transcript:
      """
      Priya: The migration script is ready but I haven't tested the rollback.
      Tom: Let's not ship Thursday then. Push to Monday.
      Priya: Agreed. I'll have the rollback tested by Friday.
      """

  Scenario: Asking a question about the transcript
    When the user asks "when are we shipping?"
    Then the answer says Monday
    And the answer cites the segment it came from

  Scenario: Answers stream
    When the user asks "summarise Priya's commitments"
    Then response text appears progressively
    And the answer can be cancelled while it streams

  Scenario: Follow-up questions keep the conversation context
    Given the user asked "when are we shipping?" and received an answer
    When the user asks "why did it move?"
    Then the answer refers to the untested rollback
    And the earlier exchange is included as context

  Scenario: The chat is scoped to one session
    Given another session exists containing "the database is on Postgres 14"
    When the user asks "what database version are we on?"
    Then the answer says the transcript does not contain that information
    And no content from the other session is used

  Scenario: Unanswerable questions are answered honestly
    When the user asks "what did Tom have for lunch?"
    Then the answer says the transcript does not say
    And no answer is invented

  Scenario: The chat conversation is persisted with the session
    Given the user has exchanged 3 messages about "Design sync"
    When the application restarts
    And the user opens "Design sync"
    Then the 3 messages are still there

  Scenario: Clearing the chat leaves the transcript intact
    Given the user has exchanged 3 messages about "Design sync"
    When the user clears the chat
    Then the messages are removed
    And the transcript and its segments are unchanged

  Scenario: Chat during a live session sees the transcript so far
    Given a session is recording
    And 6 segments have committed
    When the user asks "what have they asked me so far?"
    Then the answer is based on the 6 committed segments
    And the session continues recording while the answer streams

  Scenario: An answer can be copied
    Given the user has received an answer
    When the user copies the answer
    Then the clipboard contains the answer text

  Scenario: Chat is unavailable without a provider
    Given no AI provider is configured
    When the user opens a session
    Then the chat panel is not offered
    And the transcript, history, and clipboard features remain available
