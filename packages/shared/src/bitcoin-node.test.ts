import { describe, expect, it } from 'vitest';
import {
  isOnionHost,
  isPrivateHost,
  nodeCandidates,
  nodeUrlProblem,
  reachOf,
  routeFor,
} from './bitcoin-node.js';

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

  /**
   * Link-local reads as private and is not the same kind of thing: it holds
   * 169.254.169.254, the instance-metadata address on every major cloud. No
   * such service exists on the NAS, so this guards where Delegate might run.
   */
  it('does not treat link-local as private', () => {
    expect(nodeUrlProblem('http://169.254.169.254/latest/meta-data/')?.code).toBe(
      'node_url_insecure',
    );
    expect(isPrivateHost('169.254.169.254')).toBe(false);
    expect(reachOf('https://169.254.169.254/')).toBe('public');
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

describe('working out what was typed', () => {
  it('adds https to a bare domain name', () => {
    // Demanding a scheme means demanding somebody type boilerplate that has
    // exactly one correct value for a public host.
    expect(nodeCandidates('mempool.space').candidates).toEqual([
      'https://mempool.space',
      'https://mempool.space/api',
    ]);
  });

  it('adds http to a LAN address and to an onion, because https cannot work there', () => {
    expect(nodeCandidates('192.168.1.50:3002').candidates[0]).toBe('http://192.168.1.50:3002');
    expect(nodeCandidates('abcdef.onion').candidates[0]).toBe('http://abcdef.onion');
  });

  it('offers the API path as well as what was typed', () => {
    // mempool.space serves Esplora under /api and a self-hosted electrs might
    // not. The caller tries both and keeps the one that answers, rather than
    // the owner having to know.
    const { candidates } = nodeCandidates('https://mempool.space');
    expect(candidates).toContain('https://mempool.space/api');
  });

  it('keeps a path somebody wrote deliberately, and tries it first', () => {
    expect(nodeCandidates('https://node.example/esplora').candidates[0]).toBe(
      'https://node.example/esplora',
    );
  });

  it('still refuses plain http to a public host', () => {
    expect(nodeCandidates('http://mempool.space').problem?.code).toBe('node_url_insecure');
  });

  it('says so when nothing was typed', () => {
    expect(nodeCandidates('   ').problem?.code).toBe('node_url_missing');
  });
});

describe('how an address will be reached', () => {
  it('decides from the address rather than from a setting', () => {
    // Every one of these has exactly one sensible answer, which is why it was
    // wrong to ask.
    expect(routeFor('http://192.168.1.50:3002')).toBe('direct');
    expect(routeFor('http://localhost:3002')).toBe('direct');
    expect(routeFor('http://abcdef.onion/api')).toBe('tor');
    expect(routeFor('https://mempool.space/api')).toBe('prefer-tor');
  });
});
