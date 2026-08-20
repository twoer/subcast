# Recipes

Choose the smallest recipe that satisfies the request.

| Request | Recipe | Required state | Final result |
| --- | --- | --- | --- |
| Transcribe, archive, subtitle export, basic summary | `generic-archive-pack` | transcript | media pack with transcript, SRT, sources, chapters, and cached summary when available |
| Clip ideas, editing guidance, creator brief | `creator-brief` | transcript and matching-language Insights | timestamped candidates and chapter outline for human review |
| Meeting notes, actions, decisions | `meeting-notes` | transcript and matching-language Insights | evidence-first notes, discussion points, and follow-up agenda |

Use `zh-CN` when the user requests Chinese output; otherwise use `en`. A cached Insight in another language does not satisfy an Insights recipe.

For meetings, list a decision, owner, or deadline only when the transcript makes it explicit. For clip suggestions, include a start timestamp and explain the hook/payoff using cited cues.
