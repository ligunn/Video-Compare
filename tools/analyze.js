'use strict';
// Headless diagnostics: node tools/analyze.js <file> [file...]   (add --json for raw output)
const { analyzeFile } = require('../src/main/analyzer');

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node tools/analyze.js <file> [file...] [--json]'); process.exit(2); }
  for (const f of files) {
    const a = await analyzeFile(f);
    if (json) { const { framePts, ...rest } = a; console.log(JSON.stringify(rest, null, 2)); continue; }
    console.log(`\n== ${a.name}  (${a.info.video.width}x${a.info.video.height}, ${a.timeline.frames} frames)`);
    let g = '';
    for (const r of a.health) {
      if (r.group !== g) { g = r.group; console.log(`  [${g}]`); }
      const flag = { ok: ' ', info: 'i', warn: '!', bad: 'X' }[r.severity];
      console.log(`   ${flag} ${r.label.padEnd(30)} ${r.value}`);
    }
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
