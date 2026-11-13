#!/usr/bin/env python3
"""Install this reviewed commit locally; never authenticate or send messages."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import tomllib

parser = argparse.ArgumentParser()
parser.add_argument('--revision', required=True)
parser.add_argument('--node', required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent

def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
if args.revision != revision or len(revision) != 40:
    raise SystemExit('Exact checked-out SHA required')
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=source).strip():
    raise SystemExit('Refusing to install a dirty checkout')
node = Path(args.node).resolve(strict=True)
if not node.is_file():
    raise SystemExit('Invalid Node executable')
home = Path.home()
app = home / '.local/share/telegram-mcp'
release = app / 'releases' / revision
state = home / 'Library/Application Support/TelegramMCP/state'
label = 'io.github.GorsheninNikolay.telegram-mcp'
plist = home / 'Library/LaunchAgents' / (label + '.plist')
config = home / '.codex/config.toml'
def check_ancestors(path):
    for component in [path, *path.parents]:
        if component.is_symlink():
            raise SystemExit('Refusing symlink installation path')
        if component.exists() and component.is_dir() and component != Path('/'):
            mode = component.stat().st_mode
            if mode & 0o022 and not mode & 0o1000:
                raise SystemExit('Installation ancestor is writable by other OS users')

for path in [app, release, state, home / 'TelegramMCP/Outbox', home / 'TelegramMCP/Inbox', plist, config]:
    check_ancestors(path)
if plist.exists() or release.exists():
    raise SystemExit('Existing installation found; inspect it before updating')
config_before = config.read_bytes()
if 'telegram' in tomllib.loads(config_before.decode()).get('mcp_servers', {}):
    raise SystemExit('Existing telegram config must be reviewed, not overwritten')
# All prerequisites checked before modifying global settings.
for path in [app, state, home / 'TelegramMCP', home / 'TelegramMCP/Outbox', home / 'TelegramMCP/Inbox']:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
block = None
agent = None
config_written = False
try:
    release.mkdir(mode=0o700, parents=True)
    archive = subprocess.Popen(['git', 'archive', revision], cwd=source, stdout=subprocess.PIPE)
    run(['tar', '-x', '-C', str(release)], stdin=archive.stdout)
    archive.stdout.close()
    if archive.wait() != 0:
        raise SystemExit('git archive failed')
    npm = str(node.parent / 'npm')
    env = dict(os.environ, PATH=f'{node.parent}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    for command in [[npm, 'ci', '--ignore-scripts', '--cache', '/private/tmp/telegram-mcp-install-cache'], [npm, 'run', 'build:native'], [npm, 'run', 'build'], [npm, 'prune', '--omit=dev', '--ignore-scripts', '--cache', '/private/tmp/telegram-mcp-install-cache']]:
        run(command, cwd=release, env=env)
    session = str(state / 'session')  # Namespace only; the secret is never written here.
    base_env = {'HOME': str(home), 'PATH': f'{node.parent}:/usr/bin:/bin', 'MCP_TELEGRAM_MODE': 'messaging', 'TELEGRAM_SESSION_PATH': session, 'TELEGRAM_LOG_LEVEL': 'none'}
    agent = {'Label': label, 'ProgramArguments': [str(node), str(release / 'dist/cli.js'), 'serve'], 'EnvironmentVariables': base_env, 'WorkingDirectory': str(release), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'Umask': 0o077, 'StandardOutPath': str(state / 'daemon.log'), 'StandardErrorPath': str(state / 'daemon.log')}
    plist.parent.mkdir(parents=True, exist_ok=True)
    with plist.open('xb') as output:
        plistlib.dump(agent, output)
    plist.chmod(0o600)
    # Read approvals remain default; only the two requested sends bypass client prompts.
    quote = json.dumps
    block = '\n# telegram-mcp managed installation ' + revision + '\n[mcp_servers.telegram]\ncommand = ' + quote(str(node)) + '\nargs = ' + json.dumps([str(release / 'dist/cli.js'), 'client']) + '\ndefault_tools_approval_mode = "writes"\n'
    block += '\n[mcp_servers.telegram.env]\n' + ''.join(f'{key} = {quote(value)}\n' for key, value in base_env.items())
    for tool in ['telegram-send-message', 'telegram-send-file']:
        block += f'\n[mcp_servers.telegram.tools.{tool}]\napproval_mode = "approve"\n'
    receipt = {'revision': revision, 'release': str(release), 'plist': str(plist), 'config_sha256_before': hashlib.sha256(config_before).hexdigest(), 'config_block': block, 'authenticated': False}
    (app / 'installation.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (app / 'installation.json').chmod(0o600)
    # Login runs only in the user's own local terminal, never through captured tool output.
    import shlex
    command = ['/usr/bin/env', '-i'] + [f'{key}={value}' for key, value in base_env.items()] + [str(node), str(release / 'dist/cli.js'), 'login']
    login = '#!/bin/sh\nset -eu\n' + shlex.join(command) + '\nlaunchctl bootstrap "gui/$(id -u)" ' + shlex.quote(str(plist)) + '\n'
    (app / 'login-local.sh').write_text(login)
    (app / 'login-local.sh').chmod(0o700)
    updated = config_before + block.encode()
    parsed = tomllib.loads(updated.decode())
    assert len(parsed['mcp_servers']['telegram']['tools']) == 2
    with config.open('rb') as current:
        fcntl.flock(current, fcntl.LOCK_EX)
        if current.read() != config_before:
            raise SystemExit('Codex config changed concurrently; installation is not activated')
        fd, temporary = tempfile.mkstemp(dir=config.parent, prefix='.telegram-config-')
        with os.fdopen(fd, 'wb') as output:
            output.write(updated)
        os.chmod(temporary, 0o600)
        os.replace(temporary, config)
        config_written = True
    if config.read_bytes() != updated:
        raise RuntimeError('Codex configuration readback mismatch')
    if plist.read_bytes() != plistlib.dumps(agent):
        raise RuntimeError('LaunchAgent readback mismatch')
    print(json.dumps({'revision': revision, 'installed': True, 'daemon_started': False, 'login_command': str(app / 'login-local.sh')}))
except BaseException:
    if block is not None and config_written:
        current = config.read_bytes()
        owned = block.encode()
        if current.count(owned) == 1:
            fd, temporary = tempfile.mkstemp(dir=config.parent, prefix='.telegram-rollback-')
            with os.fdopen(fd, 'wb') as output:
                output.write(current.replace(owned, b'', 1))
            os.chmod(temporary, 0o600)
            os.replace(temporary, config)
        else:
            print('Installation failed; telegram config changed externally. Disable only mcp_servers.telegram manually.')
    if agent is not None and plist.exists() and plist.read_bytes() == plistlib.dumps(agent):
        plist.unlink()
    # Preserve release/state and Keychain. No daemon has been started by this installer.
    raise
