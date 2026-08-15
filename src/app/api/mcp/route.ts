import { handleMcpRequest, MCP_TOOL_NAMES } from '@/lib/mcp/tools';

/**
 * POST /api/mcp — the Model Context Protocol endpoint.
 *
 * Deliberately a four-line adapter. Auth, the tool allow-list, the daily spend
 * cap and the JSON-RPC dispatcher all live in src/lib/mcp/tools.ts, for one
 * reason: a route module cannot be executed by `node --test`, and the auth path
 * here is exactly the kind of code that has to be PROVEN rather than reviewed.
 * Keeping this file empty of decisions is what makes tests/mcp.test.ts able to
 * exercise the real thing instead of a copy of it.
 *
 * THIS ROUTE IS NOT BEHIND `requireOperator()`, and that is not an oversight.
 * Every other route in this app is gated on a signed-in, allow-listed operator
 * holding a Supabase session cookie. An MCP client is not a browser and has no
 * cookie; it authenticates with `Authorization: Bearer ${MCP_ACCESS_TOKEN}`,
 * compared in constant time, and refuses everything when that secret is unset.
 * That is a SECOND door with its own key — never a hole in the first one:
 * nothing reachable from here can publish, schedule, scrape, spend on Apify,
 * mirror media, mutate brand data or mark a digest sent (hard rules 1 and 14).
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

/**
 * The MCP Streamable HTTP transport also defines a GET for a server-initiated
 * SSE stream. This server has nothing to push — no subscriptions, no progress
 * notifications, no resource updates — so GET is answered with an explicit 405
 * naming what the endpoint does support, rather than letting Next return a
 * bare framework error a client cannot act on.
 *
 * No auth check runs here on purpose: this response is the same for everyone
 * and reveals nothing about the deployment, so gating it would only give an
 * unauthenticated caller a way to probe whether a token is configured.
 */
export function GET(): Response {
  return Response.json(
    {
      error: 'This MCP endpoint speaks JSON-RPC over POST only; it opens no SSE stream.',
      supported: { methods: ['POST'], tools: [...MCP_TOOL_NAMES] },
    },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
