@windows
Feature: Microphone capture

  As a user who wants my own side of the conversation transcribed
  I want to optionally capture my microphone alongside system audio
  So that the transcript is a whole conversation rather than half of one

  The microphone is off by default. When it is on, its audio stays on its own
  channel through the whole pipeline so that speaker attribution is structural
  rather than guessed.

  Background:
    Given a microphone device is available

  @privacy
  Scenario: The microphone is off by default
    Given the application has never been configured
    When a session starts
    Then no microphone stream is opened
    And the session source is "system"

  Scenario: Enabling the microphone captures both channels
    Given microphone capture is enabled
    And the system is playing the fixture "standup-30s.wav"
    And the microphone is receiving the fixture "my-reply-8s.wav"
    When a session runs to completion
    Then the session source is "system+microphone"
    And segments exist on the "system" channel
    And segments exist on the "microphone" channel

  Scenario: Speaker attribution comes from the channel, not from diarisation
    Given microphone capture is enabled
    And the system is playing the fixture "standup-30s.wav"
    And the microphone is receiving the fixture "my-reply-8s.wav"
    When a session runs to completion
    Then every segment carries exactly one channel
    And no segment is attributed by voice similarity

  Scenario: Echo cancellation is disabled on the microphone stream
    Given microphone capture is enabled
    When the microphone stream is opened
    Then echo cancellation is disabled
    And noise suppression is disabled
    And automatic gain control is disabled

  Scenario: A denied microphone permission does not break the session
    Given microphone capture is enabled
    And the operating system denies microphone access
    When a session starts
    Then the session continues with system audio only
    And the user is told the microphone was unavailable
    And the session source is "system"

  Scenario: Microphone can be muted mid-session
    Given microphone capture is enabled
    And a session is recording
    When the user mutes the microphone
    Then no further microphone audio enters the pipeline
    And system audio capture is unaffected
    And the transcript records the mute as a gap on the microphone channel

  @manual
  Scenario: Disconnecting the microphone mid-session
    Given microphone capture is enabled
    And a session is recording
    When the microphone device is disconnected
    Then the session continues with system audio only
    And the user is told the microphone was disconnected
