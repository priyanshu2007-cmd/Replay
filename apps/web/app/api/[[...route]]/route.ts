import defaultApp from '@replay/api';

// The Hono API mounts inside the Next service: one deployment, same-origin
// /api/* with no cross-service builder quirks. SSE streams flow through the
// web runtime (hono/streaming uses web ReadableStream).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = (req: Request) => defaultApp.fetch(req);

export { handler as GET, handler as POST, handler as OPTIONS };
