# Window decoration policy

## User requirement

The user explicitly selected **always hidden** native window decorations. This refines the desktop migration's window-management requirements; it does not remove tabs, editor tools or any existing window actions.

## Required behavior

- Application-owned primary windows have native decorations disabled from construction, without a visible native-titlebar flash. Do not reveal the OS titlebar on hover, focus, maximize, restore or fullscreen transitions.
- Keep the existing application tab header and editor interface. Provide accessible in-app minimize, maximize/restore and close controls, with platform-appropriate semantics and keyboard access.
- Provide an intentional draggable region without intercepting tabs, editor selection, buttons or other interactive controls. Preserve resizing and window-manager shortcuts; hiding decorations is not a requirement to remove resize borders or shadows.
- Respect existing close/minimize-to-tray preferences. Window controls must not bypass unsaved-work safeguards or close the wrong window.
- System-owned file dialogs, permission prompts and credential dialogs retain OS-controlled presentation. Do not imitate or suppress native security dialogs.
- Validate Linux (including Wayland where available), Windows and macOS separately. A Tauri configuration flag alone is not evidence of platform parity.

## Implementation status

The architecture probe now constructs its test window with decorations(false). It does not yet provide production custom window controls, and is not the completed desktop application. The production implementation remains part of the tauri-shell/native-integrations milestones.

## Acceptance evidence required

1. Query the native window's is_decorated state at startup and after maximize/restore/fullscreen transitions; it must remain false.
2. Check startup and restored appearance, preserving visible tabs and editor controls without a native titlebar.
3. Operate in-app controls using pointer and keyboard, and verify dragging/resizing and tray preferences on each OS.
4. Verify that system-owned security and file dialogs remain operable.
