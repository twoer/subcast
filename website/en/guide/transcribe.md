# Transcription Engines

Subcast ships two local transcription engines. The default `auto` mode dispatches by audio language.

## Engine comparison

| | SenseVoice | Whisper |
|---|---|---|
| Languages | zh / en / ja / ko / yue | 99 languages |
| Speed | ~15x faster on CPU | Slower (worse with bigger tiers) |
| Chinese accuracy | Excellent | Mediocre at lower tiers |
| Cue granularity | Sentence-level (VAD segments) | Word-level timestamps |
| Model size | 250 MB (bundled) | 77 MB – 1.6 GB (on demand) |

## Auto dispatch

The default mode. At the start of each task, the opening seconds are sampled and the language voted on:

- **Chinese / Japanese / Korean** → SenseVoice (language locked for the task — fast and accurate);
- **English** → Whisper if its model is installed (word-level timestamps), otherwise SenseVoice locked to English.

One language per task — no mixed-language transcripts. The resolution is recorded in the task history (e.g. `auto → sensevoice`).

## Manual pinning

Settings → Models → Transcription engine lets you pin `SenseVoice` or `Whisper`.

## Also included

- **VAD chunking**: Silero VAD pre-segments audio so only actual speech is processed — 30–50% faster on long videos;
- **Resume**: interrupted tasks pick up where they stopped;
- **Re-transcribe**: after switching engines or models, re-run any existing video with one click.
