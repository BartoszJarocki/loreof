import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIp } from '../src/server/http';

test('request identity collapses IPv6 addresses to their /64 and keeps IPv4 addresses whole', () => {
  const cases: Array<[string, string]> = [
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2::1', '2001:0db8:0001:0002'],
    ['2001:DB8:1:2:ABCD::5', '2001:0db8:0001:0002'],
    ['2001:0db8:0001:0002:0:0:0:1', '2001:0db8:0001:0002'],
    ['2001:db8:1:3::1', '2001:0db8:0001:0003'],
    ['::1', '0000:0000:0000:0000'],
    ['not-an-address', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [forwarded, expected] of cases) {
    const request = new Request('https://lore.example', {
      headers: { 'x-forwarded-for': forwarded },
    });
    assert.equal(requestIp(request), expected, forwarded);
  }
  assert.equal(
    requestIp(
      new Request('https://lore.example', {
        headers: { 'x-vercel-forwarded-for': '2001:db8:9:8::1, 203.0.113.7' },
      }),
    ),
    '2001:0db8:0009:0008',
  );
});
