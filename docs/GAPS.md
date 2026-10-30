# Pimu vs Muse vs Grok Bot

What these products have that Pimu doesn't, and what we plan to do about each one. Pimu's boundary stays the same: it is a thin, self-hosted shell around one user's `pi` CLI on one machine. It has no cloud VM of its own, no connector marketplace, and no multi-user mode.

Sources (2026-10):

- Meta Muse: [Help: get started](https://www.meta.com/help/superintelligence/1331373868832401/), [Connectors](https://www.meta.com/help/superintelligence/1687253048996149/), [Play Store listing](https://play.google.com/store/apps/details?id=com.facebook.aura), [Connect 2026](https://www.meta.com/blog/meta-connect-2026-everything-we-announced/)
- Grok Bot: [Overview](https://docs.x.ai/grok-bot/overview), [Skills & routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Pages](https://cursor.com/help/grok-bot/pages), [Work with Grok Bot](https://cursor.com/docs/grok-bot/work)

Recommendations: **do** = small and fits Pimu, worth building next. **later** = useful, but wait until someone needs it. **never** = outside Pimu's scope.

| Feature | Muse | Grok Bot | Pimu now | Rec. | Why |
|---|---|---|---|---|---|
| Multiple named assistants | One Muse plus side chats | Many Bots, each with its own memory | Bots, each one a pi session with a persona | — | Done in V4/V5. |
| Not turn-by-turn (message while it works) | ✓ | ✓ | steer / followUp queue | — | pi RPC already supports it. |
| Background work, keeps going after close | ✓ (cloud VM) | ✓ (cloud computer) | pi runs on the server; tasks run on a cron | — | Runs whenever the server is up. |
| Scheduled routines | Reminders, "Upcoming" | Routines (schedule) | Tasks with cron, can target a Bot | — | Done in V2. |
| Event triggers (webhook, email, GitHub…) | Some connectors push events | Slack, GitHub, Linear, email, webhook | ✗ | **do** (webhook only) | One `POST /api/tasks/{id}/trigger` with a per-task secret. Covers most other triggers through external glue. |
| Meaningful-only notifications | "Notifies when something needs attention" | Comes back when approval is needed | Telegram on task done or failed | **do** | Let a task decide whether to notify, using a `NOTIFY:` marker in the final reply. Cheap and cuts noise. |
| Approval before sensitive actions | ✓ per connector | ✓ | pi extension UI dialogs (confirm/select) | later | Needs a policy extension. pi's tool guards already cover the dangerous cases. |
| Activity log | Full activity log | Run history | "活动" tab per session plus task runs | **do** (global) | One page merging task runs and recent tool calls across Bots. Data already exists. |
| Persistent memory | ✓ | ✓, per Bot | Global AGENTS.md plus per-Bot persona | later | A per-Bot memory file under the Bot's cwd works today. Add UI only if it gets used. |
| Skills | — | Saved from tasks, shared across Bots | pi skills, viewable in Settings | **do** (light) | Add a "保存为 skill" action that writes `~/.pi/agent/skills/<name>/SKILL.md` from a chat. |
| Pages / canvas (rich artifacts) | Library of artifacts | Pages: reports, dashboards, share links | Markdown in chat; files in uploads | later | Serving a generated HTML file from the session's cwd is cheap, but sharing and auth add scope. |
| Connectors (Gmail, Calendar…) | Dozens, plus OAuth vault | Account-wide apps, OAuth held off-box | pi MCP servers (Settings → MCP) | never (as a marketplace) | MCP is the connector story. Pimu only shows it and toggles it. |
| Voice input | Real-time voice mode | Dictate, voice chat | Web Speech dictation (zh-CN) | later | Real-time duplex voice needs a speech model. Not KISS. |
| Voice memos / spoken replies | ✓ | Voice memos | ✗ | later | `speechSynthesis` "read aloud" on a message is about 10 lines. Add it if asked. |
| Mobile app | iOS/Android | iOS/Android | Installable PWA | — | The PWA is enough. A native app is never in scope. |
| Own email inbox | Coming | ✓, routes can trigger | ✗ | never | Needs mail hosting. A webhook from any mail service covers it. |
| Desktop / browser use | Mac computer use | Cloud desktop plus browser | Playwright MCP (headless) | — | Done in V3. Full desktop control is out of scope. |
| Bots talking to each other / group chat | — | ✓ | ✗ | later | A Bot can already call `pi` itself. Make it first-class only if workflows need it. |
| Customizable personality | ✓ | ✓ | Persona, name, identicon | — | Done. |
| Secure credential vault | Secure VM keeps passwords from the agent | OAuth tokens off-box | Keys in env/`!command`; masked in UI | never | A single-user, self-hosted box. Use the OS keychain or env vars. |
| Usage / cost view | Usage limits | Usage page | ✗ | later | pi `get_session_stats` has tokens and cost. A small per-Bot line would be cheap. |

## Top 5 next

1. Webhook trigger for tasks.
2. Meaningful-only notifications via a reply marker.
3. Global activity page.
4. "Save as skill" from a chat.
5. Per-Bot usage line from `get_session_stats`.
