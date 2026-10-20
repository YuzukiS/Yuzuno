#!/usr/bin/env python3
"""Choose the offline package lab, the explicit signed-in browser workflow, or
the staged checks of a final candidate."""
import argparse
from pathlib import Path
import runpy
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('workflow', choices=['package', 'authenticated', 'first_use', 'candidate'])
args = parser.parse_args(sys.argv[1:2])
sys.argv = [sys.argv[0], *sys.argv[2:]]
# Adjacent harness helpers are explicit inputs even with PYTHONSAFEPATH=1.
sys.path.insert(0, str(Path(__file__).resolve().parent))
runpy.run_path(str(Path(__file__).with_name(args.workflow + '_lab.py')), run_name='__main__')
