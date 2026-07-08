---
name: project-futuriq-video-system
description: FuturIQ's YouTube content system uses a multi-agent pipeline (offer-architect, content-angle-strategist, conversion-system-builder) to turn one video concept into offer, angle, and conversion assets
metadata:
  type: project
---

FuturIQ (creator, audience = coaches/consultants/creators/service providers overwhelmed by AI tooling) produces videos where a live Claude Code multi-agent "Revenue Agent Team" is built on screen. The video itself is never the product — the Revenue Agent Team template/workshop/service is. Full brand context lives in `business-brief.md` at the project root (audience, voice, constraints — read this first every time).

Pipeline observed so far: offer-architect defines the value ladder (free video -> lead magnet -> workshop/template purchase -> premium done-with-you service) and flags weak spots (e.g. urgency scored 2/5 on the teddy-bear demo video because the demo niche has no natural urgency). content-angle-strategist defines the video title and the exact recap/CTA beat and timestamp window. conversion-system-builder (this agent) then has to build the lead magnet + CTA + follow-up + sales path from those two upstream outputs.

**Why:** When urgency is structurally weak in the underlying niche/demo, the conversion-system-builder has to manufacture urgency through mechanics (limited cohort seats, launch-window pricing, "free for first N downloads this week") rather than through the content itself.

**How to apply:** Always check the offer-architect's stated weak spots before designing the CTA/follow-up sequence — if urgency is flagged low, bake structural urgency into the lead magnet delivery and the follow-up sequence's later emails (workshop cohort close dates, pricing windows), not into the in-video CTA script itself (which should stay helpful/low-pressure per FuturIQ voice).

Related: [[reference-business-brief]]
