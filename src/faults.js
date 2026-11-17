import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

async function fingerprint(filename) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

const sameContent = (left, right) => left.bytes === right.bytes && left.sha256 === right.sha256;

/** Copy a shard intact to another database, then remove its original file. */
export async function moveShardFile({ sourceFilename, destinationFilename }) {
  const source = resolve(sourceFilename);
  const destination = resolve(destinationFilename);
  if (source === destination) {
    throw new Error('Shard move source and destination must be different files');
  }
  const started = performance.now();
  const original = await fingerprint(source);
  // A fault must never overwrite another shard while preparing its move.
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const [sourceAfterCopy, copied] = await Promise.all([
    fingerprint(source), fingerprint(destination),
  ]);
  if (!sameContent(original, sourceAfterCopy) || !sameContent(original, copied)) {
    throw new Error('Shard copy verification failed; source file was not removed');
  }
  const handle = await open(destination, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Keep the source until the copied bytes have been checked and flushed.
  await unlink(source);
  return {
    sourceFilename: source,
    destinationFilename: destination,
    sourceRemoved: true,
    destinationVerified: true,
    bytes: copied.bytes,
    sha256: copied.sha256,
    durationMs: performance.now() - started,
  };
}
