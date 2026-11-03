// The shared library API (SPEC §2.2), served by api/library.js as a Vercel Function. Anyone can
// read; changes need the password in the LIBRARY_PASSWORD environment variable. The data is in a
// private Vercel Blob store:
//
//   library/index.json            the index: the folders and one entry per puzzle (shared/library-index.js)
//   library/docs/<id>/<rev>.json  the documents; every write makes a new revision, so a revision never
//                                 changes and its reads can use the blob cache
//
// GET  /api/library[?since=<etag>]      {etag, index}, or {etag, unchanged: true} when it is still `since`
// GET  /api/library?doc=<id>&rev=<rev>  the document
// POST /api/library  {base, ops, docs}  with `Authorization: Bearer <password, URI-encoded>`
//      → {etag, revs, index?}: the revision given to each document put, and the new index unless it
//        is `base` with `ops` applied, which the client then applies itself. No operations: a
//        password check.
//
// The index is read and written back with the ETag it was read with, so two devices writing at once
// cannot lose each other's changes: the second write fails, and its operations are applied again to
// the new index.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { applyOps, checkOps, emptyIndex, INDEX_FORMAT, isId } from '../shared/library-index.js';

const INDEX = 'library/index.json';
const docPath = (id, rev) => `library/docs/${id}/${rev}.json`;
const MAX_DOC = 2_000_000;
const ATTEMPTS = 8;
/** ETag characters: printable ASCII without the double quote. */
const ETAG = /^[!#-~]{1,200}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** An ETag without W/ and quotes, as the client keeps it. */
const bare = (etag) => (etag ?? '').replace(/^W\//, '').replace(/^"(.*)"$/, '$1') || null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const digest = (text) => createHash('sha256').update(text).digest();

function isPreconditionConflict(error, BlobPreconditionFailedError) {
  return (
    error instanceof BlobPreconditionFailedError ||
    (error instanceof Error && error.message.includes('Precondition failed: ETag mismatch'))
  );
}

class IndexConflictError extends Error {
  constructor() {
    super('The library changed while saving. Please try again.');
  }
}

/** `blob`: the functions of @vercel/blob used here (or a test double); `env`: the environment. */
export function createHandler({ blob, env }) {
  /** The index and its ETag (null when there is no index yet); `since` gives null when unchanged. */
  async function readIndex(since) {
    const result = await blob.get(INDEX, { access: 'private', useCache: false, ...(since ? { ifNoneMatch: `"${since}"` } : {}) });
    if (!result) return { index: emptyIndex(), etag: null };
    if (result.statusCode === 304) return { index: null, etag: since };
    const index = await new Response(result.stream).json();
    if (index?.format !== INDEX_FORMAT) throw new Error(`${INDEX} is not a library index`);
    return { index, etag: result.blob.etag };
  }

  async function readIndexForWrite() {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const current = await readIndex(null);
      if (!current.etag) return current;
      // Use Blob's metadata ETag for the conditional write, and ensure it describes this content.
      const metadata = await blob.head(INDEX, { access: 'private' });
      if (bare(metadata.etag) === bare(current.etag)) return { ...current, etag: metadata.etag };
      if (attempt < ATTEMPTS) await sleep(50 + Math.random() * Math.min(800, 50 * 2 ** (attempt - 1)));
    }
    throw new IndexConflictError();
  }

  async function getIndex(url) {
    const since = url.searchParams.get('since');
    const { index, etag } = await readIndex(since && ETAG.test(since) ? since : null);
    return json(200, index ? { etag: bare(etag), index } : { etag: bare(etag), unchanged: true });
  }

  async function getDoc(url) {
    const id = url.searchParams.get('doc');
    const rev = url.searchParams.get('rev');
    if (!isId(id) || !isId(rev)) return json(400, { error: 'Invalid document id' });
    const result = await blob.get(docPath(id, rev), { access: 'private' });
    if (!result) return json(404, { error: 'No such document' });
    return new Response(result.stream, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  }

  function authorized(request) {
    const header = request.headers.get('authorization') ?? '';
    let given = '';
    try {
      given = decodeURIComponent(header.replace(/^Bearer /, ''));
    } catch {
      return false;
    }
    return timingSafeEqual(digest(given), digest(env.LIBRARY_PASSWORD));
  }

  async function change(request) {
    if (!env.LIBRARY_PASSWORD) return json(503, { error: 'Changes are disabled: LIBRARY_PASSWORD is not set on the server' });
    if (!authorized(request)) {
      // Slows down guessing.
      await sleep(500);
      return json(401, { error: 'Wrong password' });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    const ops = body?.ops;
    const error = checkOps(ops);
    if (error) return json(400, { error });
    if (ops.length === 0) return json(200, { etag: null, revs: {} });

    // The documents first, each under a new revision, so the index never refers to a missing one.
    const docs = body.docs ?? {};
    const revs = {};
    const texts = {};
    for (const op of ops) {
      if (op.op !== 'put') continue;
      const id = op.entry.id;
      const doc = docs[id];
      if (!doc || typeof doc !== 'object' || doc.format !== 'puzzle-generator') return json(400, { error: `put: no document for ${id}` });
      texts[id] = JSON.stringify(doc);
      if (texts[id].length > MAX_DOC) return json(400, { error: `put: the document ${id} is too large` });
      revs[id] = randomBytes(6).toString('base64url');
    }
    const written = Object.keys(revs).map((id) => docPath(id, revs[id]));
    await Promise.all(Object.keys(revs).map((id) => blob.put(docPath(id, revs[id]), texts[id], { access: 'private', contentType: 'application/json' })));

    try {
      for (let attempt = 1; ; attempt++) {
        const current = await readIndexForWrite();
        const { index, removed } = applyOps(current.index, ops, revs);
        let result;
        try {
          result = await blob.put(INDEX, JSON.stringify(index), {
            access: 'private',
            contentType: 'application/json',
            cacheControlMaxAge: 60,
            // Only over the index just read; without one, only if there is still none.
            ...(current.etag ? { allowOverwrite: true, ifMatch: current.etag } : { allowOverwrite: false }),
          });
        } catch (e) {
          const conflict = isPreconditionConflict(e, blob.BlobPreconditionFailedError) || !current.etag;
          if (!conflict) throw e;
          if (attempt >= ATTEMPTS) throw new IndexConflictError();
          await sleep(50 + Math.random() * Math.min(800, 50 * 2 ** (attempt - 1)));
          continue;
        }
        if (removed.length > 0) {
          // Deletes are free; a failure only leaves unused documents behind.
          await blob.del(removed.map((r) => docPath(r.id, r.rev))).catch((e) => console.error('library: delete failed', e));
        }
        const etag = bare(result.etag);
        const unchanged = body.base && bare(current.etag) === body.base;
        return json(200, unchanged ? { etag, revs } : { etag, revs, index });
      }
    } catch (e) {
      await blob.del(written).catch(() => {});
      if (e instanceof IndexConflictError) return json(409, { error: e.message });
      throw e;
    }
  }

  return async function handle(request) {
    try {
      if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) {
        return json(503, { error: 'The shared library is not set up: no Blob store is connected to the Vercel project' });
      }
      const url = new URL(request.url);
      if (request.method === 'GET') return await (url.searchParams.has('doc') ? getDoc(url) : getIndex(url));
      if (request.method === 'POST') return await change(request);
      return json(405, { error: 'Method not allowed' });
    } catch (e) {
      console.error('library:', e);
      return json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}
