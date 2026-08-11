Feature: Translation

  As someone in a call held in a language I read slowly
  I want the transcript translated
  So that I can follow along and re-read afterwards

  Translation never replaces the original. The transcript of record is always
  what was actually said.

  Background:
    Given an AI provider is configured
    And a session exists titled "Kundengespräch" with language "de" and the transcript:
      """
      Der Kunde kann sein Passwort nicht zurücksetzen.
      Wir sollten das Ticket eskalieren.
      """

  Scenario: Translating a finished transcript
    When the user translates "Kundengespräch" to "en"
    Then a translation is produced
    And it is stored alongside the original
    And the original German segments are unchanged

  Scenario: Viewing original and translation together
    Given a translation of "Kundengespräch" into "en" exists
    When the user views the session with translation shown
    Then each segment shows its original text and its translation
    And timestamps come from the original segments

  Scenario: Translation preserves segment boundaries
    Given the session has 2 segments
    When the user translates it to "en"
    Then the translation has 2 segments
    And each translated segment maps to exactly one original segment

  Scenario: Translating to the transcript's own language is refused
    When the user translates "Kundengespräch" to "de"
    Then no request is made to the provider
    And the user is told the transcript is already in that language

  Scenario: Live translation appears as segments commit
    Given live translation to "en" is enabled
    And a session is recording in German
    When a segment commits
    Then its translation appears in the floating window within 3 seconds
    And the original text remains visible

  Scenario: A failed live translation does not interrupt the transcript
    Given live translation to "en" is enabled
    And the provider is unreachable
    When a segment commits
    Then the original segment is shown and persisted
    And the translation is shown as unavailable for that segment
    And the session continues

  Scenario: A translated transcript can be copied
    Given a translation of "Kundengespräch" into "en" exists
    When the user copies the translation
    Then the clipboard contains the English text
    And the clipboard does not contain the German text

  Scenario: Retranslating replaces the previous translation for that language
    Given a translation of "Kundengespräch" into "en" exists
    When the user translates it to "en" again
    Then the session has exactly 1 English translation

  Scenario: A session may hold translations in several languages
    Given a translation of "Kundengespräch" into "en" exists
    When the user translates it to "fr"
    Then the session has an English translation and a French translation
    And both remain readable
