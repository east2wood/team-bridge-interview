Feature: Voice activity detection

  As the system
  I want to transcribe speech and not silence
  So that GPU time, battery, and transcript noise are all spent only where there is something to hear

  Silero VAD sits between the audio pipeline and Whisper. Nothing reaches
  Whisper that VAD has not marked as speech.

  Background:
    Given the Silero VAD model is loaded
    And the speech probability threshold is 0.5
    And the minimum speech duration is 250 milliseconds
    And the silence hangover is 700 milliseconds

  @mvp
  Scenario: Silence never reaches the transcription engine
    Given the fixture "silence-20s.wav" is playing
    When the audio flows through voice detection
    Then no speech segment is emitted
    And the transcription engine receives no work

  @mvp
  Scenario: A single utterance becomes one speech segment
    Given the fixture "single-utterance-4s.wav" is playing
    When the audio flows through voice detection
    Then 1 speech segment is emitted
    And the speech segment duration is within 300 milliseconds of 4 seconds

  Scenario: A natural pause does not split an utterance
    Given the fixture "utterance-with-400ms-pause.wav" is playing
    When the audio flows through voice detection
    Then 1 speech segment is emitted
    Because the pause is shorter than the silence hangover

  Scenario: A long silence closes the segment
    Given the fixture "two-utterances-2s-gap.wav" is playing
    When the audio flows through voice detection
    Then 2 speech segments are emitted
    And the gap between them is not included in either segment

  Scenario: Padding preserves the start and end of speech
    Given the speech padding is 200 milliseconds
    And the fixture "single-utterance-4s.wav" is playing
    When a speech segment is emitted
    Then the segment starts at most 200 milliseconds before detected speech onset
    And the segment ends at least 200 milliseconds after detected speech offset

  Scenario: Sub-threshold blips are discarded
    Given the fixture "keyboard-clicks-10s.wav" is playing
    When the audio flows through voice detection
    Then no speech segment is emitted

  Scenario: Continuous speech is cut into workable segments
    Given the maximum speech segment duration is 30 seconds
    And the fixture "monologue-90s.wav" is playing
    When the audio flows through voice detection
    Then no emitted speech segment exceeds 30 seconds
    And segments are cut at the lowest-energy point near the limit
    And no audio is lost between consecutive segments

  Scenario: Each channel is detected independently
    Given microphone capture is enabled
    And both channels contain overlapping speech
    When the audio flows through voice detection
    Then speech segments are emitted for both channels
    And a segment on one channel does not suppress a segment on the other

  Scenario: A lower threshold trades false positives for sensitivity
    Given the speech probability threshold is 0.2
    And the fixture "quiet-speech-6s.wav" is playing
    When the audio flows through voice detection
    Then at least 1 speech segment is emitted

  Scenario: VAD keeps up with real time
    Given the fixture "standup-30s.wav" is playing
    When the audio flows through voice detection
    Then the detection latency per frame stays below 10 milliseconds
    And no audio frames are dropped by voice detection
