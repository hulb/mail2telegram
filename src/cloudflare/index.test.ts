import assert from 'node:assert/strict';
import { filterEmailRoutingMXRecords, hasMorePages, isValidAddressLength, mapRoutingRuleResult, validateEmailPrefix } from './index';

function testValidateEmailPrefix() {
    assert.equal(validateEmailPrefix('admin'), true);
    assert.equal(validateEmailPrefix('a.b_c-d'), true);
    assert.equal(validateEmailPrefix('A1'), true);
    assert.equal(validateEmailPrefix(''), false);
    assert.equal(validateEmailPrefix('-bad'), false);
    assert.equal(validateEmailPrefix('.bad'), false);
    assert.equal(validateEmailPrefix('a b'), false);
    assert.equal(validateEmailPrefix('a@b'), false);
    assert.equal(validateEmailPrefix('x'.repeat(64)), false);
    console.log('testValidateEmailPrefix ok');
}

function testIsValidAddressLength() {
    assert.equal(isValidAddressLength('a@b.co'), true);
    assert.equal(isValidAddressLength(`${'a'.repeat(80)}@test.com`), true);
    assert.equal(isValidAddressLength(`${'a'.repeat(90)}@test.com`), false);
    console.log('testIsValidAddressLength ok');
}

function testFilterEmailRoutingMXRecords() {
    const records = [
        { name: 'test.com', content: 'route1.mx.cloudflare.net' },
        { name: 'test.com', content: 'route2.mx.cloudflare.net' },
        { name: 'sub.test.com', content: 'route3.mx.cloudflare.net.' },
        { name: 'other.test.com', content: 'mx.google.com' },
        { name: 'test.com', content: 'route1.mx.cloudflare.net' },
    ];
    assert.deepEqual(filterEmailRoutingMXRecords(records), ['sub.test.com', 'test.com']);
    assert.deepEqual(filterEmailRoutingMXRecords([]), []);
    console.log('testFilterEmailRoutingMXRecords ok');
}

function testFilterEmailRoutingMXRecordsByMeta() {
    // meta.email_routing 是权威标记；content 不匹配主机名模式也能命中
    const records = [
        { name: 'test.com', content: 'route1.mx.cloudflare.net', meta: { email_routing: true, read_only: true } },
        // content 大小写不同但 meta 标记存在 → 也应命中
        { name: 'sub.test.com', content: 'Route1.MX.Cloudflare.NET', meta: { email_routing: true } },
        // 第三方 MX，无 meta 标记 → 不命中
        { name: 'other.test.com', content: 'aspmx.l.google.com', meta: { email_routing: false } },
        // 无 meta 字段但 content 匹配 → 兼容兜底，仍命中（含非 route 前缀，如 linda）
        { name: 'legacy.test.com', content: 'route2.mx.cloudflare.net' },
        { name: 'legacy2.test.com', content: 'linda.mx.cloudflare.net.' },
    ];
    assert.deepEqual(filterEmailRoutingMXRecords(records), ['legacy.test.com', 'legacy2.test.com', 'sub.test.com', 'test.com']);
    console.log('testFilterEmailRoutingMXRecordsByMeta ok');
}

function testMapRoutingRuleResult() {
    // forward
    assert.deepEqual(mapRoutingRuleResult({
        id: 'r1',
        matchers: [{ type: 'literal', field: 'to', value: 'a@b.com' }],
        actions: [{ type: 'forward', value: ['x@y.com'] }],
        source: 'api',
    }), { id: 'r1', address: 'a@b.com', actionLabel: '→ x@y.com', source: 'api' });
    // worker
    assert.deepEqual(mapRoutingRuleResult({
        id: 'r2',
        matchers: [{ type: 'literal', field: 'to', value: 'info@b.com' }],
        actions: [{ type: 'worker', value: ['my-worker'] }],
        source: 'wrangler',
    }), { id: 'r2', address: 'info@b.com', actionLabel: '→ worker my-worker', source: 'wrangler' });
    // drop（value 省略）
    assert.deepEqual(mapRoutingRuleResult({
        id: 'r3',
        matchers: [{ type: 'literal', field: 'to', value: 'drop@b.com' }],
        actions: [{ type: 'drop' }],
    }), { id: 'r3', address: 'drop@b.com', actionLabel: '→ drop', source: 'api' });
    // 无 literal matcher（catch-all 等）→ null
    assert.equal(mapRoutingRuleResult({ id: 'r4', matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['x@y.com'] }] }), null);
    // 无 actions → null
    assert.equal(mapRoutingRuleResult({ id: 'r5', matchers: [{ type: 'literal', field: 'to', value: 'a@b.com' }], actions: [] }), null);
    console.log('testMapRoutingRuleResult ok');
}

function testHasMorePages() {
    // total_pages 存在 → 按它判断
    assert.equal(hasMorePages({ page: 1, total_pages: 3 }, 20, 1), true);
    assert.equal(hasMorePages({ page: 3, total_pages: 3 }, 20, 3), false);
    // total_pages 缺失但 total_count/per_page 存在（email routing rules 端点）→ 按 ceil(total/per_page) 判断
    // 60 条、per_page=20 → 共 3 页
    assert.equal(hasMorePages({ page: 1, per_page: 20, total_count: 60 }, 20, 1), true);
    assert.equal(hasMorePages({ page: 2, per_page: 20, total_count: 60 }, 20, 2), true);
    assert.equal(hasMorePages({ page: 3, per_page: 20, total_count: 60 }, 20, 3), false);
    // 整除边界：40 条 / 20 每页 → 2 页
    assert.equal(hasMorePages({ page: 2, per_page: 20, total_count: 40 }, 20, 2), false);
    // per_page 缺失时用本页实取条数兜底
    assert.equal(hasMorePages({ page: 1, total_count: 60 }, 20, 1), true);
    // 无分页信息（workers scripts 一次返回全部）→ 不再翻页
    assert.equal(hasMorePages(undefined, 60, 1), false);
    console.log('testHasMorePages ok');
}

testValidateEmailPrefix();
testIsValidAddressLength();
testFilterEmailRoutingMXRecords();
testFilterEmailRoutingMXRecordsByMeta();
testMapRoutingRuleResult();
testHasMorePages();
