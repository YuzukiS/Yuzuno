# Taskbar badge pictures

The Windows taskbar shows Home's "needs you" count on Yuzuno's button with these pictures (YN-43). The user chose the design on 2026-11-08: a soft cream speech bubble with a dark brown outline. Windows 11 puts it over the top-right corner of the icon, so its tail points down-left at the character (YN-101, chosen on 2026-11-13). Windows 10 puts it at the lower-right, where the tail points below the icon. Windows decides the corner ([../../README.md](../../README.md#taskbar-and-dock-badge-windows-macos)).

- `badge-<size>-<label>.png`: sizes 16, 20, 24 and 32 px, the small-icon size at 100, 125, 150 and 200% display scaling. Labels `1`–`9`, and `9plus` for ten and more. At 0 there is no badge.
- The digits are drawn pixel by pixel at 16 and 20 px, with rounded strokes at 24 and 32 px. They were checked at real size on light and dark taskbars. The files are the approved ones turned upside down, with the digits put back upright, so the tail points down instead of up (YN-101). Every pixel comes from the approved files. Change them only with a new design decision.
- [`../../src/badge_rules.rs`](../../src/badge_rules.rs) maps a count and a display scale to one of these files, and its tests check that every file is the size its name says. [`../../src/badge.rs`](../../src/badge.rs) puts it on the taskbar.
