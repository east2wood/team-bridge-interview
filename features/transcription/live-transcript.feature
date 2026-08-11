Feature: Live transcript stream

  As a user watching a conversation happen
  I want text to appear while people are still talking
  So that the transcript is useful during the call and not only after it

  Partials are provisional and disposable. Segments are committed and
  persisted. The UI shows both; storage only ever sees segments.

  Background:
    Given the transcription worker is ready
    And a session is recording

  @mvp
  Scenario: Text appears while the speaker is still talking
    Given the fixture "monologue-90s.wav" is playing
    When 10 seconds of audio have been captured
    Then transcript text is visible in the floating window
    And the session is still recording

  Scenario: A partial is replaced by its committed segment
    Given a speech segment is being transcribed
    When a partial result "so the deploy went" is emitted
    Then the floating window shows "so the deploy went" marked as provisional
    When the segment commits as "So the deploy went out at four."
    Then the provisional text is replaced by the committed text
    And the committed text is marked as final

  @privacy
  Scenario: Partials are never persisted
    Given 4 partials have been emitted for a speech segment
    When the segment commits
    Then storage contains exactly 1 segment for that speech segment
    And no partial text is recoverable from storage

  Scenario: Segments arrive in chronological order
    Given the fixture "standup-30s.wav" is playing
    When the session runs to completion
    Then every segment's start offset is greater than or equal to the previous segment's start offset
    And no two segments overlap on the same channel

  Scenario: Timestamps are relative to the session start
    Given the fixture "two-utterances-2s-gap.wav" is playing
    When the session runs to completion
    Then the first segment starts within 500 milliseconds of 0
    And each segment's end offset is greater than its start offset

  Scenario: Language is detected once and reused
    Given the language setting is "auto"
    And the fixture "standup-30s.wav" is playing
    When the first segment commits
    Then the detected language is recorded on the session
    And subsequent segments reuse the detected language without re-detecting

  Scenario: An explicit language overrides detection
    Given the language setting is "de"
    And the fixture "standup-30s.wav" is playing
    When the session runs to completion
    Then no language detection is performed
    And the session language is "de"

  Scenario: Low-confidence segments are marked, not hidden
    Given the fixture "noisy-speech-15s.wav" is playing
    When a segment commits with a confidence below 0.5
    Then the segment is persisted
    And the segment is visually marked as low confidence

  Scenario: Hallucinated output on silence is suppressed
    Given the fixture "silence-20s.wav" is playing
    When the session runs to completion
    Then no segment is committed
    Because voice detection emitted no speech segment

  Scenario: Channels are visually distinguished
    Given microphone capture is enabled
    And both channels contain speech
    When segments commit on both channels
    Then segments from the "system" channel are labelled distinctly from the "microphone" channel

  Scenario: A backlog is drained without dropping transcript
    Given transcription has fallen 8 seconds behind live audio
    When audio capture stops
    Then the queued speech segments are all transcribed
    And the session is not finalised until the queue is drained
    And the user is shown that transcription is still catching up
