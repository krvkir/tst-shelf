## ADDED Requirements

### Requirement: Clicking the audio indicator toggles the tab's mute state
The extension SHALL toggle the muted state of the shelved tab when the user clicks its icon's audio indicator with the primary button, and SHALL NOT activate the tab instead.

#### Scenario: Clicking the sound indicator mutes the tab
- **WHEN** the user clicks the sound indicator of a playing shelved tab
- **THEN** the tab becomes muted, its icon switches to the muted indicator, and the tab does not become the active tab

#### Scenario: Clicking the muted indicator unmutes the tab
- **WHEN** the user clicks the muted indicator of a muted shelved tab
- **THEN** the tab is unmuted and its icon's indicator follows its audio state again

#### Scenario: Clicking the icon outside the indicator still selects the tab
- **WHEN** the user clicks a shelf icon on its favicon, away from the audio indicator
- **THEN** the shelved tab activates, exactly as before
