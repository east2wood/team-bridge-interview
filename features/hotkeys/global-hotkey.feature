@windows
Feature: Global hotkey

  As someone in a call in another application
  I want to start and stop recording without switching windows
  So that capturing a moment costs me nothing in attention

  The hotkey must work while TeamBridge Interview is unfocused, minimised, or
  hidden in the tray. If it only worked when focused it would be useless.

  Background:
    Given the application is running in the tray
    And the recording hotkey is "Ctrl+Shift+Space"

  @mvp
  Scenario: Toggle mode starts a session from an unfocused app
    Given the hotkey mode is "toggle"
    And no session is recording
    And another application has keyboard focus
    When the user presses "Ctrl+Shift+Space"
    Then a session starts recording
    And the floating window becomes visible
    And keyboard focus stays with the other application

  @mvp
  Scenario: Toggle mode stops the session on a second press
    Given the hotkey mode is "toggle"
    And a session has been recording for 12 seconds
    When the user presses "Ctrl+Shift+Space"
    Then the session stops
    And the session is finalised with a duration of 12 seconds

  Scenario: Push-to-talk records only while the keys are held
    Given the hotkey mode is "push-to-talk"
    And no session is recording
    When the user presses and holds "Ctrl+Shift+Space" for 5 seconds
    Then a session records for the duration of the hold
    And the session stops when the keys are released
    And the session duration is 5 seconds

  Scenario: Push-to-talk ignores a tap below the minimum hold
    Given the hotkey mode is "push-to-talk"
    And the minimum hold duration is 300 milliseconds
    When the user presses and releases "Ctrl+Shift+Space" within 120 milliseconds
    Then no session is started
    And no entry is added to history

  Scenario: Registration fails when the combination is taken
    Given "Ctrl+Shift+Space" is already registered by another application
    When the application starts
    Then the hotkey is reported as unavailable
    And the user is shown which combination failed
    And the application remains usable via the tray menu

  Scenario: Rebinding takes effect without a restart
    Given a session is not recording
    When the user rebinds the recording hotkey to "Ctrl+Alt+R"
    Then "Ctrl+Alt+R" starts a session
    And "Ctrl+Shift+Space" no longer starts a session

  Scenario Outline: Rejected key combinations
    When the user attempts to bind the recording hotkey to "<combination>"
    Then the binding is rejected with the reason "<reason>"
    And the previous binding remains active

    Examples:
      | combination | reason                          |
      | Space       | requires at least one modifier   |
      | Ctrl+C      | reserved by the operating system |
      | Ctrl+Alt+Del| reserved by the operating system |

  Scenario: Hotkey is released on quit
    Given the application has registered "Ctrl+Shift+Space"
    When the application quits
    Then "Ctrl+Shift+Space" is released to the operating system
