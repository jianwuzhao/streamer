import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const file = process.argv[2];
assert.ok(file?.endsWith('.tgz'), 'Provide a package .tgz');
const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
for (const path of ['package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/broadcast-renderer.iife.js', 'lib/rigged-avatar.iife.js', 'client/client.js', 'cordis.patch.yml', 'config/default.yaml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'client/assets/dsh-pet/LICENSE', 'client/assets/rigged-avatar/LICENSE-three.txt']) {
  assert.ok(entries.includes('package/' + path), 'Missing ' + path);
}
if (process.platform === 'darwin') assert.ok(entries.includes('package/lib/DafeiyuBroadcast.app/Contents/MacOS/DafeiyuBroadcast'), 'Missing native window');
assert.deepEqual(entries.filter(path => /(?:^|\/)(?:data|node_modules|credentials|\.git|\.env)(?:\/|$)|\.db(?:-|$)/.test(path)), [], 'Private/runtime data in package');
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }));
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.repository.url, 'git+https://github.com/jianwuzhao/streamer.git');
console.log(`Verified ${manifest.name}@${manifest.version}: ${entries.length} files, required entrypoints present, runtime data excluded.`);
