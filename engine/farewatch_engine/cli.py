"""Command line used by the Tauri app (sidecar) and for manual tests.

  farewatch-engine selftest            -> one JSON line, checks bundled data
  farewatch-engine lookup < request    -> JSON lines (see lookup.py)
  add --watch-stdin to stop on a 'cancel' line or closed stdin (desktop app)
"""
import json
import os
import sys
import threading

from . import ENGINE_VERSION


def _emit(event):
    sys.stdout.write(json.dumps(event, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def _watch_stdin():
    """Exit at once on a 'cancel' line or when the app closes our stdin.

    Used by the desktop app. Killing a PyInstaller one-file exe on Windows can
    leave its inner process running, so the app asks it to stop this way.
    """
    def watch():
        for line in sys.stdin:
            if line.strip() == 'cancel':
                break
        os._exit(130)
    threading.Thread(target=watch, daemon=True).start()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass
    command = argv[0] if argv else ''
    if command == 'selftest':
        from .airports import airport_count
        _emit({'type': 'selftest', 'version': ENGINE_VERSION, 'airports': airport_count()})
        return 0
    if command == 'lookup':
        try:
            request = json.loads(sys.stdin.readline() or 'null')
        except ValueError:
            _emit({'type': 'fatal', 'message': 'Request is not valid JSON.'})
            return 2
        if '--watch-stdin' in argv:
            _watch_stdin()
        from .lookup import run_lookup
        return run_lookup(request, _emit)
    _emit({'type': 'fatal', 'message': 'Usage: farewatch-engine selftest | lookup'})
    return 2


if __name__ == '__main__':
    sys.exit(main())
