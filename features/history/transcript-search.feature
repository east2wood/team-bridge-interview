Feature: Transcript search

  As a user who remembers a phrase but not which call it was in
  I want to search across every transcript
  So that the archive is worth keeping

  Background:
    Given the following sessions exist with transcripts:
      | title        | started_at       | transcript                                              |
      | Meeting      | 2026-08-10 09:21 | the deployment is scheduled for Thursday                |
      | Support Call | 2026-08-09 16:40 | the customer cannot reset their password                |
      | Retro        | 2026-07-28 11:00 | deployment went badly, we should automate the rollback  |

  Scenario: Searching returns matching sessions
    When the user searches for "deployment"
    Then the results include "Meeting"
    And the results include "Retro"
    And the results do not include "Support Call"

  Scenario: Results show the matching text in context
    When the user searches for "deployment"
    Then each result shows the matching segment's text
    And the matched term is highlighted
    And each result shows its timestamp within the session

  Scenario: Opening a result jumps to the moment
    When the user searches for "rollback"
    And opens the result in "Retro"
    Then the session opens scrolled to the matching segment
    And the matching segment is highlighted

  Scenario: Search is case and diacritic insensitive
    When the user searches for "DEPLOYMENT"
    Then the results include "Meeting"

  Scenario: Multi-word search matches the phrase
    When the user searches for "reset their password"
    Then the results include "Support Call"
    And the results do not include "Meeting"

  Scenario: No matches is a clear empty state
    When the user searches for "kubernetes"
    Then no results are shown
    And the user is told that nothing matched

  Scenario: Results can be narrowed by date
    When the user searches for "deployment"
    And filters to sessions from the last 7 days
    Then the results include "Meeting"
    And the results do not include "Retro"

  Scenario: Search stays fast across a large archive
    Given 2000 sessions exist with 200000 segments in total
    When the user searches for "deployment"
    Then results are returned within 300 milliseconds

  Scenario: Deleted sessions leave the index
    Given the user has deleted the session "Retro"
    When the user searches for "rollback"
    Then no results are shown

  @privacy
  Scenario: Search runs locally
    Given the machine is offline
    When the user searches for "deployment"
    Then results are returned
    And no network request is made
