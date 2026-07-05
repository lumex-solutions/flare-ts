# Installing skills

Each subfolder here is one skill, laid out exactly as a Claude Code skills directory expects
(`<skill-name>/SKILL.md`), so installing is a direct copy of the skill's folder. Skills expect to
run inside the flare-ts repo (they read the standards by repo-relative path).

**Claude Code** - copy the skill's folder into `.claude/skills/` in the repo (project scope) or
`~/.claude/skills/` (user scope). Invoke with `/<skill-name> <path>`, or let it trigger from its
description.

**Cursor** - copy the body of the skill's SKILL.md (below the frontmatter) into
`.cursor/rules/<skill-name>.mdc`, with frontmatter `description: <the description from SKILL.md>`
and `alwaysApply: false`, so the agent picks it up when relevant or you attach it with `@`.

**GitHub Copilot** - save the body of the skill's SKILL.md as
`.github/prompts/<skill-name>.prompt.md`. In Copilot Chat run `/<skill-name>` and pass the target
path in the message.
