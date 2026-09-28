import { SocksClient } from 'socks';
import { Agent, buildConnector, type Dispatcher } from 'undici';
import { ValidationError } from '../domain/errors.js';
import type { FetchLike } from './esplora.js';

/**
 * Reaching a node over Tor.
 *
 * Node's own `fetch` cannot speak SOCKS, which is the whole reason this file
 * exists — and the whole reason `EsploraNode` takes its fetch as a parameter.
 * The client is unchanged; only how the socket is opened differs.
 *
 * `socks5h` semantics, not `socks5`: the hostname is handed to the proxy rather
 * than resolved here. That is not a preference. A `.onion` name has no DNS
 * entry, so resolving locally would fail — and for any other host, resolving
 * locally would leak which one is being asked about to the network Tor is there
 * to hide it from.
 */

const tlsConnector = buildConnector({});

function portFor(protocol: string | undefined, port: string | undefined): number {
  if (port !== undefined && port !== '') return Number(port);
  return protocol === 'https:' ? 443 : 80;
}

/**
 * A dispatcher that opens every connection through the SOCKS proxy.
 *
 * TLS, where it applies, is negotiated *through* the tunnel rather than to it —
 * so an https node reached over Tor is still end-to-end encrypted to the node,
 * and the proxy sees a stream it cannot read.
 */
export function torDispatcher(proxyUrl: string): Dispatcher {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new ValidationError(
      'tor_proxy_unparseable',
      `TOR_SOCKS_URL is not a URL: ${proxyUrl}. It should look like socks5h://tor:9050.`,
    );
  }

  const host = proxy.hostname;
  const port = Number(proxy.port === '' ? '9050' : proxy.port);

  return new Agent({
    connect: (options, callback) => {
      SocksClient.createConnection({
        proxy: { host, port, type: 5 },
        command: 'connect',
        destination: {
          // The name, never an address resolved here. See the file header.
          host: String(options.hostname),
          port: portFor(
            options.protocol,
            options.port === undefined ? undefined : String(options.port),
          ),
        },
      })
        .then(({ socket }) => {
          if (options.protocol === 'https:') {
            // Handed to undici's TLS connector so the certificate is checked
            // against the node, not against the proxy.
            tlsConnector({ ...options, httpSocket: socket }, callback);
            return;
          }
          callback(null, socket);
        })
        .catch((error: unknown) => {
          callback(
            error instanceof Error ? error : new Error('The Tor proxy refused the connection.'),
            null,
          );
        });
    },
  });
}

/**
 * A `fetch` that goes through Tor, shaped like the one `EsploraNode` expects.
 *
 * Built per configuration change rather than held forever: the owner can turn
 * Tor off at any time, and a cached dispatcher would go on tunnelling.
 */
export function torFetch(proxyUrl: string): FetchLike {
  const dispatcher = torDispatcher(proxyUrl);

  // Node's global fetch accepts a dispatcher at runtime but does not declare
  // one, and undici's own `fetch` carries a second, incompatible set of DOM
  // types. Asserting once here keeps that friction to a single line rather than
  // spreading undici's types through the client.
  type WithDispatcher = RequestInit & { dispatcher: Dispatcher };
  return (url, init) => fetch(url, { ...init, dispatcher } as WithDispatcher);
}
