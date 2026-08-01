import assert from 'node:assert/strict';
import {
    buildDomainKeyboard,
    buildTargets,
    buildTargetsKeyboard,
    parseCallbackData,
    TARGETS_PER_PAGE,
} from './new_route';

function testParseCallbackData() {
    assert.deepEqual(parseCallbackData('nr:d:ab12cd34:0'), { act: 'd', stateId: 'ab12cd34', index: 0 });
    assert.deepEqual(parseCallbackData('nr:t:ab12cd34:17'), { act: 't', stateId: 'ab12cd34', index: 17 });
    assert.deepEqual(parseCallbackData('nr:g:ab12cd34:2'), { act: 'g', stateId: 'ab12cd34', page: 2 });
    assert.equal(parseCallbackData(''), null);
    assert.equal(parseCallbackData('nr:x:ab12cd34:0'), null);
    assert.equal(parseCallbackData('nr:d:ab12cd34'), null);
    assert.equal(parseCallbackData('nr:d:ab12cd34:x'), null);
    assert.equal(parseCallbackData('p:mailid123'), null);
    // Telegram callback_data 上限 64 字节
    for (const data of ['nr:d:ab12cd34:0', 'nr:t:ab12cd34:199', 'nr:g:ab12cd34:19']) {
        assert.ok(Buffer.byteLength(data) <= 64, `${data} exceeds 64 bytes`);
    }
    console.log('testParseCallbackData ok');
}

function testBuildTargets() {
    const targets = buildTargets(['a@x.com', 'b@x.com'], ['worker-a']);
    assert.deepEqual(targets, [
        { label: '📧 a@x.com', type: 'forward', value: 'a@x.com' },
        { label: '📧 b@x.com', type: 'forward', value: 'b@x.com' },
        { label: '⚙️ worker-a', type: 'worker', value: 'worker-a' },
    ]);
    assert.deepEqual(buildTargets([], []), []);
    console.log('testBuildTargets ok');
}

function testBuildDomainKeyboard() {
    const kb = buildDomainKeyboard([
        { domain: 'test.com', zoneId: 'z1' },
        { domain: 'sub.test.com', zoneId: 'z1' },
    ], 'ab12cd34');
    assert.deepEqual(kb.inline_keyboard, [
        [{ text: 'test.com', callback_data: 'nr:d:ab12cd34:0' }],
        [{ text: 'sub.test.com', callback_data: 'nr:d:ab12cd34:1' }],
    ]);
    console.log('testBuildDomainKeyboard ok');
}

function testBuildTargetsKeyboardPagination() {
    const targets = buildTargets(
        Array.from({ length: 15 }, (_, i) => `e${i}@x.com`),
        Array.from({ length: 10 }, (_, i) => `w${i}`),
    );
    assert.equal(targets.length, 25);

    const page0 = buildTargetsKeyboard(targets, 'ab12cd34', 0);
    assert.equal(page0.inline_keyboard.length, TARGETS_PER_PAGE + 1); // 10 个目标 + 导航行
    assert.equal(page0.inline_keyboard[0][0].callback_data, 'nr:t:ab12cd34:0');
    const nav0 = page0.inline_keyboard[TARGETS_PER_PAGE];
    assert.equal(nav0.length, 1);
    assert.equal(nav0[0].callback_data, 'nr:g:ab12cd34:1');

    const page1 = buildTargetsKeyboard(targets, 'ab12cd34', 1);
    assert.equal(page1.inline_keyboard[0][0].callback_data, 'nr:t:ab12cd34:10');
    const nav1 = page1.inline_keyboard[TARGETS_PER_PAGE];
    assert.equal(nav1.length, 2);
    assert.equal(nav1[0].callback_data, 'nr:g:ab12cd34:0');
    assert.equal(nav1[1].callback_data, 'nr:g:ab12cd34:2');

    const page2 = buildTargetsKeyboard(targets, 'ab12cd34', 2);
    assert.equal(page2.inline_keyboard.length, 5 + 1); // 剩余 5 个 + 导航行
    assert.equal(page2.inline_keyboard[0][0].callback_data, 'nr:t:ab12cd34:20');
    const nav2 = page2.inline_keyboard[5];
    assert.equal(nav2.length, 1);
    assert.equal(nav2[0].callback_data, 'nr:g:ab12cd34:1');
    console.log('testBuildTargetsKeyboardPagination ok');
}

testParseCallbackData();
testBuildTargets();
testBuildDomainKeyboard();
testBuildTargetsKeyboardPagination();
