import { describe, expect, it } from 'vitest';
import { isOnionHost, isPrivateHost, nodeUrlProblem, reachOf } from './bitcoin-node.js';

/**
 * The rule is "WAN over HTTPS, never HTTP", written as something a program
 * checks rather than something a person remembers. The two exceptions are the
 * interesting part, and neither weakens it.
 */

describe('what may be reached over plaintext', () => {
  it('refuses plain http on the public internet', () => {
    const problem = nodeUrlProblem('http://mempool.space/api');
    expect(problem?.code).toBe('node_url_insecure');
    // Says what it costs, rather than only saying no.
    expect(problem?.message).toContain('in the clear');
  });

  it('allows plain http to an onion address', () => {
    // A v3 onion name *is* a public key: the transport is already encrypted and
    // authenticated by the address. TLS on top adds nothing, and certificate
    // authorities do not meaningfully issue for .onion.
    expect(
      nodeUrlProblem('http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api'),
    ).toBeNull();
  });

  it('allows plain http on the local network', () => {
    for (const url of [
      'http://192.168.1.50:3002',
      'http://10.0.3.4:3002',
      'http://172.16.4.4:3002',
      'http://umbrel.local:3002',
      'http://localhost:3002',
      'http://127.0.0.1:3002',
    ]) {
      expect(nodeUrlProblem(url), url).toBeNull();
    }
  });

  it('does not mistake a public address for a private one', () => {
    // 172.32 is outside the private range, and a hostname merely containing the
    // word is not a private host.
    for (const url of ['http://172.32.0.1:3002', 'http://localhost.example.com/api']) {
      expect(nodeUrlProblem(url)?.code, url).toBe('node_url_insecure');
    }
  });

  it('always allows https', () => {
    expect(nodeUrlProblem('https://mempool.space/api')).toBeNull();
  });

  it('refuses credentials in the URL', () => {
    // They would end up in the database dump, the logs, and anything that
    // echoes the setting back.
    expect(nodeUrlProblem('https://user:secret@node.example/api')?.code).toBe(
      'node_url_credentials',
    );
  });

  it('refuses something that is not a URL, and something that is not http', () => {
    expect(nodeUrlProblem('mempool.space')?.code).toBe('node_url_unparseable');
    expect(nodeUrlProblem('ftp://node.example/api')?.code).toBe('node_url_scheme');
  });
});

describe('how a node is described', () => {
  it('tells the three reaches apart', () => {
    expect(reachOf('https://mempool.space/api')).toBe('public');
    expect(reachOf('http://192.168.1.50:3002')).toBe('lan');
    expect(reachOf('http://abcdef.onion/api')).toBe('tor');
    expect(reachOf('not a url')).toBeNull();
  });

  it('recognises an onion and a private host on their own', () => {
    expect(isOnionHost('abcdef.onion')).toBe(true);
    expect(isOnionHost('onion.example.com')).toBe(false);
    expect(isPrivateHost('192.168.0.1')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });
});
