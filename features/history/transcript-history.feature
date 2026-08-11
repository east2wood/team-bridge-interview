Feature: Transcript history

  As a user
  I want every recording to be saved and easy to find later
  So that I never have to think about saving during a call

  Background:
    Given the current date is 2026-08-10
    And the following sessions exist:
      | title        | started_at       | duration | source           |
      | Meeting      | 2026-08-10 09:21 | 3 min    | system           |
      | Design sync  | 2026-08-10 14:02 | 22 min   | system+microphone|
      | Support Call | 2026-08-09 16:40 | 8 min    | system           |
      | Retro        | 2026-07-28 11:00 | 45 min   | system           |

  @mvp
  Scenario: Sessions are grouped by day with relative headings
    When the user opens history
    Then the sessions are grouped as:
      | group     | sessions                 |
      | Today     | Design sync, Meeting     |
      | Yesterday | Support Call             |
      | Earlier   | Retro                    |
    And within each group the most recent session is first

  @mvp
  Scenario: Each entry shows enough to identify it without opening it
    When the user opens history
    Then the entry for "Meeting" shows the start time "09:21"
    And it shows the duration "3 min"
    And it shows a preview of the first segment

  Scenario: Opening a session shows the full transcript
    When the user opens the session "Support Call"
    Then all of its segments are shown in chronological order
    And each segment shows its timestamp relative to the session start

  Scenario: Channels are distinguished in a two-channel session
    When the user opens the session "Design sync"
    Then segments are labelled by channel
    And the user can filter to a single channel

  Scenario: An untitled session is named from its content
    Given a session finishes with no title
    When the session is finalised
    Then it is given a title derived from its opening segments
    And the user can rename it

  Scenario: Renaming persists
    When the user renames "Meeting" to "Sprint planning"
    And the application restarts
    Then the session is listed as "Sprint planning"

  Scenario: Deleting a session removes everything belonging to it
    When the user deletes the session "Retro"
    And confirms the deletion
    Then the session is gone from history
    And its segments are gone from storage
    And its audio recording is deleted if one existed

  Scenario: Deletion requires confirmation
    When the user deletes the session "Retro"
    Then a confirmation is required before anything is removed
    When the user cancels
    Then the session and its segments are intact

  Scenario: Exporting a transcript
    When the user exports the session "Support Call" as Markdown
    Then the export contains the session title, date, and duration
    And it contains every segment with its timestamp

  Scenario: An incomplete session is marked
    Given the session "Design sync" was interrupted by a crash
    When the user opens history
    Then "Design sync" is marked "incomplete"
    And its committed segments are readable

  Scenario: History stays responsive with a large archive
    Given 2000 sessions exist
    When the user opens history
    Then the first screen of results is shown within 200 milliseconds
    And further sessions load as the user scrolls
