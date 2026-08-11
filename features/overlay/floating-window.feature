Feature: Floating window

  As a user with a call filling my screen
  I want a small overlay showing what is being said
  So that the transcript is glanceable without taking over my desktop

  The overlay is the entire user interface during a recording. A full
  application window is never opened as part of the recording flow.

  Background:
    Given the application is running in the tray

  @mvp
  Scenario: The overlay appears when recording starts
    When a session starts
    Then the floating window is visible
    And it is always on top
    And it shows "Listening..." until the first transcript arrives
    And no full application window is opened

  @mvp
  Scenario: Live transcript scrolls in the overlay
    Given a session is recording
    When segments commit in sequence
    Then the most recent lines are visible
    And older lines scroll out of view
    And the newest line is always visible without user interaction

  Scenario: Scrolling back pauses auto-scroll
    Given a session is recording
    And the overlay contains more lines than fit
    When the user scrolls up
    Then auto-scroll is paused
    And an indicator shows that new text is arriving
    When the user scrolls back to the bottom
    Then auto-scroll resumes

  Scenario: The overlay does not steal focus
    Given another application has keyboard focus
    When a session starts
    And segments commit
    Then keyboard focus remains with the other application throughout

  Scenario: Position and size persist across sessions
    Given the user has moved the overlay to the bottom-right of the display
    When the session stops
    And a new session starts
    Then the overlay reappears at the bottom-right

  Scenario: The overlay recovers from a disconnected display
    Given the overlay was positioned on a secondary display
    When the secondary display is disconnected
    And a session starts
    Then the overlay appears fully within the bounds of an attached display

  Scenario: The overlay shows recording state at a glance
    Given a session is recording
    Then a capture indicator and the elapsed time are visible
    When the session stops
    Then the overlay shows the finished state with the actions available

  @mvp
  Scenario: Finishing offers copy without opening a window
    Given a session has just stopped
    When the transcript is finalised
    Then the overlay offers to copy the transcript
    And the overlay offers to open the session in history

  Scenario: The overlay hides after a finished session is dismissed
    Given a session has stopped
    When the user dismisses the overlay
    Then the floating window is hidden
    And the application remains in the tray

  Scenario: Compact mode shows only the current line
    Given the overlay is in compact mode
    And a session is recording
    Then only the most recent line is shown
    And the overlay height does not exceed 96 pixels
