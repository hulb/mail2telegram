import type { RoutingRule } from '../cloudflare';
import assert from 'node:assert/strict';
import {
    buildConfirmKeyboard,
    buildListRoutesDomainKeyboard,
    buildRuleLabel,
    buildRulesKeyboard,
    parseListRoutesCallbackData,
    RULES_PER_PAGE,
} from './list_routes';

function testParseListRoutesCallbackData() {
    assert.deepEqual(parseListRoutesCallbackData('lr:d:ab12cd34:0'), { act: 'd', stateId: 'ab12cd34', index: 0 });
    assert.deepEqual(parseListRoutesCallbackData('lr:p:ab12cd34:2'), { act: 'p', stateId: 'ab12cd34', page: 2 });
    assert.deepEqual(parseListRoutesCallbackData('lr:c:ab12cd34:5'), { act: 'c', stateId: 'ab12cd34', ruleIndex: 5 });
    assert.deepEqual(parseListRoutesCallbackData('lr:x:ab12cd34:5'), { act: 'x', stateId: 'ab12cd34', ruleIndex: 5 });
    assert.deepEqual(parseListRoutesCallbackData('lr:z:ab12cd34:0'), { act: 'z', stateId: 'ab12cd34', page: 0 });
    assert.equal(parseListRoutesCallbackData(''), null);
    assert.equal(parseListRoutesCallbackData('lr:x:ab12cd34'), null);
    assert.equal(parseListRoutesCallbackData('lr:x:ab12cd34:x'), null);
    assert.equal(parseListRoutesCallbackData('nr:d:ab12cd34:0'), null);
    assert.equal(parseListRoutesCallbackData('lr:x:AB12CD34:0'), null); // stateId 必须小写
    for (const data of ['lr:d:ab12cd34:0', 'lr:p:ab12cd34:19', 'lr:x:ab12cd34:199']) {
        assert.ok(Buffer.byteLength(data) <= 64, `${data} exceeds 64 bytes`);
    }
    console.log('testParseListRoutesCallbackData ok');
}

function testBuildRuleLabel() {
    const fwd: RoutingRule = { id: 'r1', address: 'a@b.com', actionLabel: '→ x@y.com', source: 'api' };
    const wk: RoutingRule = { id: 'r2', address: 'i@b.com', actionLabel: '→ worker my-worker', source: 'api' };
    const drop: RoutingRule = { id: 'r3', address: 'd@b.com', actionLabel: '→ drop', source: 'api' };
    assert.equal(buildRuleLabel(fwd), '📧 a@b.com → x@y.com');
    assert.equal(buildRuleLabel(wk), '⚙️ i@b.com → worker my-worker');
    assert.equal(buildRuleLabel(drop), '🚫 d@b.com → drop');
    console.log('testBuildRuleLabel ok');
}

function testBuildListRoutesDomainKeyboard() {
    const kb = buildListRoutesDomainKeyboard([
        { domain: 'test.com', zoneId: 'z1' },
        { domain: 'sub.test.com', zoneId: 'z1' },
    ], 'ab12cd34');
    assert.deepEqual(kb.inline_keyboard, [
        [{ text: 'test.com', callback_data: 'lr:d:ab12cd34:0' }],
        [{ text: 'sub.test.com', callback_data: 'lr:d:ab12cd34:1' }],
    ]);
    console.log('testBuildListRoutesDomainKeyboard ok');
}

function testBuildRulesKeyboardPagination() {
    const rules: RoutingRule[] = Array.from({ length: 25 }, (_, i) => ({
        id: `r${i}`,
        address: `a${i}@b.com`,
        actionLabel: '→ x@y.com',
        source: 'api',
    }));

    const page0 = buildRulesKeyboard(rules, 'ab12cd34', 0);
    assert.equal(page0.inline_keyboard.length, RULES_PER_PAGE + 1);
    assert.equal(page0.inline_keyboard[0][0].callback_data, 'lr:c:ab12cd34:0');
    const nav0 = page0.inline_keyboard[RULES_PER_PAGE];
    assert.equal(nav0.length, 1);
    assert.equal(nav0[0].callback_data, 'lr:p:ab12cd34:1');

    const page1 = buildRulesKeyboard(rules, 'ab12cd34', 1);
    assert.equal(page1.inline_keyboard[0][0].callback_data, 'lr:c:ab12cd34:10');
    const nav1 = page1.inline_keyboard[RULES_PER_PAGE];
    assert.equal(nav1.length, 2);
    assert.equal(nav1[0].callback_data, 'lr:p:ab12cd34:0');
    assert.equal(nav1[1].callback_data, 'lr:p:ab12cd34:2');

    const page2 = buildRulesKeyboard(rules, 'ab12cd34', 2);
    assert.equal(page2.inline_keyboard.length, 5 + 1);
    const nav2 = page2.inline_keyboard[5];
    assert.equal(nav2.length, 1);
    assert.equal(nav2[0].callback_data, 'lr:p:ab12cd34:1');

    // 空列表 → 空键盘
    assert.deepEqual(buildRulesKeyboard([], 'ab12cd34', 0).inline_keyboard, []);
    console.log('testBuildRulesKeyboardPagination ok');
}

function testBuildConfirmKeyboard() {
    const kb = buildConfirmKeyboard('ab12cd34', 5);
    assert.deepEqual(kb.inline_keyboard, [
        [{ text: '✅ Confirm', callback_data: 'lr:x:ab12cd34:5' }],
        [{ text: '❌ Cancel', callback_data: 'lr:z:ab12cd34:0' }],
    ]);
    console.log('testBuildConfirmKeyboard ok');
}

testParseListRoutesCallbackData();
testBuildRuleLabel();
testBuildListRoutesDomainKeyboard();
testBuildRulesKeyboardPagination();
testBuildConfirmKeyboard();
