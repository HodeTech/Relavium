# MVP-11 frames

The concept frames that [MVP-11](../mvp-11.md) refers to. They are drawings composed on the CLI's real grid (80×24 unless the name says otherwise) and rendered in a browser with a monospace font; they are **not** screenshots of the application, so glyph widths, dimming and overlay behaviour on a real terminal are what MVP-11's Step 1 must prove. They are UI mock-ups the maintainer asked for on 2026-11-24, not architecture diagrams, so [documentation-style §8](../../../standards/documentation-style.md#8-architecture-docs-lead-with-a-diagram) allows them as PNG files in a folder named after the phase document; every flow and topology in the MVP itself is Mermaid. Where a frame and the text of the MVP differ, the text governs; [Appendix C](../mvp-11.md#appendix-c--frame-index) lists the known differences.

| File | Shows |
|---|---|
| `home-empty-80x24.png`, `home-empty-100x30.png` | The empty Home |
| `home-populated-80x24.png`, `home-parked-focus-80x24.png` | The populated Home with the prompt first; focus in the strip |
| `onboarding-keyless-home-80x24.png` | The Home with no provider key |
| `onboarding-popup-provider-80x24.png`, `onboarding-popup-key-80x24.png` | The first-run setup popup, steps 1 and 2 |
| `palette-landing-80x24.png` | The Home palette in its new order |
| `palette-chat-80x24.png` | A chat's palette, opening above the prompt |
| `chat-idle-80x24.png` | A chat at rest, with the speaker marker |
| `sheet-file-approval-80x24.png`, `sheet-command-approval-80x24.png` | The approval sheets |
| `sheet-question-80x24.png` | The agent's question, with its rule label and gutter |
| `sheet-checkpoint-80x24.png`, `sheet-gate-home-80x24.png` | The continue checkpoint; a run gate on the Home |
| `popup-inspect-diff-80x24.png`, `popup-details-list-80x24.png` | The approval's full diff and `/details` as the inspection popup |
| `popup-doctor-landing-80x24.png`, `popup-doctor-consent-80x24.png` | `/doctor` opened from the Home; the deep check's consent line |
| `popup-mode-chat-80x24.png` | `/mode` in a chat |
| `popup-models-step1-80x24.png`, `popup-models-step2-80x24.png` | `/models`, both steps |
| `popup-permissions-chat-80x24.png` | `/permissions` in a chat |
| `popup-resume-home-80x24.png` | `/resume` over the Home |
| `popup-run-step2-80x24.png` | `/run`, step 2 of 3 |
| `popup-wide-120x36.png` | A popup keeps its width on a large terminal |
| `popup-inline-fallback-80x24.png` | The inline form of a popup |

Part of [phases/](../README.md).
