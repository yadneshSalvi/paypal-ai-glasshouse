import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {act, createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {buildSnapshot} from '../packages/domain';
import type {Currency, Snapshot} from '../packages/domain/types';
import {nativePrint} from '../packages/studio/native-print';
import type {InstrumentData, InstrumentFormat} from '../packages/studio/types';
import {ReportNativeChart, ReportNativeScope} from '../components/report-native-chart';
import {productionInstrumentStudio} from './helpers/instrument-react';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus, times} from './reference/instrument-corpus';

type Production = Awaited<ReturnType<typeof productionInstrumentStudio>>;
const source = (currency: Currency = 'USD', semanticModelVersion = 'commerce-semantic-v3') => buildSnapshot(instrumentCorpus(), {asOf: times.end, knownAt: times.known, currency, semanticModelVersion});

async function historyFor(t: TestContext, snapshot: Snapshot, formats: Record<string, InstrumentFormat> = {}) {
  const native = await nativeStudio(t, undefined, {snapshot});
  const state = structuredClone(native.api.getState()), page = state.pages[0];
  delete page.widgets!.records;
  delete page.widgetLayout!.records;
  for (const [id, format] of Object.entries(formats)) {
    const widget = page.widgets![id] as InstrumentData;
    page.widgets![id] = {...widget, format: {...widget.format, ...format}};
  }
  native.api.setState(state);
  await new Promise(resolve => setTimeout(resolve, 50));
  native.api.clearHistory();
  const history = structuredClone(native.api.getHistory());
  native.destroy();
  return history;
}

async function press(h: Production, target: HTMLButtonElement) {
  await act(async () => {target.focus(); target.click();});
  await h.flush();
}

function button(h: Production, selector: string, name: string) {
  const target = [...h.win.document.querySelectorAll<HTMLButtonElement>(selector)]
    .find(node => node.getAttribute('aria-label') === name || node.textContent?.trim() === name);
  assert(target, 'Expected actual production control: ' + name);
  return target;
}

async function delayed(h: Production) {
  const target = [...h.win.document.querySelectorAll<HTMLButtonElement>('.river-state-cards > button')]
    .find(node => node.querySelector('.river-card-title')?.textContent?.trim() === 'delayed');
  assert(target);
  await press(h, target);
}

// Captured from b13b865 before presentation changes; the private receipt is
// branch-presentation-baseline-01.json. Preservation checks use the complete
// serialized branch, including its snapshot identity and every proposal.
const branchBytes: Record<string, string> = {
  'commerce-semantic-v1/USD': 'ab73d4175bea10e042ce2693e23201bf760eee0ce974bf751eab359b76ab549f',
  'commerce-semantic-v1/EUR': '24b01c10067022ab6977e05baf7aeac07ecfb89bebd82b3cb5ad53881be21707',
  'commerce-semantic-v1/GBP': 'b326568fcccc98945b08368429f6a2f6580324007dd92e240c9c8c3e251e6f33',
  'commerce-semantic-v2/USD': 'b714dbee92070e4d92a9f26005af5206025994acc9dcc0645cc54aac42902ff9',
  'commerce-semantic-v2/EUR': 'f9682d7b4275d883246b8f07404628d0941e29cf5e3afb5424204789761b59b5',
  'commerce-semantic-v2/GBP': 'f408eba3b30766c05fa999d1765a78b57c111260954310fdbb4733202e5b8b40',
  'commerce-semantic-v3/USD': 'ebc97b56d4332c9f3c4899ec4d44d44b1e87c4aebe9b78bdccf204ccba4f5dae',
  'commerce-semantic-v3/EUR': '07c593fa6f1a2d98382b269122a9e506878d7df97b85ac927b1a543b8ecbd8d3',
  'commerce-semantic-v3/GBP': '429559ac2bf7d0100261e5b7ce18119f37798121f7094e8704b6f562bc6d2289',
};

test('v1/v2/v3 admitted recovery branch bytes retain their original USD, EUR and GBP meaning', () => {
  for (const version of ['commerce-semantic-v1', 'commerce-semantic-v2', 'commerce-semantic-v3']) {
    for (const currency of ['USD', 'EUR', 'GBP'] as const) {
      const snapshot = source(currency, version), key = version + '/' + currency;
      assert.equal(createHash('sha256').update(JSON.stringify(snapshot.branches)).digest('hex'), branchBytes[key], key);
      if (currency !== 'USD') {
        assert(snapshot.branches.every(branch => branch.eligibleCount === 0 && branch.refundTotalMinor === 0));
        assert(snapshot.branches.every(branch => branch.actions.every(action => action.kind !== 'refund')));
      }
    }
  }
});

