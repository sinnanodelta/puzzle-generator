// The shared library (SPEC §2.2): a Vercel Function over a private Vercel Blob store, at /api/library.
// The handler is in server/library.js; this entry point gives it the Blob SDK and the environment.
// Plain JavaScript, so Vercel runs it without compiling it: the project uses TypeScript 7, whose
// package has no JavaScript compiler API.
import { BlobPreconditionFailedError, del, get, head, put } from '@vercel/blob';
import { createHandler } from '../server/library.js';

const handle = createHandler({ blob: { get, head, put, del, BlobPreconditionFailedError }, env: process.env });

export default { fetch: handle };
