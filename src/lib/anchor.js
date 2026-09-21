// GitHub's per-file anchor on the Files changed tab.
//
// Reverse-engineered and pinned by tests against real anchors from a live PR:
// the fragment is `diff-` followed by the lowercase hex SHA-256 of the file's
// path, hashed over its UTF-8 bytes. (It used to be an MD5 of the filename;
// anything you find saying that is stale.)

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** @returns {Promise<string>} the hex digest, without the `diff-` prefix */
export async function fileAnchor(path) {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let out = '';
  for (const byte of new Uint8Array(digest)) out += HEX[byte];
  return out;
}

/** Resolve anchors for every path we kept, in parallel. */
export async function attachAnchors(buckets) {
  await Promise.all(
    buckets.flatMap((bucket) =>
      bucket.paths.map(async (file) => { file.anchor = await fileAnchor(file.path); })),
  );
}
