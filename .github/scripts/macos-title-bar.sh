#!/usr/bin/env bash
# The macOS window has no title bar row (YN-90): its title bar lies over the
# page, and the system's window buttons stand at the toolbar's leading end,
# the close button's centre 24±1px from the window's top (the middle of the
# toolbar's 48px above its 1px border).
#
# Starts the built app (it opens its connection page), reads the window and
# its three buttons through the Accessibility API, as the system reports
# them, and checks them; resizes the window and checks again, since AppKit
# can put the buttons back where it keeps them (wry#1747); then takes a
# picture of the window, brought to the front at the screen's top left so
# that it is all on screen (a runner's screen can be narrower than the
# window opens). Writes geometry.json, title-bar.png and app.log to OUT, and
# a table to the step summary.
#
#   .github/scripts/macos-title-bar.sh APP OUT
set -euo pipefail
app=$1 out=$2
mkdir -p "$out"
exe="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
"$exe" >"$out/app.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

# The window and its buttons, one per line: name, x, y, width, height, in
# screen points from the top left.
geometry() {
  osascript - "$pid" <<'EOF'
on run argv
  set pid to (item 1 of argv) as integer
  tell application "System Events"
    set theWindow to window 1 of (first process whose unix id is pid)
    set {windowLeft, windowTop} to position of theWindow
    set {windowWidth, windowHeight} to size of theWindow
    set out to "window" & tab & windowLeft & tab & windowTop & tab & windowWidth & tab & windowHeight
    repeat with theButton in (buttons of theWindow)
      set theRole to ""
      try
        set theRole to subrole of theButton
      end try
      if theRole is in {"AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"} then
        set {buttonLeft, buttonTop} to position of theButton
        set {buttonWidth, buttonHeight} to size of theButton
        set out to out & linefeed & theRole & tab & buttonLeft & tab & buttonTop & tab & buttonWidth & tab & buttonHeight
      end if
    end repeat
    return out
  end tell
end run
EOF
}

shown=
for _ in $(seq 60); do
  if [ "$(osascript -e "tell application \"System Events\" to count windows of (first process whose unix id is $pid)" 2>/dev/null)" -ge 1 ] 2>/dev/null; then
    shown=1
    break
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
[ -n "$shown" ] || { cat "$out/app.log"; echo "::error::the app showed no window"; exit 1; }
# Let the connection page load and draw: wry places the buttons as it draws.
sleep 3
geometry >"$out/shown.tsv"
osascript - "$pid" <<'EOF'
on run argv
  set pid to (item 1 of argv) as integer
  tell application "System Events"
    tell (first process whose unix id is pid)
      set frontmost to true
      set position of window 1 to {0, 40}
      set size of window 1 to {1000, 700}
    end tell
  end tell
end run
EOF
sleep 2
geometry >"$out/resized.tsv"
read -r x y w h < <(awk -F'\t' '$1 == "window" { print $2, $3, $4, $5 }' "$out/resized.tsv")
screencapture -x -R"$x,$y,$w,$h" "$out/title-bar.png" || echo "::warning::screencapture could not take the window"

/usr/bin/python3 - "$out" <<'EOF'
import json, os, sys
out = sys.argv[1]
problems, report = [], {}
for name in ("shown", "resized"):
    rows = {}
    for line in open(os.path.join(out, f"{name}.tsv")):
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 5:
            rows[parts[0]] = [float(v.replace(",", ".")) for v in parts[1:]]
    window = rows.get("window")
    found = {"close": rows.get("AXCloseButton"), "minimize": rows.get("AXMinimizeButton"),
             "zoom": rows.get("AXFullScreenButton") or rows.get("AXZoomButton")}
    if not window or not all(found.values()):
        problems.append(f"{name}: found {sorted(rows)}, not the window and its three buttons")
        continue
    buttons = {key: {"x": b[0] - window[0], "y": b[1] - window[1], "width": b[2], "height": b[3],
                     "centreY": b[1] - window[1] + b[3] / 2} for key, b in found.items()}
    report[name] = {"window": {"x": window[0], "y": window[1], "width": window[2], "height": window[3]}, "buttons": buttons,
                    "zoomRight": buttons["zoom"]["x"] + buttons["zoom"]["width"]}
    centre = buttons["close"]["centreY"]
    if abs(centre - 24) > 1:
        problems.append(f"{name}: the close button's centre is {centre:g}px from the window's top, not 24±1")
    if not buttons["close"]["x"] < buttons["minimize"]["x"] < buttons["zoom"]["x"]:
        problems.append(f"{name}: the buttons are not close, minimize, zoom from the left")
json.dump({"report": report, "problems": problems}, open(os.path.join(out, "geometry.json"), "w"), indent=2)
lines = ["### Window buttons over the toolbar (YN-90)", "",
         "| When | Window, at | Close x, centre y | Minimize x | Zoom x, right edge | Button size |", "|---|---|---|---|---|---|"]
for name, r in report.items():
    b = r["buttons"]
    lines.append(f"| {name} | {r['window']['width']:g}×{r['window']['height']:g}, {r['window']['x']:g},{r['window']['y']:g} | {b['close']['x']:g}, {b['close']['centreY']:g} "
                 f"| {b['minimize']['x']:g} | {b['zoom']['x']:g}, {r['zoomRight']:g} | {b['close']['width']:g}×{b['close']['height']:g} |")
lines += ["", "Points from the window's top left (the window's own place: from the screen's), as the Accessibility API reports them."]
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as f:
        f.write("\n".join(lines) + "\n")
print("\n".join(lines))
for problem in problems:
    print(f"::error::{problem}")
sys.exit(1 if problems else 0)
EOF