for (const currency of ['EUR', 'GBP'] as const) {
  test('actual Recovery Branches explains unavailable USD goodwill for ' + currency + ' and retains nonmonetary review', async t => {
    const snapshot = source(currency), originalBytes = JSON.stringify(snapshot);
    const h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot));
    const section = h.win.document.querySelector<HTMLElement>('[data-widget="recovery-branches"]');
    assert(section);
    const copy = section.textContent ?? '';
    assert.match(copy, new RegExp('USD goodwill unavailable for ' + currency));
    assert.doesNotMatch(copy, /Within cap/);
    assert.doesNotMatch(copy, /[€£]\s*300(?:[.,]00)?/);
    assert.match(section.querySelector('.budget-chip')?.textContent ?? '', /USD/);
    assert.match(section.querySelector('.budget-chip')?.textContent ?? '', /\$300\.00/);
    for (const total of section.querySelectorAll('.branch-amount')) {
      assert.match(total.textContent ?? '', /USD/);
      assert.doesNotMatch(total.textContent ?? '', /[€£]/);
    }
    const review = section.querySelector<HTMLButtonElement>('.branch-options > button');
    assert(review, 'Nonmonetary tracking/dispute proposals remain reviewable');
    assert.equal(review.disabled, false);
    await press(h, review);
    assert.equal(h.branchReviews.length, 1);
    const [branchId, scope] = h.branchReviews[0];
    assert.equal(branchId, 'targeted');
    assert.deepEqual(scope?.orderIds, snapshot.orders.map(order => order.id));
    assert.equal(scope?.snapshotHash, snapshot.hash);
    assert(snapshot.branches.every(branch => branch.actions.every(action => action.kind !== 'refund')));
    assert(snapshot.branches.some(branch => branch.actions.some(action => action.kind === 'tracking')));
    await press(h, button(h, '[data-widget="recovery-branches"] button', 'Show exact data table'));
    const table = section.querySelector('table');
    assert(table);
    assert.match(table.querySelector('caption')?.textContent ?? '', /USD minor units/);
    const headers = [...table.querySelectorAll('thead th')].map(node => node.textContent);
    const withinCap = headers.indexOf('Within cap'), policyCurrency = headers.indexOf('Policy currency'), reportCurrency = headers.indexOf('Report denomination');
    assert(withinCap >= 0 && policyCurrency >= 0 && reportCurrency >= 0);
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.querySelectorAll('td')].map(node => node.textContent);
      assert.equal(cells[withinCap], 'Not applicable');
      assert.equal(cells[policyCurrency], 'USD');
      assert.equal(cells[reportCurrency], currency);
    }
    const state = structuredClone(h.api.getState());
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.networkAttempts, []);
    await h.destroy();
    const printed = (await nativePrint(snapshot, state, times.now)).widgets.find(widget => widget.widgetId === 'branches');
    assert(printed?.instrument);
    assert.equal(printed.status, 'exact', printed.reason);
    assert.equal(printed.instrument.unit, 'USD minor units');
    assert(printed.instrument.branches?.every(branch => branch.actions.every(action => action.kind !== 'refund')));
    assert(printed.instrument.branches?.every(branch => branch.currency === 'USD'));
    assert.equal(JSON.stringify(snapshot), originalBytes, 'Presentation and print cannot rewrite the admitted source snapshot');
  });
}

test('actual USD Recovery Branches retains the $300 USD cap, $5 policy and exact review scope', async t => {
  const snapshot = source(), originalBytes = JSON.stringify(snapshot);
  const h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot));
  const section = h.win.document.querySelector<HTMLElement>('[data-widget="recovery-branches"]');
  assert(section);
  assert.match(section.querySelector('.budget-chip')?.textContent ?? '', /\$300\.00/);
  assert.match(section.querySelector('.budget-chip')?.textContent ?? '', /USD/);
  assert.match(section.querySelector('.policy-line')?.textContent ?? '', /\$5/);
  assert.doesNotMatch(section.textContent ?? '', /USD goodwill unavailable/);
  assert.match(section.textContent ?? '', /Within cap/);
  const review = section.querySelector<HTMLButtonElement>('.branch-options > button');
  assert(review);
  assert.equal(review.disabled, false);
  await press(h, review);
  assert.equal(h.branchReviews.length, 1);
  assert.deepEqual(h.branchReviews[0], ['targeted', {orderIds: snapshot.orders.map(order => order.id), budgetMinor: 30000, snapshotHash: snapshot.hash}]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.networkAttempts, []);
  await h.destroy();
  assert.equal(JSON.stringify(snapshot), originalBytes);
});

