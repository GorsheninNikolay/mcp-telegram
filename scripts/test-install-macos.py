#!/usr/bin/env python3
"""Hermetic installer checks: fake build commands, real temporary files, no launchd."""
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import tomllib
from unittest.mock import patch

script = Path(__file__).with_name('install-macos.py')
revision = 'a' * 40
original = b'model = "preserve-me"\n[mcp_servers.existing]\ncommand = "untouched"\n'
class Archive:
    def __init__(self, *args, **kwargs):
        self.stdout = io.BytesIO()
    def wait(self):
        return 0

def case(failure=None):
    with tempfile.TemporaryDirectory(prefix='telegram-install-test-', dir='/private/tmp') as directory:
        home = Path(directory)
        config = home / '.codex/config.toml'
        config.parent.mkdir()
        config.write_bytes(original)
        read_count = 0
        read_bytes = Path.read_bytes
        write_text = Path.write_text
        def read(path):
            nonlocal read_count
            if path == config:
                read_count += 1
                if failure == 'readback' and read_count == 2:
                    with config.open('ab') as output:
                        output.write(b'\n# concurrent unrelated edit\n')
            return read_bytes(path)
        def write(path, value, *args, **kwargs):
            if failure == 'prepare' and path.name == 'login-local.sh':
                raise OSError('injected local login script write failure')
            return write_text(path, value, *args, **kwargs)
        def git(command, **kwargs):
            return revision + '\n' if 'rev-parse' in command else b''
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)
        with patch.dict(os.environ, {'HOME': directory}), patch.object(sys, 'argv', [str(script), '--revision', revision, '--node', '/usr/bin/true']), patch('subprocess.check_output', git), patch('subprocess.Popen', Archive), patch('subprocess.run', run), patch.object(Path, 'read_bytes', read), patch.object(Path, 'write_text', write):
            try:
                runpy.run_path(str(script), run_name='__main__')
                assert failure is None
            except (OSError, RuntimeError):
                assert failure is not None
        assert not any('launchctl' in command for command in calls)
        plist = home / 'Library/LaunchAgents/io.github.GorsheninNikolay.telegram-mcp.plist'
        if failure:
            expected = original + (b'\n# concurrent unrelated edit\n' if failure == 'readback' else b'')
            assert read_bytes(config) == expected
            assert not plist.exists()
        else:
            data = tomllib.loads(read_bytes(config).decode())
            assert data['model'] == 'preserve-me'
            assert data['mcp_servers']['existing']['command'] == 'untouched'
            telegram = data['mcp_servers']['telegram']
            assert telegram['default_tools_approval_mode'] == 'writes'
            assert telegram['tools'] == {name: {'approval_mode': 'approve'} for name in ['telegram-send-message', 'telegram-send-file']}
            assert revision in telegram['args'][0]
            assert telegram['args'][1] == 'client'
            assert plist.exists()
for failure in [None, 'prepare', 'readback']:
    case(failure)
print('PASS: installer preserves settings, limits approvals, and rolls back own config/plist on prepare/readback failure')
