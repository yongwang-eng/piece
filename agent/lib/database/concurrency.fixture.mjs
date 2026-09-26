import { parentPort, workerData } from 'node:worker_threads';
import { openCrewStore } from './store.ts';
const s = openCrewStore(workerData.path);
parentPort.once('message', () => {
  try {
    if (workerData.mode === 'claim') {
      try { parentPort.postMessage({ owner: s.claimMain(workerData.agentId, workerData.instanceId) }); }
      catch (error) { if (!/already owned/.test(error.message)) throw error; parentPort.postMessage({ refused: true }); }
    } else {
      const main = s.ensureMain('main-session');
      const ids = [];
      for (let i = 0; i < 8; i++) {
        const c = s.createCrew(workerData.owner, { slug: 'shared-label', goal: 'Concurrent registration' });
        const w = s.registerWorker(workerData.owner, c.id, { name: 'same-name', profile: 'reviewer' });
        ids.push({ crew: c.id, agent: w.id });
      }
      parentPort.postMessage({ main: main.id, ids });
    }
  } finally { s.close(); }
});
parentPort.postMessage({ ready: true });
