Feature: Clipboard

  As a user who just finished a call
  I want the transcript on my clipboard in one action
  So that I can paste it into a ticket, a message, or my notes immediately

  Background:
    Given a session has finished with the transcript:
      """
      The deployment is scheduled for Thursday.
      We need the migration reviewed before then.
      """

  @mvp
  Scenario: Copying the finished transcript
    When the user copies the transcript
    Then the clipboard contains the full transcript text
    And the user is shown a confirmation

  Scenario: Auto-copy places the transcript on the clipboard without asking
    Given "auto-copy" is enabled
    When a session finishes
    Then the clipboard contains the transcript
    And the user is shown that it was copied automatically

  Scenario: Auto-copy is off by default
    Given the application has never been configured
    When a session finishes
    Then the clipboard is unchanged

  Scenario: Copying a single segment
    When the user copies the segment "We need the migration reviewed before then."
    Then the clipboard contains only that segment's text
    And the clipboard does not contain a timestamp

  Scenario: Copying with timestamps
    Given "include timestamps when copying" is enabled
    When the user copies the transcript
    Then each line in the clipboard is prefixed with its timestamp

  Scenario: Copying a two-channel transcript includes speaker labels
    Given the session has segments on both the "system" and "microphone" channels
    When the user copies the transcript
    Then each line is prefixed with its channel label

  Scenario: Copying an empty transcript is refused
    Given a session finished with no segments
    When the user copies the transcript
    Then the clipboard is unchanged
    And the user is told there is nothing to copy

  Scenario: Sending the clipboard to the assistant
    Given an AI provider is configured
    And the clipboard contains "rewrite this more formally"
    When the user triggers the clipboard assistant hotkey
    Then the clipboard contents are sent to the assistant as input
    And the response is available to copy

  Scenario: The clipboard assistant hotkey does nothing without a provider
    Given no AI provider is configured
    When the user triggers the clipboard assistant hotkey
    Then the clipboard is unchanged
    And the user is told that AI features need to be configured

  @privacy
  Scenario: Copying never sends anything anywhere
    Given the machine is offline
    When the user copies the transcript
    Then the clipboard contains the transcript
    And no network request is made
