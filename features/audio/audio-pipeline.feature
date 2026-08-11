Feature: Audio buffering, resampling, and mixing

  As the transcription engine
  I want a steady stream of 16 kHz mono PCM
  So that I can transcribe without caring where the audio came from

  Whisper wants 16 kHz mono. Devices deliver 44.1 or 48 kHz stereo. This layer
  is the only place that knows the difference.

  Background:
    Given the audio pipeline is configured for a 16000 Hz mono output

  @mvp
  Scenario Outline: Device formats are normalised to the pipeline format
    Given a capture stream at <rate> Hz with <channels> channels
    When 1 second of audio is captured
    Then the pipeline emits 16000 samples of mono 16-bit PCM
    And the resampled signal matches the source within a correlation of 0.98

    Examples:
      | rate  | channels |
      | 48000 | 2        |
      | 44100 | 2        |
      | 48000 | 1        |
      | 16000 | 1        |

  Scenario: Frames are emitted at a fixed size
    Given the pipeline frame size is 20 milliseconds
    When 1 second of audio is captured
    Then 50 frames are emitted
    And every frame contains 320 samples

  Scenario: System audio alone passes through unmixed
    Given microphone capture is disabled
    When system audio is captured
    Then the pipeline output is the system channel unmodified
    And no mixing is performed

  Scenario: Both channels are transcribed separately, not summed
    Given microphone capture is enabled
    When both channels are captured
    Then each channel is delivered to voice detection independently
    And each channel retains its label through to transcription

  Scenario: A mixed stream is produced only for level metering and monitoring
    Given microphone capture is enabled
    When both channels are captured
    Then a mixed stream is available for the level meter
    And the mixed stream is not used as transcription input

  Scenario: Channels are aligned to a common timeline
    Given microphone capture is enabled
    And system audio and microphone audio start 400 milliseconds apart
    When both channels are captured
    Then segment timestamps on both channels are relative to the session start
    And the two channels are aligned within 50 milliseconds

  Scenario: A slow consumer drops audio rather than growing without bound
    Given the buffer capacity is 10 seconds
    And the transcription consumer has stalled
    When 15 seconds of audio is captured
    Then the buffer holds at most 10 seconds
    And the oldest audio is dropped first
    And the dropped span is recorded as a gap in the session

  Scenario: A capture overrun is reported, not swallowed
    Given the capture device reports a buffer overrun
    When the pipeline receives the overrun
    Then the event is logged with the affected time range
    And the session records a capture interruption

  @privacy
  Scenario: PCM frames are not written to disk when recording is off
    Given "save audio" is disabled
    When 60 seconds of audio flows through the pipeline
    Then no PCM data is written to disk
    And no PCM data is written to a temporary file
