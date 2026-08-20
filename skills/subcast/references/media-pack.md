# Media Pack

The current generic media pack is a ZIP with redacted source identity:

- `manifest.json`: recipe, hash, duration, counts, and artifact names.
- `transcript.md`: timestamped transcript.
- `subtitles.srt`: subtitle export from the same cues.
- `summary.md` and `chapters.md`: cached Insights when available.
- `sources.json`: cue-level evidence map and source IDs.
- `deliverable.md`: compact archive overview.

Use `sources.json` to cite claims. Report timestamp plus source ID when an answer depends on a specific statement. Do not include long transcript excerpts in the final response.

The media pack contains no original filename or source path by design. Preserve that property in derivative output.

For `creator-brief`, `deliverable.md` includes chapter-backed clip candidates. For `meeting-notes`, it includes review candidates, cited discussion points, and a follow-up agenda; it deliberately does not invent owners, deadlines, or decisions.
