Feature: Summaries and action items

  As someone who just sat through a 40 minute call
  I want the decisions and the things I owe people extracted
  So that I do not have to re-read the transcript to find out what happens next

  Background:
    Given an AI provider is configured
    And a session exists titled "Design sync" with the transcript:
      """
      Priya: The migration script is ready but I haven't tested the rollback.
      Tom: Let's not ship Thursday then. Push to Monday.
      Priya: Agreed. I'll have the rollback tested by Friday.
      Tom: I'll tell support about the new date.
      Priya: Do we need a maintenance window?
      """

  Scenario: Summarising a session
    When the user requests a summary of "Design sync"
    Then a summary is produced
    And it is persisted against the session
    And it records the provider and model that produced it

  Scenario: Decisions are extracted
    When the user requests a summary of "Design sync"
    Then the decisions include a decision to move the ship date from Thursday to Monday

  Scenario: Action items carry an owner
    When the user requests a summary of "Design sync"
    Then the action items include:
      | owner | item                     |
      | Priya | test the rollback        |
      | Tom   | tell support of the date |

  Scenario: Open questions are separated from decisions
    When the user requests a summary of "Design sync"
    Then the open questions include whether a maintenance window is needed
    And that item does not appear as a decision

  Scenario: An unowned action item is marked unassigned rather than guessed
    Given the transcript contains "someone should update the runbook"
    When the user requests a summary
    Then the action item "update the runbook" is listed with no owner
    And no owner is invented

  Scenario: Summarising the same session twice replaces the previous summary
    Given a summary of "Design sync" already exists
    When the user requests a summary again
    Then the session has exactly 1 summary
    And it is the newer one

  Scenario: Re-running is offered after the transcript changes
    Given a summary of "Design sync" exists
    When a segment is edited
    Then the summary is marked stale
    And the user is offered the chance to regenerate it

  Scenario: Summarising a short session is refused
    Given a session exists with 1 segment of 4 words
    When the user requests a summary
    Then no request is made to the provider
    And the user is told the session is too short to summarise

  @slow
  Scenario: A long session is summarised without exceeding the context window
    Given a session exists with a 3 hour transcript
    When the user requests a summary
    Then the transcript is folded in chunks before the final summary
    And a single summary is produced
    And the chunking is not visible in the result

  Scenario: A two-channel session attributes by channel
    Given a session exists with segments on both channels
    When the user requests a summary
    Then action items owned by the user come from the "microphone" channel
    And action items owned by others come from the "system" channel

  Scenario: The summary can be copied and exported
    Given a summary of "Design sync" exists
    When the user copies the summary
    Then the clipboard contains the summary as Markdown
    And the action items are formatted as a checklist

  Scenario: Auto-summary runs on finish when enabled
    Given auto-summary is enabled
    When a session of 12 minutes finishes
    Then a summary is requested automatically
    And the user is shown that it is being generated
    And the session is saved whether or not the summary succeeds
