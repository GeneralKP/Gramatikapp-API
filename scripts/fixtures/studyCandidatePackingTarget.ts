import assert from 'node:assert/strict';

const fixtureName = /^study_candidate_packing_tests_\d+_[a-f0-9]{12}$/;
/** Validate before application configuration is loaded or any connection/write. */
export function studyCandidatePackingTarget(uri: string, name: string) {
  assert.match(name, fixtureName, 'Use a unique candidate-packing fixture database');
  assert.equal(uri, uri.trim(), 'Reject whitespace around fixture targets');
  const target = new URL(uri);
  assert.equal(target.protocol, 'mongodb:');
  assert.equal(target.hostname, '127.0.0.1', 'Use a single numeric loopback host');
  assert.ok(!target.username && !target.password && !target.hash, 'Reject credentials and fragments');
  assert.ok(target.pathname === '' || target.pathname === '/' || fixtureName.test(target.pathname.slice(1)), 'Reject nonfixture databases');
  for (const [key, value] of target.searchParams) assert.ok(key === 'directConnection' && value === 'true', 'Only directConnection=true is allowed');
  target.pathname = `/${name}`;
  target.searchParams.set('directConnection', 'true');
  return target.toString();
}