test('actual Time Dial and saved native labels distinguish clock scope, full native scope and per-group values', async t => {
  const snapshot = source(), h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot, {river: {crossFilter: 'filter'}, map: {crossFilter: 'filter'}}));
  await delayed(h);
  await h.until(() => h.counts.get('map')?.selected === 2, 'The actual delayed selection must narrow peer data');
  const map = [...h.win.document.querySelectorAll<HTMLButtonElement>('.region-rows > button')].find(node => node.textContent?.includes('Pacific Northwest'));
  assert(map);
  await press(h, map);
  await h.until(() => h.counts.get('river')?.count === 3 && h.counts.get('river')?.selected === 1 && h.counts.get('map')?.count === 2 && h.counts.get('map')?.selected === 1, 'Actual controls must settle before reading scope labels');
  assert.deepEqual(h.counts.get('dial'), {count: 6, selected: 6}, 'The installed Time Dial query intentionally ignores shared selections');
  const dialNotes = h.win.document.querySelector('[data-widget="time-dial"] .instrument-notes')?.textContent ?? '';
  assert.match(dialNotes, /6 orders in clock scope/);
  assert.match(dialNotes, /Shared selections do not filter the clock/);
  assert.doesNotMatch(dialNotes, /6 in shared selection/);
  const state = structuredClone(h.api.getState()), captured = await nativePrint(snapshot, state, times.now), originalPrintBytes = JSON.stringify(captured);
  for (const [id, expected] of [
    ['river', /^3 orders in original native scope · 1 orders? in shared selection$/],
    ['map', /^2 orders in original native scope · 1 orders? in shared selection$/],
    ['dial', /^6 orders in clock scope\. Shared selections do not filter the clock\.$/],
  ] as const) {
    const widget = captured.widgets.find(widget => widget.widgetId === id);
    assert(widget?.instrument);
    const copy = JSDOM.fragment(renderToStaticMarkup(createElement(ReportNativeScope, {widget}))).textContent ?? '';
    assert.match(copy, expected, id + ': full instrument scope must remain explicit above its groups and selected rows');
    // Older saved native models have these correct counts but no new label.
    // Their reader may clarify the scope without rewriting the saved model.
    const olderWidget = structuredClone(widget);
    delete olderWidget.instrument!.scopeLabel;
    const olderBytes = JSON.stringify(olderWidget);
    assert.match(JSDOM.fragment(renderToStaticMarkup(createElement(ReportNativeScope, {widget: olderWidget}))).textContent ?? '', expected);
    assert.equal(JSON.stringify(olderWidget), olderBytes);
  }
  const river = captured.widgets.find(widget => widget.widgetId === 'river')!;
  assert.equal(river.instrument?.groups.find(group => group.label === 'delayed')?.value, 1);
  const groups = JSDOM.fragment(renderToStaticMarkup(createElement(ReportNativeChart, {widget: river}))).textContent ?? '';
  assert.match(groups, /delayed.*1.*1 original/, 'A group can correctly show 1/1 while its full native scope remains 3/1');
  assert.equal(JSON.stringify(captured), originalPrintBytes, 'Reader labels cannot rewrite immutable native print results');
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.networkAttempts, []);
  await h.destroy();
});

test('actual Time Dial ignores a previously saved Filter setting and static capture matches its full clock scope', async t => {
  const snapshot = source();
  const h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot, {dial: {crossFilter: 'filter'}}));
  await delayed(h);
  await h.until(() => h.counts.get('map')?.selected === 2, 'The actual River control must establish a peer selection');
  assert.deepEqual(h.counts.get('dial'), {count: 6, selected: 6});
  const state = structuredClone(h.api.getState()), widget = state.pages[0].widgets!.dial as InstrumentData;
  assert(widget.format);
  assert.equal(widget.format.crossFilter, 'filter', 'The regression retains the previously serialized setting');
  const notes = h.win.document.querySelector('[data-widget="time-dial"] .instrument-notes')?.textContent ?? '';
  assert.match(notes, /6 orders in clock scope/);
  assert.match(notes, /Shared selections do not filter the clock/);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.networkAttempts, []);
  await h.destroy();
  const printed = (await nativePrint(snapshot, state, times.now)).widgets.find(widget => widget.widgetId === 'dial');
  assert(printed?.instrument);
  assert.equal(printed.status, 'exact', printed.reason);
  assert.equal(printed.instrument.scope, 6, 'A saved Filter setting cannot narrow the printed clock when the actual Time Dial remains at six orders');
  assert.equal(printed.instrument.selected, 6);
  assert.equal(printed.instrument.highlighted, false);
  assert.deepEqual(printed.rows.map(row => row.Orders), [6]);
});
