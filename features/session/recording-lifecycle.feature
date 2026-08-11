Feature: Recording lifecycle

  As a user
  I want starting and stopping a recording to be predictable
  So that I never wonder whether I am being recorded or whether my transcript survived

  A session moves through: idle → starting → recording → stopping → finalised.
  Failures move it to failed, never silently back to idle.

  Background:
    Given the application is running in the tray

  @mvp
  Scenario: A session captures audio, transcript, and metadata
    Given the system is playing the fixture "standup-30s.wav"
    When a session starts
    And the fixture plays to completion
    And the session stops
    Then the session is persisted with:
      | field    | value        |
      | source   | system       |
      | language | en           |
      | duration | 30 seconds   |
    And the session has at least 1 segment
    And started_at is before ended_at

  Scenario: Starting is rejected while a session is already recording
    Given a session is recording
    When a start is requested
    Then the request is ignored
    And exactly 1 session is recording

  @privacy
  Scenario: A visible capture indicator is shown for the whole session
    Given no session is recording
    Then no capture indicator is shown
    When a session starts
    Then a capture indicator is visible in the tray and the floating window
    When the session stops
    Then no capture indicator is shown

  @privacy
  Scenario: First run requires acknowledging the consent notice
    Given the application has never been run
    When the user triggers the recording hotkey
    Then the consent notice is shown before any audio device is opened
    And no session starts until the notice is acknowledged
    When the user acknowledges the notice
    Then the session starts
    And the notice is not shown on subsequent runs

  @privacy
  Scenario: Audio is discarded after transcription by default
    Given "save audio" is disabled
    And the system is playing the fixture "standup-30s.wav"
    When a session runs to completion
    Then the session directory contains no audio files
    And the transcript is persisted

  Scenario: Audio is retained when the user opts in
    Given "save audio" is enabled
    And the system is playing the fixture "standup-30s.wav"
    When a session runs to completion
    Then the session has an audio recording in Opus format
    And the recording duration matches the session duration within 200 milliseconds

  @mvp
  Scenario: Segments are persisted as they commit, not at the end
    Given the system is playing the fixture "standup-30s.wav"
    When a session starts
    And 3 segments have been committed
    Then 3 segments are readable from storage
    And the session is still recording

  Scenario: A crash mid-session leaves a recoverable session
    Given a session has committed 4 segments
    When the application terminates without stopping the session
    And the application restarts
    Then the session appears in history marked "incomplete"
    And its 4 segments are intact
    And ended_at is set to the last committed segment's end time

  Scenario: A session with no speech is discarded
    Given the system is playing the fixture "silence-20s.wav"
    When a session runs to completion
    Then no session is added to history
    And the user is told that no speech was detected

  Scenario: Capture failure fails the session loudly
    Given the audio capture device cannot be opened
    When a session start is requested
    Then the session enters the failed state
    And the user is shown the reason
    And no empty session is written to history
