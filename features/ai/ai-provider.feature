Feature: AI provider configuration

  As a user
  I want AI features to be entirely optional and swappable
  So that the application is fully useful offline and I am not locked to one vendor

  Transcription is local and mandatory. AI reasoning is remote and optional.
  Nothing in the recording path may depend on a provider being reachable.

  Background:
    Given the application is running in the tray

  @privacy
  Scenario: The application is fully functional with no provider configured
    Given no AI provider is configured
    When a session records, transcribes, saves, and is copied to the clipboard
    Then every step succeeds
    And no AI feature is offered
    And no network request is made

  @privacy
  Scenario: Transcription never depends on the network
    Given an AI provider is configured
    And the machine is offline
    When a session records and transcribes
    Then the transcript is produced
    And the session is saved
    And only the AI features are shown as unavailable

  Scenario: Configuring a provider enables AI features
    Given no AI provider is configured
    When the user configures the provider "deepseek" with a valid API key
    Then AI features become available
    And the configured model is shown

  Scenario Outline: Providers are interchangeable
    When the user configures the provider "<provider>" with model "<model>"
    And requests a summary of a session
    Then the summary is produced
    And the summary records which provider and model produced it

    Examples:
      | provider | model             |
      | deepseek | deepseek-chat     |
      | openai   | gpt-4o            |
      | anthropic| claude-opus-5     |

  Scenario: Switching providers does not invalidate stored output
    Given a summary was produced by "deepseek"
    When the user switches the provider to "openai"
    Then the existing summary is still readable
    And it still shows that "deepseek" produced it

  Scenario: An invalid key is reported at configuration time
    When the user configures a provider with an invalid API key
    Then the key is validated with a lightweight request
    And the failure is reported immediately
    And the invalid key is not stored

  Scenario Outline: Provider failures are surfaced, never silent
    Given an AI provider is configured
    And the provider responds with "<failure>"
    When the user requests a summary
    Then the user is shown "<message>"
    And the transcript is unaffected

    Examples:
      | failure       | message                                   |
      | 401           | authentication failed, check your API key |
      | 429           | rate limited, try again shortly           |
      | 500           | the provider had an error, try again      |
      | network error | could not reach the provider              |

  Scenario: A rate-limited request is retried once with backoff
    Given the provider responds with 429 and then succeeds
    When the user requests a summary
    Then the request is retried after the indicated delay
    And the summary is produced

  Scenario: Long AI responses stream
    Given an AI provider is configured
    When the user requests a summary of a 45 minute session
    Then response text appears progressively
    And the request can be cancelled while it streams

  Scenario: Cancelling stops the request
    Given a summary request is streaming
    When the user cancels it
    Then the request to the provider is aborted
    And no partial summary is saved

  @privacy
  Scenario: Only transcript text leaves the machine
    Given an AI provider is configured
    When the user requests a summary
    Then the request contains transcript text
    And the request contains no audio data
    And the request contains no data from other sessions

  @privacy
  Scenario: Nothing is sent without an explicit action
    Given an AI provider is configured
    And auto-summary is disabled
    When a session records and finishes
    Then no request is made to the provider
