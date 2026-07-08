# Setup Guide (about 10 minutes)

You do not need to know how to code to do this. You're just copying files into the right folder.

## Step 1: Find or create your project folder

This is just the folder on your computer where you're working — could be empty, could already have files in it. Open a terminal and go there.

## Step 2: Create the agents folder

Claude Code looks for a specific folder to find custom agents: `.claude/agents/` inside your project. If it doesn't exist yet, create it:

```
mkdir -p .claude/agents
```

(`mkdir` means "make a new folder." `-p` just means "don't complain if part of this already exists.")

## Step 3: Copy the four agent files in

Copy all four `.md` files from this kit's `agents/` folder into your project's `.claude/agents/` folder. You can drag-and-drop them in Finder/Explorer, or run:

```
cp agents/*.md /path/to/your-project/.claude/agents/
```

(`cp` copies files. `*.md` means "every file ending in .md.")

## Step 4: Restart Claude Code

This is the one step people forget. Claude Code only checks for new agent files when it starts up — so close your current session and reopen it (close and reopen the terminal window, or the app). After restarting, the four agents will show up as available.

## Step 5: Write your own business brief

Create a file called `business-brief.md` in your project root describing your business: who your audience is, what you sell (or want to sell), your voice/tone, and any constraints. The agents read this first so they don't drift off-topic. Use `swap-in-worksheet.md` in this kit to fill this out fast.

## Step 6: Run the four agents in order

They depend on each other, so run them one at a time, in this order:

1. **market-signal-researcher** — feed it your business idea, it hands back research and a score.
2. **offer-architect** — feed it the research, it hands back a positioned offer.
3. **content-angle-strategist** — feed it the offer, it hands back titles/hooks/an outline.
4. **conversion-system-builder** — feed it the offer + content, it hands back a lead magnet, a CTA, and a follow-up sequence.

That's the whole system. One idea in, four documents out.
