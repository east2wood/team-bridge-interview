Feature: Settings

  As a user
  I want the application configured to my machine and my habits
  So that it stays out of the way

  Settings persist to disk immediately on change. Secrets never go to the same
  place as preferences.

  Background:
    Given the application is running in the tray

  Scenario: Defaults are usable without configuration
    Given the application has never been configured
    Then the audio source is "system"
    And the microphone is disabled
    And the language is "auto"
    And the model is "turbo"
    And GPU acceleration is "auto"
    And auto-save is enabled
    And auto-copy is disabled
    And AI features are disabled

  Scenario: Changes persist across restarts
    When the user sets the language to "de"
    And the application restarts
    Then the language is "de"

  Scenario Outline: Audio settings
    When the user sets "<setting>" to "<value>"
    Then the setting takes effect for the next session
    And the change is persisted

    Examples:
      | setting           | value           |
      | output device     | Headphones      |
      | microphone device | Yeti Nano       |
      | microphone        | enabled         |

  Scenario: The device list reflects currently attached hardware
    Given "USB Interface" is attached
    When the user opens audio settings
    Then "USB Interface" appears in the output device list
    When "USB Interface" is detached
    Then it no longer appears in the list
    And a session using it falls back to the default device

  Scenario: GPU acceleration can be forced off
    Given a CUDA-capable GPU is available
    When the user sets GPU acceleration to "off"
    Then the transcription worker runs on CPU
    And the user is warned that transcription will be slower

  Scenario: GPU setting is ignored when no GPU exists
    Given no CUDA-capable GPU is available
    When the user opens settings
    Then GPU acceleration is shown as unavailable with the reason
    And the setting cannot be enabled

  Scenario: Model selection warns about download size
    When the user selects the model "large-v3"
    And the model is not present locally
    Then the download size is shown before the download starts
    And the download can be cancelled

  Scenario: Theme applies immediately
    When the user sets the theme to "dark"
    Then the overlay and all windows render in the dark theme without a restart

  Scenario: Theme follows the system by default
    Given the theme is "system"
    When the operating system switches to dark mode
    Then the application switches to the dark theme

  Scenario: Disabling auto-save keeps nothing
    Given auto-save is disabled
    When a session finishes
    Then the session is not written to history
    And the user is offered a one-time chance to save or copy it

  @privacy
  Scenario: An API key is stored encrypted and never shown again
    When the user enters an AI provider API key
    Then the key is stored encrypted with the operating system credential store
    And the key is not written to the preferences file
    And the settings screen shows only the last 4 characters

  @privacy
  Scenario: The renderer cannot read the API key
    Given an AI provider API key is configured
    When the renderer requests the settings
    Then the response contains no API key material

  Scenario: Removing the key disables AI features
    Given an AI provider API key is configured
    When the user removes the key
    Then AI features are disabled
    And the stored key is deleted from the credential store

  Scenario: A corrupt settings file falls back to defaults
    Given the settings file on disk is not valid JSON
    When the application starts
    Then defaults are used
    And the corrupt file is preserved alongside as a backup
    And the user is told that settings were reset
