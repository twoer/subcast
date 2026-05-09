// Restart recovery: any 'running' task that was active before this Nitro
// process started gets demoted to 'queued', then the queue picks the next one
// up. Combined with the chunks table this implements §5 "重启恢复" + §3
// "断点续传" walking-skeleton-of-resume.
import { getDb } from '../utils/db';
import { transcribeQueue } from '../utils/queue';

export default defineNitroPlugin(async () => {
  const db = getDb();
  db.prepare(`UPDATE transcribe_tasks SET status='queued' WHERE status='running'`).run();
  await transcribeQueue.tryStartNext();
});
