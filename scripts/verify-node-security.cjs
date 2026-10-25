'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function isSupportedRuntime(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return (major === 22 && (minor > 23 || (minor === 23 && patch >= 4))) ||
    (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)));
}

async function decodeChunks(chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), zlib.createBrotliDecompress(), new Writable({
    write(chunk, _encoding, done) { output.push(chunk); done(); },
  }));
  return Buffer.concat(output);
}

async function main() {
  // Reject old runtimes before passing any malformed input to their native decoder.
  assert.ok(isSupportedRuntime(process.versions.node),
    `Node ${process.versions.node} is unsupported: use 22.23.4+ in 22.x or 24.22.1+ in 24.x (CVE-2026-111497).`);
  for (const version of ['22.13.0', '22.23.3', '24.11.1', '24.22.0', '24.22.1-rc.1', '26.12.1']) {
    assert.equal(isSupportedRuntime(version), false, `Reject unsupported runtime ${version}`);
  }
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.23.0']) {
    assert.equal(isSupportedRuntime(version), true, `Accept supported runtime ${version}`);
  }

  // Minimal regression input from Node's security patch, not an RCE payload:
  // https://github.com/nodejs/node/commit/b5f41529df
  const malformed = Buffer.from('200010414141fcffff07002228f00b60f7f41f000000', 'hex');
  const expected = { code: 'ERR__ERROR_FORMAT_BLOCK_SWITCH', errno: -17 };
  assert.equal(zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, expected.errno);
  assert.throws(() => zlib.brotliDecompressSync(malformed), expected);
  await assert.rejects(promisify(zlib.brotliDecompress)(malformed), expected);
  await assert.rejects(decodeChunks([...malformed].map(byte => Buffer.from([byte]))), expected);

  const plaintext = Buffer.from(JSON.stringify({ event: 'Audit.valid', text: '감사 기록 / café / 🔐'.repeat(64) }));
  const encoded = zlib.brotliCompressSync(plaintext);
  assert.deepEqual(zlib.brotliDecompressSync(encoded), plaintext);
  assert.deepEqual(await decodeChunks([...encoded].map(byte => Buffer.from([byte]))), plaintext);
  assert.throws(() => zlib.brotliDecompressSync(encoded.subarray(0, -4)), { code: 'Z_BUF_ERROR' });
  console.log(JSON.stringify({
    check: 'CVE-2026-111497', status: 'passed', node: process.version,
    brotli: process.versions.brotli, platform: process.platform, architecture: process.arch,
    invalidBlockSwitch: ['sync', 'async', 'fragmented-stream'],
    controls: ['supported-version-boundaries', 'unicode-roundtrip', 'fragmented-unicode-roundtrip', 'truncated-input-rejected'],
  }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
