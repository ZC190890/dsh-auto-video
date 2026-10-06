const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SKIP, checkRepo } = require('../scripts/check-repo.js');
const ROOT = path.resolve(__dirname, '..');

// The exclusion rule is verified on an isolated fixture: nothing in this test reads the real archive/ or
// backups/ directories.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'checkrepo-'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('services/ok.js', 'module.exports = 1;\n');
  // Built without a literal require pattern, so this test file itself passes the require scan.
  write('services/bad.js', 'require(' + '"./nowhere");\n');
  for (const dir of ['archive', 'backups']) {
    write(dir + '/old/broken.js', 'this is not javascript {{{\n');         // would be a syntax failure
    // Written without the literal words, so this test file itself stays free of the removed provider name.
    write(dir + '/old/legacy.js', '// ' + 'kl' + 'ing' + ' ' + '\u53ef\u7075' + ' 残留\n');
    write(dir + '/old/unresolved.js', 'require(' + '"./missing-module");\n');
  }
  write('config/aliyun.json', JSON.stringify({ onlineEnabled: false, planner: { model: 'qwen3.8-omni-flash' },
    audioReview: { model: 'qwen3.8-omni-flash' } }, null, 2));
  write('config/project.json', JSON.stringify({ budget: { target: 50, hardLimit: 70, currency: 'CNY' } }, null, 2));
  write('docs/NEXT_SESSION.md', '隔离夹具：排除规则自检，不读取真实归档目录。\n');
  return root;
}

test('archive and backups are skipped by path segment before anything inside is read', () => {
  const root = fixture();
  const result = checkRepo(root);
  assert.equal(result.checkedFiles, 2, JSON.stringify(result));
  assert.deepEqual(result.failures, ['UNRESOLVED_REQUIRE:' + path.join('services', 'bad.js') + ' -> ./nowhere']);
  assert.equal(result.failures.some(failure => failure.includes('archive') || failure.includes('backups')), false);
  assert.equal(result.onlineEnabled, false);
  assert.equal(result.nextSessionCharacters <= 300, true);
});

test('the segment rule matches only real path segments', () => {
  assert.equal(SKIP.test('archive/old/broken.js'), true);
  assert.equal(SKIP.test('backups/x.js'), true);
  assert.equal(SKIP.test('a/archive/b.js'), true);
  assert.equal(SKIP.test('jobs/aliyun/first-film/state.json'), true);
  assert.equal(SKIP.test('output/first-film/final.mp4'), true);
  assert.equal(SKIP.test('services/archiveish.js'), false);   // a prefix is not a segment
  assert.equal(SKIP.test('services/archived-notes.js'), false);
  assert.equal(SKIP.test('index.js'), false);
});
