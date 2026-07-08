# The Revenue Agent Team Starter Kit

The exact 4-agent Claude Code system that turned "giant teddy bears" into a positioned offer, a YouTube angle, and a follow-up sequence — in one live run, no editing.

## What this proves

Most AI content shows you a clever prompt. This is different: it's a **team of four specialists**, each one only good at one job, that hand work to each other in order. You give it one raw business idea. It gives you back research, an offer, a content angle, and a sales funnel — as four separate documents, not one blurry answer.

It's been run on two completely different business types already (an e-commerce product and a local appointment-based service) and it adapted its reasoning both times instead of reusing the same template. See `annotated-teddy-bear-run.md` in this kit for the full breakdown of *why* it made the calls it made.

## What's inside this kit

| File | What it's for |
|---|---|
| `agents/` | The four agent files, ready to copy into your own project |
| `setup-guide.md` | Get it running in about 10 minutes |
| `annotated-teddy-bear-run.md` | The full teddy bear demo, with commentary explaining the reasoning behind every step |
| `swap-in-worksheet.md` | The exact prompts to run your own business idea through the same pipeline |

## Quick start

1. Read `setup-guide.md` and copy the four files into your project.
2. Restart Claude Code so it picks up the new agents.
3. Open `swap-in-worksheet.md` and swap in your own business idea.
4. Run the four agents in order: research → offer → content → conversion.

## The one rule

Don't let one agent try to do everything. The reason this works better than asking one AI chat to "help me with my business" is that each agent only sees its own job — a researcher doesn't try to write your sales copy, and your sales copy writer doesn't try to score your market opportunity. Keeping the jobs separate is what keeps the output sharp instead of generic.
