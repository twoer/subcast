# Failure Handling

| Status phase | Meaning | Response |
| --- | --- | --- |
| `media_missing` | The imported media is unavailable. | Re-import the user-approved local path. |
| `transcribe_needed` | No transcript exists. | Start the transcription SSE stream. |
| `transcribe_pending` | Transcription is active or queued. | Wait and poll; do not start duplicates. |
| `transcribe_failed` | Latest transcription failed. | Report the redacted error code and ask before retrying. |
| `insights_needed` | Required language-specific Insights are missing. | Start the Insights SSE stream. |
| `insights_pending` | Insights are queued or active. | Wait and poll; do not start duplicates. |
| `insights_failed` | Latest Insights run failed. | Report the redacted error code and ask before retrying. |
| `bundle_ready` | Required inputs exist. | Export the supported media pack. |

Do not treat an HTTP 401 as a media failure. It means the agent connection is not authorized. Do not ask users to paste an Electron session token into chat; the product needs its explicit agent-access pairing flow.

