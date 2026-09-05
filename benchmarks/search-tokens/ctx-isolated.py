#!/usr/bin/env python3
"""Run the pinned ctx release with isolated, opt-in-only local state.

Examples:
  python3 ctx-isolated.py import --provider claude --path /private/tmp/.../projects --progress none --format json
  python3 ctx-isolated.py search migration --events --limit 10 --backend lexical --refresh off --format json

Set CTX_BENCHMARK_DATA to a fresh canonical directory to isolate separate corpora.
The importer requires permission to create a local Unix domain socket; reads do not.
"""
import os
from pathlib import Path
import subprocess
import sys

root = Path(os.environ.get('BENCHMARK_ROOT', '/tmp/glia-search-benchmark')).resolve()
state = Path(os.environ.get('CTX_BENCHMARK_DATA', str(root / 'ctx-benchmark-data'))).resolve()
home = root / 'ctx-benchmark-home'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
home.mkdir(parents=True, exist_ok=True, mode=0o700)
config = state / 'config.toml'
if not config.exists():
    config.write_text('''[analytics]
enabled = false
[local_usage]
enabled = false
[upgrade]
auto = "off"
[indexing]
mode = "manual"
[sources]
automatic = false
[search]
semantic = false
''')
environment = {
    'PATH': '/usr/bin:/bin',
    'HOME': str(home),
    'CTX_DATA_ROOT': str(state),
    'CTX_ANALYTICS_ENABLED': 'false',
    'CTX_LOCAL_USAGE_ENABLED': 'false',
    'CTX_UPGRADE_AUTO': 'off',
    'TZ': 'UTC',
    'NO_COLOR': '1',
}
command = [str(root / 'ctx-bin'), '--color', 'never', *sys.argv[1:]]
sys.exit(subprocess.call(command, env=environment, cwd=root))
