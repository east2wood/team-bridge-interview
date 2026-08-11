@windows
Feature: System audio capture

  As a user in a meeting
  I want everything my machine plays to be captured
  So that I get the other participants without installing a virtual audio cable

  Capture uses WASAPI loopback on the default render device. It is
  application-agnostic: whatever reaches the speakers reaches the pipeline.

  Background:
    Given a WASAPI loopback capture is available on the default render device

  @mvp
  Scenario: Loopback captures audio from any application
    Given "chrome.exe" is playing the fixture "standup-30s.wav"
    When system audio capture starts
    Then PCM frames are delivered to the audio buffer
    And the captured signal matches the fixture within a correlation of 0.95

  @mvp
  Scenario: Capture requires no per-application configuration
    Given "teams.exe" is playing audio
    And "chrome.exe" is playing audio simultaneously
    When system audio capture starts
    Then the captured signal contains both sources

  Scenario: Silence is captured as silence, not as a stall
    Given no application is playing audio
    When system audio capture starts
    Then PCM frames continue to be delivered at the expected rate
    And every frame is below the silence threshold

  @manual
  Scenario: Capture follows a change of default output device
    Given a session is recording from the default render device "Speakers"
    When the user changes the default render device to "Headphones"
    Then capture is re-acquired on "Headphones" within 2 seconds
    And the session continues without stopping
    And the gap in captured audio is recorded in the session as a capture interruption

  Scenario: Audio on a non-default device is not captured
    Given the default render device is "Speakers"
    And an application is playing audio to "USB Interface"
    When system audio capture starts
    Then no signal from "USB Interface" appears in the captured audio
    And the user is warned that audio is playing to a device that is not being captured

  Scenario: Capture does not alter what the user hears
    Given the user is listening to audio at 50% volume
    When system audio capture starts
    Then playback continues uninterrupted
    And the output volume is unchanged

  Scenario: A device held in exclusive mode fails clearly
    Given another application holds the default render device in exclusive mode
    When system audio capture starts
    Then capture fails with a reason naming exclusive mode
    And the reason names the application holding the device

  Scenario: Capture stops releasing the device when the session ends
    Given a session is recording
    When the session stops
    Then the loopback capture is released
    And the device is available to other applications
