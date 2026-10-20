#!/usr/bin/env python3
"""T-34 lab: T-18's typing lab (acceptance/typing/lab.py) on its own port and
data, so T-18's measurements and lab stay untouched.

  lab.py start WEB_DIR   fresh fixture (80 finished Turns on "Long", two more
                         Agents), Core left running on 4434 serving WEB_DIR
  lab.py serve WEB_DIR   restart Core on the same fixture with another UI build
  lab.py stop
Data under target/t34/lab of this checkout; never 4317 or its data.
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("typing_lab", ROOT / "acceptance/typing/lab.py")
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
# The module reads these at call time.
lab.LAB = ROOT / "target/t34/lab"
lab.BIN = ROOT / "target/t34/bin/yuzuno-workspace-main-release"
lab.PORT = 4434
lab.BASE = f"http://127.0.0.1:{lab.PORT}/api"

if __name__ == "__main__":
    if sys.argv[1] == "start":
        lab.start(sys.argv[2])
    elif sys.argv[1] == "serve":
        lab.serve(sys.argv[2])
    else:
        lab.stop()
