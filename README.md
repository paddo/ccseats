# ccseats

Run several Claude Code accounts side by side on one machine. macOS and Linux.

Each account is a "seat". Seats stay signed in at the same time, share one set of plugins, skills, settings and session transcripts, and show their remaining quota in one table. An optional picker starts each new session on the seat whose weekly headroom would otherwise expire first.

```
seat  email              5h   7d  fable  5h reset   7d reset   live  note
─────────────────────────────────────────────────────────────────────────
main  you@example.com    7%  39%    54%  Tue 04:30  Fri 18:00     3
work  work@example.com   0%  62%    92%  -          Thu 10:00     0
side  side@example.com   0%   0%     0%  -          Sun 15:00     0
```

One zsh script. On macOS it needs only what the system ships. On Linux it needs `zsh`, `jq` and `curl`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/paddo/ccseats/main/install.sh | sh
```

or

```sh
npm install -g ccseats
```

`jq` ships with macOS 15 and later. Elsewhere install it with brew, apt or dnf. Windows works through WSL.

## Quick start

```sh
ccseats init                              # seat "main" on your existing ~/.claude
ccseats add work --chrome "Profile 1"     # creates ~/.claude-work, linked to ~/.claude
ccseats work                              # starts claude on that seat. Run /login once.
ccseats status
```

Your existing `~/.claude` is not moved or changed. It becomes the first seat and the source of everything the other seats share. Add as many seats as you have accounts, and `ccseats remove <seat> --purge` takes one away again.

## Commands

| command | what it does |
|---|---|
| `ccseats init` | Create the config with seat `main` on `~/.claude` |
| `ccseats add <name> [--chrome "Profile 1"] [--max-weekly N]` | Create `~/.claude-<name>` and link the shared items |
| `ccseats remove <seat> [--purge]` | Forget a seat. `--purge` also deletes its directory and stored login |
| `ccseats status` | Usage table for every seat. Alias: `usage` |
| `ccseats pick` | Show the table and print the seat the picker would choose |
| `ccseats <seat> [claude args]` | Run `claude` on that seat |
| `ccseats [claude args]` | Run `claude` on the picked seat when `autoPick` is on, otherwise on the first seat |
| `ccseats chrome <seat>` | Open the Chrome profile mapped to that seat |
| `ccseats pair <seat>` | Pin the browser the seat is paired with now, labelled with the seat name |
| `ccseats statusline` | Seat name and remaining 5h, weekly and model budget, for a statusline script |
| `ccseats relink` | Recreate the shared symlinks and copy MCP servers into every seat |

Everything after the seat name goes to `claude` unchanged: `ccseats work --resume`.

A short alias is handy: `alias cl=ccseats`.

## How it works

**A seat is a config directory.** Claude Code reads `CLAUDE_CONFIG_DIR`. When it is set, the account file, settings, transcripts and credentials all live under that directory. On macOS the login goes into the Keychain under `Claude Code-credentials-<first 8 hex of sha256(dir)>`. On Linux it goes into `.credentials.json` inside the directory. Either way two directories hold two logins and both work at once. `ccseats <seat>` sets the variable and runs `claude`.

**Seats share almost everything.** `ccseats add` fills the new directory with symlinks into `~/.claude`:

- Directories: `projects` (transcripts, `--resume`, auto-memory), `plugins`, `skills`, `commands`, `agents`, `hooks`, `output-styles`, `scripts`, `file-history`, `plans`, `paste-cache`, `backups`, `downloads`, `uploads`, `teams`, `tasks`, `feedback`, `chrome`
- Files: `CLAUDE.md`, `settings.json`, `settings.local.json`, `keybindings.json`

It also copies your per-project trust and tool approvals into the new seat, so you are not re-prompted for every repository.

**What stays per seat, and why:**

- `.claude.json`: the signed-in account and the paired Chrome browser. It also holds MCP server registrations, so the file cannot be linked. Instead, each launch of a seat (and `ccseats relink`) merges the user and project MCP servers from `~/.claude.json` into the seat's file, `~/.claude.json` winning a name clash. Register a server once on the default seat and every seat gets it.
- `history.jsonl`: Claude Code refuses a symlinked or hard-linked history file, so prompt history is per seat.
- `sessions`, `session-env`, security state, telemetry, caches: per process or per account.

Because `settings.json` is shared, a `/model` or `/config` change applies to every seat.

**Do not run `/login` inside a seat to switch accounts.** It rewrites that directory's stored login and the seat now belongs to the other account. Start a session on the other seat instead.

## Usage data

`ccseats status` reads the same endpoint the `/usage` command reads, with each seat's own stored token. The `limits` array in the response holds the 5-hour session limit, the weekly limit for all models, and any weekly limit scoped to one model.

The endpoint answers 429 with a retry-after of several minutes when polled often. ccseats therefore keeps one cache file per seat, makes at most one request per seat every two minutes, and backs off for the full retry-after on a 429.

A seat that has been idle for hours has an expired access token. ccseats does not refresh tokens itself, because racing Claude Code on a rotating refresh token can sign a seat out. It shows the cached numbers instead. Those stay a safe upper bound, since an idle seat cannot use more quota, and a window whose reset time has passed counts as empty. The next session on that seat refreshes the token.

## The picker

Off by default. Set `"autoPick": true` in the config and a bare `ccseats` starts on the chosen seat and prints the table with the choice marked.

Rules:

1. Most weekly headroom per day left until the weekly reset. Headroom that is not used before the reset is lost, so a seat whose week ends tomorrow goes before a seat with more headroom and five days left. Headroom counts whichever is tighter: the all-models week (up to the weekly threshold or `maxWeekly`) or the model bucket.
2. On a tie: lowest 5-hour usage, then fewest live sessions.
3. A seat is skipped when it is locked, when its 5-hour, weekly or model usage is at or over its threshold, or when its weekly usage is at or over its own `maxWeekly`.
4. When every seat is at or over a threshold, the picker takes the one with the lowest 5-hour usage. A locked or capped seat is never picked.

`maxWeekly` is optional. It takes a seat out of the running once its week reaches that percentage, which keeps a reserve on that account for work you start on it directly.

## Config

`~/.config/ccseats/config.json`

```json
{
  "seats": {
    "main": { "dir": "~/.claude", "chrome": "Default" },
    "work": { "dir": "~/.claude-work", "chrome": "Profile 1", "device": "d102d8b0-763b-46a5-b4d9-6412db83484f" },
    "side": { "dir": "~/.claude-side", "chrome": "Profile 2", "maxWeekly": 85 }
  },
  "model": "Fable",
  "autoPick": false,
  "thresholds": { "session": 90, "weekly": 90, "model": 85 }
}
```

`device` is set by `ccseats pair`. `model` is the display name of the model whose weekly bucket the picker also checks, as it appears in `/usage`. Seat order in the file is the display order.

## Statusline

`ccseats statusline` prints the seat name and the remaining budget: 5-hour session, weekly across all models, and the weekly limit of the configured model (`f` for Fable):

```
work 5h 93% w 61% f 46% left
```

It never waits on the network. A stale cache starts a background refresh and the previous values show. Call it from your statusline script:

```sh
printf " | %s" "$(ccseats statusline)"
```

## Claude Code mod

The `plugin/` folder is a Claude Code mod (Claude Code 2.1.287 or later). It runs inside the session and adds:

- `/seats`: a pane with 5h, weekly and model meters for every seat, and the time to each reset. `●` marks this session's seat, `★` the seat the picker would choose.
- A band above the prompt when this seat is over a picker threshold.
- Handoff. A digit in the pane resumes this conversation on that seat in a new tab, as `ccseats <seat> --resume <id> --fork-session`. The seats share `projects/`, so the transcript is already there.
- Handoff to Codex or Grok (`c`, `g`). Those tools cannot read a Claude transcript, so Claude first writes a handoff brief over its own cached transcript to `~/.cache/ccseats/handoffs/`. The other agent starts with that brief.

Install it once. The seats share `plugins/` and `settings.json`, so every seat gets it:

```sh
claude plugin marketplace add paddo/ccseats
claude plugin install ccseats@ccseats
```

New tabs open in herdr, tmux, WezTerm and kitty. kitty needs `allow_remote_control` in `kitty.conf`. In any other terminal the command goes to the clipboard (`pbcopy`, `wl-copy` or `xclip`), or into the transcript when no clipboard tool exists.

The mod reads only the local usage caches, so it adds no requests to the usage endpoint. The first turn on a new seat is not cached, because the prompt cache belongs to one account.

## Claude in Chrome

One Chrome profile per seat keeps every account signed in with no re-pairing.

1. `ccseats chrome <seat>` opens the mapped Chrome profile (`google-chrome` or `chromium` on Linux). Install the Claude extension in it and sign in to claude.ai with that seat's account.
2. In a session on that seat, run `/chrome` and pick that browser.
3. `ccseats pair <seat>` saves that browser's id in the config. From then on every launch of the seat writes it back before Claude Code starts, labelled with the seat name, so the pairing cannot drift and `/chrome` shows `work` instead of "Browser 1".

Things worth knowing:

- Every Chrome window with the extension shows up in every seat's `/chrome` list. Nothing checks the account at selection time. The pinned id is what keeps seats apart.
- Windows are called "Browser 1" by default, and two of them look the same in the `/chrome` list. If you cannot tell them apart, ask Claude in that session to "switch browser and let me pick it in Chrome". That sends a Connect prompt to every window, and the one you accept in is the one that gets paired. Then run `ccseats pair`.
- To move a seat to a different window, run `/chrome` in a session, pick the new one, and run `ccseats pair <seat>` again.

## Caveats

- This rests on Claude Code internals that are not documented: where the login is stored, the usage endpoint, and the shape of its response. A Claude Code release can change them. ccseats reports a clear note in the table when the response shape or the stored login no longer match.
- Developed and used daily on macOS with Claude Code 2.1.278. Linux support is tested in a container with a synthetic login, not yet with a real one. Reports welcome.
- No native Windows support. Use WSL.
- Use it for accounts you are entitled to use, such as a personal and a work subscription. Check your plan terms before using the picker to spread one person's work across several subscriptions.

## License

MIT
