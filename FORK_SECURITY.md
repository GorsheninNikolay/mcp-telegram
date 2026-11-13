# Personal fork security policy

This fork targets native macOS stdio/Unix IPC. It is private and is not published
to npm. Install an exact reviewed Git commit with `npm ci --ignore-scripts` and
the committed npm lockfile. Build native helpers with `npm run build:native`.

## Session and credentials

The production SessionStore uses macOS Keychain through a small Security.framework
Swift helper. API credentials and MTProto sessions travel on private stdin/stdout
pipes, never argv. No plaintext SessionStore or legacy-session import is provided.
Missing, locked, unavailable or denied Keychain does not enable file fallback.
Save failure is fatal; login verifies the account before saving and verifies a
fresh session reload before reporting success. 2FA is entered without echo in the
local terminal. The daemon and Codex config require no secret environment variables.

The helper uses the user's login Keychain; OS prompts are confirmed locally by
the user. This is encryption at rest, not isolation from malicious code running
as the same OS user. The MTProto authorization grants Telegram account access;
server policy, not Telegram, limits the available tools.

## Tools and IPC

The default remains `read-only`: nine reviewed text/status tools. Optional numeric
chat scope is supported only in this mode. `messaging` adds exactly
`telegram-send-message`, `telegram-send-file`, and `telegram-download-media`.
Administrative tools, authentication over IPC, translation, web previews, inline
profile downloads and new upstream tools are absent. Explicit `full` is retained
for development and must not be used by the native installation.

The owner removes forbidden registry entries and validates every IPC tool argument
with its Zod schema. The build fingerprint and canonical tool policy must match
before any tool request. Old servers and mismatching policies fail closed. The
native client entrypoint never promotes itself to session owner. One daemon or
local login holds an OS flock through a pipe-owned native helper. The lock inode
is never unlinked for stale recovery; the kernel releases it on owner death.

After a send timeout/disconnection the result is unknown. No application-level
new send is retried automatically. Read the destination history before deciding
whether to send again. GramJS may retry the same RPC RequestState/randomId for
transport recovery; this is not a new application send. Telegram-side deduplication
and delivery are not established by local fake-client tests.

## Files

Default upload directory: `~/TelegramMCP/Outbox`. Default download directory:
`~/TelegramMCP/Inbox`. The messaging tools ignore file-root overrides. URL inputs,
hidden paths, symlinks, multiple hardlinks and credential inodes are refused.
Uploads use a bounded snapshot validated from an open descriptor, at most 50 MiB;
GramJS receives the memory buffer rather than reopening the input path. Downloads
are bounded and written through an exclusive descriptor without reopening or
replacing the destination. Partial files may remain on a failed write.

Another program with the same OS identity can swap parent directories or directly
access Keychain and process memory. This native configuration does not claim to
isolate that adversary. Dedicated exchange directories are not a general credential
scanner; the user should put only intended outgoing files in Outbox.

## Dependency audit

The production graph pins Hono 4.13.14 and @hono/node-server 2.1.5, the newest
versions available in the configured registry during this change. The audit still
flags Hono HTTP CSRF/form validation/mount/router handling, JSX escaping, body
prototype pollution and CORS/Vary handling; node-server flags HTTP path parsing,
static serving and WebSocket upgrade handling. Some duplicate advisories declare
all versions vulnerable. No unreviewed downgrade or forced audit fix is applied.

These findings are unreachable in the installed native profile: it has no HTTP
listener, Hono app, form/body parser, JSX renderer, CORS middleware, HTTP router,
static server or WebSocket upgrade handler. `transport-boundary.test.ts` rejects
loading either HTTP package while importing the native owner/client/login modules
and registering the actual messaging tools. Do not reuse this exception for an
HTTP transport or hosted/container entrypoint. Re-audit before dependency changes.

## Validation and installation

Run lint, typecheck, all tests, native/TypeScript builds, docs build and CI. Tests
use fake Telegram clients and synthetic files/stores; they never send real messages
or authenticate a real account. Keychain integration tests use only disposable
synthetic records and must clean them up. Fault injection tests cover denied storage and failed saves without fallback.
`scripts/test-keychain.py` tests real locked read/save denial and unlock/reload
against a separately created disposable Keychain, without locking the user's
login Keychain. The helper permits system prompts only for local TTY login.

`scripts/install-macos.py --revision <SHA> --node <absolute-node-path>` refuses a
dirty checkout, existing installation or existing `telegram` configuration. It
installs that commit in a separate release directory, preserves other Codex
settings and writes one LaunchAgent without starting it before login. Only the
two send tools receive Codex `approval_mode = "approve"`; downloads retain the
client write-approval policy. Administrator requirements may still override this.

Run the generated `~/.local/share/telegram-mcp/login-local.sh` in your own local
terminal. Do not paste QR tokens, API credentials, 2FA or sessions into chat. The
script starts the daemon only after successful local login. Live acceptance still
requires reload, two Codex sessions, daemon restart and the requested chat read.
Real test sends require a separate explicit request.

On failed installation, disable only `mcp_servers.telegram` and stop only the new
LaunchAgent. Retain its state and Keychain records for recovery. Removing local
records does not revoke the session at Telegram; revocation is a separate action.
