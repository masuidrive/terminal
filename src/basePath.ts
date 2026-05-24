// The server may mount everything under a random path prefix (e.g.
// /abcd1234) when --lan is on, as a lightweight access-control measure.
// We detect that prefix from window.location at load time and prepend it
// to every API / WebSocket / artifacts URL the client builds.
//
// The prefix is at most one path segment, so we capture only the leading
// `/<segment>` and stop there. When the app is served at `/`, BASE_PATH
// is the empty string.
const m = /^(\/[^/]+)\//.exec(window.location.pathname);
export const BASE_PATH = m ? m[1]! : '';
