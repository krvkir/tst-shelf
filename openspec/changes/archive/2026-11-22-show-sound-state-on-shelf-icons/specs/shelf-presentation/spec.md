## ADDED Requirements

### Requirement: A shelf icon shows its tab's audio state
The extension SHALL show a sound indicator on a shelf icon while the shelved tab plays audio, and a muted indicator while the tab is muted, using the active theme's text color and loading no network resource. The favicon SHALL stay visible while an indicator shows, and the indicator SHALL not displace the fold badge. While the tab is silent and unmuted, no audio indicator SHALL be shown.

#### Scenario: A playing tab shows the sound indicator
- **WHEN** a shelved tab plays audio
- **THEN** its shelf icon shows a sound indicator and keeps showing the tab's favicon

#### Scenario: A muted tab shows the muted indicator
- **WHEN** a shelved tab is muted
- **THEN** its shelf icon shows a muted indicator instead of the sound indicator

#### Scenario: A silent unmuted tab shows no indicator
- **WHEN** a shelved tab plays no audio and is not muted
- **THEN** its shelf icon shows no audio indicator

#### Scenario: The indicator follows the tab's state live
- **WHEN** audio starts or stops in a shelved tab, or its mute state changes
- **THEN** its shelf icon's indicator updates at the next strap re-render, without a restart
