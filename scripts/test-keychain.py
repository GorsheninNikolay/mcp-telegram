#!/usr/bin/env python3
"""Exercise the real helper logic against a disposable, separately locked Keychain."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='telegram-keychain-test-', dir='/private/tmp') as directory:
    path = str(Path(directory) / 'isolated.keychain-db')
    binary = str(Path(directory) / 'helper')
    password = secrets.token_hex(24)  # Synthetic test password, not an account credential.
    subprocess.run(['swiftc', '-module-cache-path', '/private/tmp/telegram-mcp-swift-cache', '-DKEYCHAIN_INTEGRATION_TEST', str(root / 'native/keychain.swift'), '-framework', 'Security', '-o', binary], check=True, capture_output=True)
    subprocess.run(['security', 'create-keychain', '-p', password, path], check=True, capture_output=True)
    env = {'PATH': '/usr/bin:/bin', 'TELEGRAM_TEST_KEYCHAIN': path}
    account = 'session-' + secrets.token_hex(32)
    def call(operation, value=None, success=True):
        result = subprocess.run([binary], input=json.dumps({'operation': operation, 'account': account, 'value': value}), env=env, capture_output=True, text=True, timeout=10)
        assert not result.stderr
        if success:
            assert result.returncode == 0, operation + ' failed'
            return json.loads(result.stdout)['value']
        assert result.returncode != 0 and not result.stdout, 'must fail without disclosing a secret'
    try:
        assert call('load') is None
        call('save', 'synthetic-session')
        assert call('load') == 'synthetic-session'
        subprocess.run(['security', 'lock-keychain', path], check=True, capture_output=True)
        call('load', success=False)
        call('save', 'must-not-be-saved', success=False)
        recovery = subprocess.run(['security', 'unlock-keychain', '-p', password, path], capture_output=True, text=True)
        if recovery.returncode:
            raise RuntimeError('Isolated keychain unlock failed: ' + recovery.stderr.strip())
        assert call('load') == 'synthetic-session'
        call('delete')
        assert call('load') is None
        print('PASS: isolated Keychain save/reload, locked read/save denial, recovery and cleanup')
    finally:
        subprocess.run(['security', 'delete-keychain', path], check=True, capture_output=True)
