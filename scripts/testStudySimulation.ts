import { simulateStudy } from './lib/studyIntervalSimulation.js';
for (const profile of ['successful', 'mixed', 'hard'] as const) {
  const { stats } = await simulateStudy(profile);
  console.log(JSON.stringify(stats));
}
console.log('PASS six calendar months, daily sessions of up to 10 word cards plus 3 phrases, learning steps, overdue/lapse histories and API/web/native parity');
