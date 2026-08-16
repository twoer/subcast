# Translation & AI Summaries

Translation and summaries run on a local Qwen3 model (llama.cpp), fully offline.

## Translation

1. Open a video and pick a target language;
2. The local model translates segment by segment with live progress;
3. Switch between original / translated / bilingual subtitles in the player — cached languages switch instantly.

Any target language works; each language is cached once, so replays never re-translate.

## AI summaries

Click "AI Insights" and the local LLM streams:

- **Summary**: the key points;
- **Chapters**: clickable chapter markers for jumping around.

The summary language follows the UI language (zh / en).

## Privacy

Translation and summary requests go only to the in-process llama-server on 127.0.0.1 — never over the network.
