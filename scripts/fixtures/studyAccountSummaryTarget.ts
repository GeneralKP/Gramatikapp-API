import assert from 'node:assert/strict';

const fixtureName = /^study_account_summary_tests_\d+_[a-f0-9]{12}$/;
/** Reject unsafe input before loading application configuration or connecting. */
export function studyAccountSummaryTarget(uri: string, name: string) {
  assert.match(name, fixtureName, 'Use a unique study-account fixture database');
  assert.equal(uri, uri.trim(), 'Reject whitespace around fixture targets');
  const target = new URL(uri);
  assert.equal(target.protocol, 'mongodb:');
  assert.equal(target.hostname, '127.0.0.1', 'Use a single numeric loopback host');
  assert.ok(!target.username && !target.password && !target.hash, 'Reject credentials and fragments');
  assert.ok(target.pathname === '' || target.pathname === '/' || fixtureName.test(target.pathname.slice(1)), 'Reject nonfixture databases');
  for (const [key, value] of target.searchParams) assert.ok(key === 'directConnection' && value === 'true', 'Reject connection options other than directConnection=true');
  target.pathname = `/${name}`;
  target.searchParams.set('directConnection', 'true');
  return target.toString();
}
