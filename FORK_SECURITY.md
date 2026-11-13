# Personal fork security policy

Base: upstream `v1.45.1`, commit `0fde882`. This is a personal fork, not an official
Telegram product or an independently certified client. It is not published to npm.

## Default mode

`MCP_TELEGRAM_MODE=read-only` is the default. The owner and each client register
only nine explicitly reviewed text/status/discovery tools. Authentication,
account mutations, media downloads/uploads, translation, web previews and other
tools are absent. A future upstream tool is denied until explicitly reviewed;
`readOnlyHint` is not a security policy.

To restrict reading to specific chats, configure:

```text
MCP_TELEGRAM_MODE=read-only
MCP_TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1001234567890
```

These are example IDs, not real fixtures. Use exact numeric Telegram chat IDs.
Aliases, usernames, names, empty lists and invalid modes are refused. With a
scope, global chat listing/search are removed and every chat-specific handler
checks the requested ID before accessing Telegram, then verifies the resolved
peer against the canonical marked ID before returning chat data. Numeric IDs
never fall back to matching chat titles. This applies to raw IPC as well as
stdio. Missing scope means all account chats are readable through the small
text-only tool set; an explicitly empty scope fails startup.

The daemon's policy is authoritative. A full-mode proxy cannot expand a
read-only owner's registry. Conversely, connecting to an older or full-mode
owner is not equivalent to starting a scoped read-only owner: all processes
sharing a session must use this fork and the intended owner configuration.
Stop the existing owner before changing its policy.

## Intentional full mode

`MCP_TELEGRAM_MODE=full` explicitly restores upstream tools and full account
capabilities. It cannot be combined with a chat scope, because not every write
tool has a single destination. Use client approvals in addition to server policy.

Local download/profile-photo tools are marked as writes, including variants
that can return an inline image. File upload uses upstream realpath and credential
checks; URL input to `telegram-send-file` is refused to avoid GramJS local fetches.
Upstream v1.45.1 already blocks hidden/session files and avoids replacing existing
downloads. This fork does not claim to have invented those fixes.

If full mode is necessary, set `MCP_TELEGRAM_FILE_DIRS` to a dedicated, otherwise
empty exchange directory. Upstream defaults otherwise permit ordinary files
under home/temp for upload and Downloads/Desktop/Documents/temp for download.
Do not treat hidden-file filtering as protection for every possible credential.

## IPC and authentication

IPC dispatch validates registered Zod input schemas, including defaults and
transforms, and rejects disabled, unknown and inherited registry properties.
Validation failures do not echo supplied values. Malformed tool envelopes are
discarded. The read-only owner also rejects the separate IPC QR-login route.

Authenticate explicitly through the local `login` CLI with the daemon stopped.
QR links, API credentials, 2FA passwords and session strings must not be put in
chat, captured tool output, screenshots, committed config or CI secrets.
Do not retain `TELEGRAM_2FA_PASSWORD` in a long-running server's environment.
No login or real Telegram operation is performed by the test suite.

## Remaining trust boundary

The session is still a full-account MTProto authorization key, stored locally in
plaintext with owner-only file permissions; this fork does not encrypt it.
Read-only/chat scope is enforced by this application, not by Telegram. Malicious
code in the process, a compromised dependency, or another process with the same
OS identity can read the key or bypass these checks. The Unix socket is protected
by filesystem permissions, not by isolation from the same OS user.

Use a separate OS identity or a non-root container with only its private session
volume and read-only configuration. Do not mount the home directory, SSH agent,
Docker socket or unrelated files. Keep the root filesystem read-only where
practical and use a newly created, separately revocable Telegram session. File
permissions and tool allowlists do not replace this isolation.

Message content remains untrusted data and may contain prompt injection. Even
with no Telegram write tools, an assistant might leak read content through a
different connector or shell command. Limit the chats and other tools available
in the same agent task. Removing all account-key exposure requires an offline
export workflow rather than a live personal-account connector.

## Maintenance and validation

Install from a reviewed commit with `npm ci --ignore-scripts`, then build from
source. Keep `package-lock.json`; do not substitute a floating `npx ...@latest`.
Review dependency updates separately. Upstream release/npm/registry/container/docs
publishing workflows are disabled for this fork; CI remains enabled. `private`
in package.json prevents accidental npm publication.

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and
`npm run docs:build`. Security regressions cover the actual SDK registry and raw
IPC dispatch with a fake Telegram service, plus upstream real-filesystem tests
for credential paths, links and download collisions. No live-account acceptance
is implied by these tests or by green CI.

## Dependency audit boundary

The initial production dependency audit reported three affected packages at
moderate severity (`hono`, `@hono/node-server`, and their dependent MCP SDK).
Available fixes in the advisory feed were not all available in the configured
registry at review time. No forced SDK downgrade or broad `audit fix` was applied.
The entrypoints in this fork use stdio and a local Unix socket/named pipe, not
Hono HTTP serving; this is not a proof that every dependency advisory is irrelevant.
Keep this finding open and recheck before enabling additional transports or
upgrading dependencies. A green test run is not a clean vulnerability audit.
