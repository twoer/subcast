# Local LLM Benchmarks

This folder holds small synthetic fixtures and content-free benchmark reports for local LLM model checks.

Run a dry-run report:

```bash
node scripts/benchmark-llm-models.mjs
```

Run installed local models through `llama-server`:

```bash
node scripts/benchmark-llm-models.mjs --run --models=8b --model-dir=.dev-userdata/models/llm
```

Write a report:

```bash
node scripts/benchmark-llm-models.mjs --models=8b --write
```

Reports may be committed only when they contain safe metadata:

- model id
- task kind
- fixture id and fixture hash
- duration
- token counts
- JSON validity
- score
- error class

Reports must never contain raw prompt text, transcript text, model output, local filesystem paths, or downloaded model URLs.

The script defaults to a dry-run safe report and supports `--run` for installed local models. Reports keep the same content-free contract in both modes.
