"""PyInstaller entry point. Keep tiny: all logic lives in farewatch_engine."""
import sys

from farewatch_engine.cli import main

if __name__ == '__main__':
    sys.exit(main())
