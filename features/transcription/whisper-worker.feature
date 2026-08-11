@slow
Feature: Faster-Whisper worker

  As the application
  I want speech recognition to run in a separate Python process
  So that a model stall, a CUDA error, or a segfault cannot take down the UI or lose the recording

  Electron talks to the worker over a line-delimited JSON protocol on stdio.
  The worker owns the model; the app owns the queue.

  Background:
    Given the Python worker executable is available
    And the model "turbo" is present in the models directory

  @mvp
  Scenario: The worker starts and reports readiness before work is queued
    When the worker is started
    Then the worker reports its state as "ready" within 60 seconds
    And the readiness report names the loaded model and the compute device

  @mvp @gpu
  Scenario: The GPU is used when available
    Given a CUDA-capable GPU is available
    When the worker is started
    Then the compute device is "cuda"
    And the compute type is "float16"

  Scenario: CPU fallback is automatic and visible
    Given no CUDA-capable GPU is available
    When the worker is started
    Then the compute device is "cpu"
    And the compute type is "int8"
    And the user is told that transcription is running on CPU and will be slower

  @mvp
  Scenario: A speech segment is transcribed and returned as JSON
    Given the worker is ready
    When a speech segment from the fixture "single-utterance-4s.wav" is submitted
    Then a transcript result is returned containing:
      | field       |
      | text        |
      | start_ms    |
      | end_ms      |
      | confidence  |
      | language    |
    And the text matches the reference transcript with a word error rate below 0.15

  Scenario: Work is queued in order and never lost
    Given the worker is ready
    When 5 speech segments are submitted faster than they can be processed
    Then 5 transcript results are returned
    And the results are returned in submission order

  Scenario: A worker crash restarts without losing the session
    Given a session is recording
    And 3 segments have been committed
    When the worker process exits unexpectedly
    Then the worker is restarted
    And the session continues recording
    And the 3 committed segments are intact
    And audio buffered during the restart is transcribed once the worker is ready

  Scenario: Repeated crashes stop the retry loop
    Given the worker fails to start 3 times consecutively
    When a fourth start is attempted
    Then no further automatic restart is attempted
    And the user is shown the worker's error output
    And recording continues so that audio is not lost if "save audio" is enabled

  Scenario: A missing model is reported before recording starts
    Given the configured model file is absent
    When the worker is started
    Then startup fails with a reason naming the missing model
    And the user is offered the option to download it
    And the hotkey does not start a session until a model is available

  Scenario Outline: Model selection trades speed for accuracy
    Given the configured model is "<model>"
    When the worker is started
    Then the loaded model is "<model>"
    And the model's expected real-time factor is documented as "<speed>"

    Examples:
      | model    | speed        |
      | turbo    | fastest      |
      | large-v3 | most accurate|

  Scenario: Changing the model reloads the worker between sessions
    Given the worker is ready with model "turbo"
    And no session is recording
    When the user changes the model to "large-v3"
    Then the worker reloads with model "large-v3"
    And the user is shown progress while the model loads

  Scenario: A model change is deferred while recording
    Given a session is recording with model "turbo"
    When the user changes the model to "large-v3"
    Then the running session continues on "turbo"
    And the change applies to the next session

  Scenario: The worker is terminated on application quit
    Given the worker is running
    When the application quits
    Then the worker process is terminated
    And no orphaned Python process remains
