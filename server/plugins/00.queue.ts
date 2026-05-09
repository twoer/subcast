// Restart recovery for both queues. Any 'running' task is demoted to 'queued';
// the queue then picks the next one. Translation has no chunk-level resume
// (single-shot per spec §5), so a running translate task restarts from
// scratch — but its progress is independent and short.
import { getDb } from '../utils/db';
import { transcribeQueue, translateQueue } from '../utils/queue';

export default defineNitroPlugin(async () => {
  const db = getDb();
  db.prepare(`UPDATE transcribe_tasks SET status='queued' WHERE status='running'`).run();
  db.prepare(`UPDATE translate_tasks SET status='queued', progress_pct=0 WHERE status='running'`).run();
  await transcribeQueue.tryStartNext();
  await translateQueue.tryStartNext();
});
