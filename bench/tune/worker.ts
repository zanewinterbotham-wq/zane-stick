import { parentPort } from 'node:worker_threads';
import { evaluate } from './evaluate';

parentPort!.on('message', async (m: { id: number; gains: Record<string, number> }) => {
  try {
    const r = await evaluate(m.gains);
    parentPort!.postMessage({ id: m.id, ...r });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, score: 1e6, parts: { error: 1 }, err: String(e) });
  }
});
